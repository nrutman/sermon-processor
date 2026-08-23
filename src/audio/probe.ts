import { z } from "zod";
import type { AudioRuntime } from "./runtime.js";
import type { CommandRunner } from "../process/run-command.js";

const probeSchema = z.object({
  format: z.object({
    duration: z.coerce.number().positive(),
    format_name: z.string(),
  }),
  streams: z
    .array(
      z.object({
        codec_name: z.string(),
        codec_type: z.string(),
        channels: z.number().int().positive().optional(),
        sample_rate: z.coerce.number().int().positive().optional(),
      }),
    )
    .min(1),
});

export interface AudioProbe {
  channels: number;
  codec: string;
  durationSeconds: number;
  format: string;
  sampleRate: number;
}

export async function probeAiff(
  path: string,
  runtime: AudioRuntime,
  runner: CommandRunner,
): Promise<AudioProbe> {
  const result = await runner.run(runtime.ffprobePath, [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    path,
  ]);
  const parsed = probeSchema.parse(JSON.parse(result.stdout));
  const audio = parsed.streams.find((stream) => stream.codec_type === "audio");
  if (audio === undefined || audio.channels === undefined || audio.sample_rate === undefined) {
    throw new Error("Input does not contain a supported audio stream");
  }
  if (!parsed.format.format_name.split(",").includes("aiff")) {
    throw new Error(`Input is not an AIFF container: ${parsed.format.format_name}`);
  }

  return {
    channels: audio.channels,
    codec: audio.codec_name,
    durationSeconds: parsed.format.duration,
    format: parsed.format.format_name,
    sampleRate: audio.sample_rate,
  };
}
