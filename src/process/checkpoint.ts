import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { processRequestSchema } from "../config/schema.js";

const number = z.number().finite();
const interval = z.object({ startSeconds: number, endSeconds: number, durationSeconds: number });
const noise = z.object({
  noiseFloorDb: number,
  pauseThresholdDb: number,
  silenceThresholdDb: number,
  usedFallback: z.boolean(),
  silenceIntervals: z.array(interval),
  sampledIntervals: z.array(interval.extend({ rmsDb: number })),
});
export const preparationSchema = z.object({
  noiseBeforeDenoising: noise,
  noiseAfterDenoising: noise,
  roomToneInterval: interval.extend({ rmsDb: number }).optional(),
  noiseProfile: z.array(number).length(15).optional(),
  handlingNoise: z.array(
    interval.extend({
      action: z.enum(["removed", "reported"]),
      confidence: number,
      reason: z.string().optional(),
    }),
  ),
  transcription: z
    .object({
      language: z.string(),
      model: z.string(),
      toolVersion: z.string(),
      vadModel: z.string(),
      gaps: z.array(
        interval.extend({
          action: z.enum(["reported", "shortened"]),
          reason: z.string().optional(),
        }),
      ),
      words: z.array(
        z.object({
          startSeconds: number,
          endSeconds: number,
          confidence: number,
          text: z.string(),
        }),
      ),
    })
    .optional(),
});
export type Preparation = z.infer<typeof preparationSchema>;
const checkpointSchema = z.object({
  version: z.literal(1),
  request: processRequestSchema,
  workDirectory: z.string(),
  preparation: preparationSchema,
  sourceSha256: z.string(),
  artworkSha256: z.string(),
  premasterSha256: z.string(),
  elapsedSeconds: number,
  stages: z.array(z.object({ stage: z.string(), durationSeconds: number })),
});
export type ProcessingCheckpoint = z.infer<typeof checkpointSchema>;

/** Returns the SHA-256 digest of file bytes without loading the recording into memory. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Writes an encoding checkpoint with fingerprints of the source, artwork, and lossless premaster. */
export async function writeCheckpoint(
  checkpoint: Omit<
    ProcessingCheckpoint,
    "version" | "sourceSha256" | "artworkSha256" | "premasterSha256"
  >,
): Promise<string> {
  const [sourceSha256, artworkSha256, premasterSha256] = await Promise.all([
    hashFile(checkpoint.request.input),
    hashFile(checkpoint.request.artwork),
    hashFile(join(checkpoint.workDirectory, "05-premaster.wav")),
  ]);
  const path = join(checkpoint.workDirectory, "encoding-checkpoint.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify(
        { ...checkpoint, version: 1, sourceSha256, artworkSha256, premasterSha256 },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}

/** Loads a checkpoint and refuses changed source, artwork, or premaster bytes. */
export async function readCheckpoint(path: string): Promise<ProcessingCheckpoint> {
  const checkpoint = checkpointSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const [source, artwork, premaster] = await Promise.all([
    hashFile(checkpoint.request.input),
    hashFile(checkpoint.request.artwork),
    hashFile(join(checkpoint.workDirectory, "05-premaster.wav")),
  ]);
  if (
    source !== checkpoint.sourceSha256 ||
    artwork !== checkpoint.artworkSha256 ||
    premaster !== checkpoint.premasterSha256
  )
    throw new Error("Checkpoint inputs changed; refusing to resume");
  return checkpoint;
}
