import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execa } from "execa";
import { z } from "zod";
import { processSermon } from "../../src/process/process-sermon.js";
import { processRequestSchema } from "../../src/config/schema.js";

async function hasFfmpeg(): Promise<boolean> {
  try {
    await execa("ffmpeg", ["-version"]);
    await execa("ffprobe", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

async function hasCommand(command: string): Promise<boolean> {
  try {
    await execa("which", [command]);
    return true;
  } catch {
    return false;
  }
}

const ffmpegAvailable = await hasFfmpeg();
const sayAvailable = process.platform === "darwin" && (await hasCommand("say"));
const espeakAvailable = await hasCommand("espeak");
const ttsAvailable = sayAvailable || espeakAvailable;

const qcReportSubsetSchema = z.object({
  handlingNoise: z.array(z.object({ action: z.string() })),
  loudness: z.object({ output: z.object({ inputI: z.number(), inputTp: z.number() }) }),
  metadata: z.object({ comment: z.string() }),
});

describe.skipIf(!ffmpegAvailable)("sermon processing integration", () => {
  let directory: string;
  let input: string;
  let output: string;
  let speechHandlingInput: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "sermon-integration-"));
    input = join(directory, "fixture.aiff");
    output = join(directory, "fixture.mp3");
    speechHandlingInput = join(directory, "speech-handling.aiff");
    const filter = [
      "sine=frequency=220:sample_rate=48000:duration=2[a]",
      "anullsrc=r=48000:channel_layout=mono:d=1.2[b]",
      "sine=frequency=330:sample_rate=48000:duration=1.5,volume=0.3[c]",
      "anullsrc=r=48000:channel_layout=mono:d=0.3[d]",
      "anoisesrc=r=48000:d=0.8:c=white:a=0.08[e]",
      "anullsrc=r=48000:channel_layout=mono:d=0.3[f]",
      "sine=frequency=220:sample_rate=48000:duration=2[g]",
      "[a][b][c][d][e][f][g]concat=n=7:v=0:a=1[out]",
    ].join(";");
    await execa("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-filter_complex",
      filter,
      "-map",
      "[out]",
      "-c:a",
      "pcm_s16be",
      input,
    ]);

    if (ttsAvailable) {
      const speechPath = join(directory, sayAvailable ? "speech.aiff" : "speech.wav");
      const words = "Blessed are the peacemakers, for they shall be called children of God.";
      if (sayAvailable) {
        await execa("say", ["-r", "150", "-o", speechPath, words]);
      } else {
        await execa("espeak", ["-s", "150", "-w", speechPath, words]);
      }
      await execa("ffmpeg", [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i",
        speechPath,
        "-filter_complex",
        [
          "[0:a]aresample=48000,asetpts=PTS-STARTPTS[a]",
          "anullsrc=r=48000:channel_layout=mono:d=0.5[b]",
          "anoisesrc=r=48000:d=0.8:c=white:a=0.08[c]",
          "anullsrc=r=48000:channel_layout=mono:d=0.5[d]",
          "[a][b][c][d]concat=n=4:v=0:a=1[out]",
        ].join(";"),
        "-map",
        "[out]",
        "-c:a",
        "pcm_s16be",
        speechHandlingInput,
      ]);
    }
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("creates and verifies a mastered MP3 with a handling-noise edit", async () => {
    const request = processRequestSchema.parse({
      input,
      output,
      metadata: {
        organization: "Example Organization",
        preacher: "Test Preacher",
        sermonSeries: "Test Series",
        date: "2026-08-23",
        scripture: "Matthew 7:7–12",
      },
    });

    const result = await processSermon(request);
    await expect(access(result.outputPath, constants.R_OK)).resolves.toBeUndefined();
    const report = qcReportSubsetSchema.parse(
      JSON.parse(await readFile(result.qcReportPath, "utf8")),
    );
    expect(report.handlingNoise).toContainEqual(expect.objectContaining({ action: "removed" }));
    expect(report.loudness.output.inputI).toBeGreaterThanOrEqual(-17);
    expect(report.loudness.output.inputI).toBeLessThanOrEqual(-15);
    expect(report.loudness.output.inputTp).toBeLessThanOrEqual(-1);
    expect(report.metadata.comment).toBe(
      "Example Organization. Sunday, August 23, 2026. Matthew 7:7–12.",
    );
  }, 30_000);

  it.skipIf(!ttsAvailable)(
    "does not let an earlier speech segment block a later handling-noise edit",
    async () => {
      const result = await processSermon(
        processRequestSchema.parse({
          input: speechHandlingInput,
          output: join(directory, "speech-handling.mp3"),
          metadata: {
            organization: "Example Organization",
            preacher: "Test Preacher",
            sermonSeries: "Test Series",
            date: "2026-08-23",
            scripture: "Matthew 5:9",
          },
        }),
      );
      const report = qcReportSubsetSchema
        .pick({ handlingNoise: true })
        .parse(JSON.parse(await readFile(result.qcReportPath, "utf8")));
      expect(report.handlingNoise).toContainEqual(expect.objectContaining({ action: "removed" }));
    },
    30_000,
  );
});
