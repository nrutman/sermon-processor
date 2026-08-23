import { parseFile } from "music-metadata";
import type { Mp3Metadata } from "../metadata/sermon-metadata.js";
import type { AudioRuntime } from "./runtime.js";
import type { CommandRunner } from "../process/run-command.js";
import { z } from "zod";

const mp3ProbeSchema = z.object({
  streams: z
    .array(
      z.object({
        bit_rate: z.string().optional(),
        channels: z.number().optional(),
        codec_name: z.string().optional(),
        sample_rate: z.string().optional(),
      }),
    )
    .optional(),
  format: z
    .object({
      bit_rate: z.string().optional(),
      duration: z.string().optional(),
      tags: z.object({ comment: z.unknown().optional() }).optional(),
    })
    .optional(),
});

export interface VerifiedMp3Output {
  bitrateKbps: number;
  channels: number;
  codec: "mp3";
  durationSeconds: number;
  sampleRate: number;
}

export async function verifyMp3Metadata(
  path: string,
  expected: Mp3Metadata,
  runtime: AudioRuntime,
  runner: CommandRunner,
): Promise<VerifiedMp3Output> {
  const parsed = await parseFile(path);
  const actual = parsed.common;
  const mismatches: string[] = [];

  const checks: Array<[string, string | undefined, string]> = [
    ["artist", actual.artist, expected.artist],
    ["album", actual.album, expected.album],
    ["album artist", actual.albumartist, expected.albumArtist],
    ["genre", actual.genre?.[0], expected.genre],
    ["title", actual.title, expected.title],
    ["year", actual.year?.toString(), expected.date],
  ];
  for (const [field, value, expectedValue] of checks) {
    if (value !== expectedValue) {
      mismatches.push(
        `${field}: expected ${JSON.stringify(expectedValue)}, received ${JSON.stringify(value)}`,
      );
    }
  }
  const probe = await runner.run(runtime.ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name,channels,sample_rate,bit_rate:format=duration,bit_rate:format_tags=comment",
    "-of",
    "json",
    path,
  ]);
  const probeJson = mp3ProbeSchema.parse(JSON.parse(probe.stdout));
  if (probeJson.format?.tags?.comment !== expected.comment) {
    mismatches.push(
      `comment: expected ${JSON.stringify(expected.comment)}, received ${JSON.stringify(probeJson.format?.tags?.comment)}`,
    );
  }
  const stream = probeJson.streams?.[0];
  if (stream?.codec_name !== "mp3") {
    mismatches.push(`codec: expected "mp3", received ${JSON.stringify(stream?.codec_name)}`);
  }
  if (stream?.channels !== 1) {
    mismatches.push(`channels: expected 1, received ${String(stream?.channels)}`);
  }
  const bitrate = Number(stream?.bit_rate ?? probeJson.format?.bit_rate);
  if (!Number.isFinite(bitrate) || bitrate < 60_000 || bitrate > 68_000) {
    mismatches.push(`bitrate: expected approximately 64000, received ${String(bitrate)}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`MP3 metadata verification failed:\n${mismatches.join("\n")}`);
  }
  const durationSeconds = Number(probeJson.format?.duration);
  const sampleRate = Number(stream?.sample_rate);
  if (!Number.isFinite(durationSeconds) || !Number.isFinite(sampleRate)) {
    throw new Error("MP3 technical verification returned invalid duration or sample rate");
  }
  return {
    codec: "mp3",
    channels: 1,
    bitrateKbps: bitrate / 1_000,
    durationSeconds,
    sampleRate,
  };
}
