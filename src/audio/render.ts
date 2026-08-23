import type { AudioRuntime } from "./runtime.js";
import type { CommandRunner } from "../process/run-command.js";
import type { ProcessingOptions } from "../config/schema.js";
import type { Mp3Metadata } from "../metadata/sermon-metadata.js";
import type { LoudnessMeasurement } from "./loudness.js";

export async function decodeToCanonicalWav(
  input: string,
  output: string,
  runtime: AudioRuntime,
  runner: CommandRunner,
): Promise<void> {
  await runner.run(runtime.ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    input,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-c:a",
    "pcm_s24le",
    output,
  ]);
}

export async function repairAndDenoise(
  input: string,
  output: string,
  noiseFloorDb: number,
  options: ProcessingOptions,
  runtime: AudioRuntime,
  runner: CommandRunner,
): Promise<void> {
  const afftdnNoiseFloorDb = Math.min(-20, Math.max(-80, noiseFloorDb));
  const filter = [
    `highpass=f=${options.highpassHz}`,
    "adeclick=w=55:o=75:a=2:t=2:b=2",
    `afftdn=nr=${options.noiseReductionDb}:nf=${afftdnNoiseFloorDb.toFixed(1)}:tn=1:gs=4`,
  ].join(",");
  await runner.run(runtime.ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    input,
    "-af",
    filter,
    "-c:a",
    "pcm_s24le",
    output,
  ]);
}

export async function createPremaster(
  input: string,
  output: string,
  silenceThresholdDb: number,
  options: ProcessingOptions,
  runtime: AudioRuntime,
  runner: CommandRunner,
): Promise<void> {
  const filter = [
    [
      "silenceremove=stop_periods=-1",
      `stop_duration=${options.silenceMinimumSeconds}`,
      `stop_threshold=${silenceThresholdDb.toFixed(1)}dB`,
      `stop_silence=${options.retainedSilenceSeconds}`,
      "stop_mode=all",
    ].join(":"),
    "dynaudnorm=f=500:g=31:p=0.95:m=10:r=0.1:b=1",
    "acompressor=threshold=-20dB:ratio=3:attack=20:release=250:makeup=2dB:knee=2.828",
  ].join(",");
  await runner.run(runtime.ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    input,
    "-af",
    filter,
    "-c:a",
    "pcm_s24le",
    output,
  ]);
}

function metadataArguments(metadata: Mp3Metadata): string[] {
  return [
    "-metadata",
    `artist=${metadata.artist}`,
    "-metadata",
    `album=${metadata.album}`,
    "-metadata",
    `album_artist=${metadata.albumArtist}`,
    "-metadata",
    `genre=${metadata.genre}`,
    "-metadata",
    `title=${metadata.title}`,
    "-metadata",
    `date=${metadata.date}`,
    "-metadata",
    `comment=${metadata.comment}`,
  ];
}

export async function encodeMp3(
  input: string,
  output: string,
  metadata: Mp3Metadata,
  loudness: LoudnessMeasurement,
  options: ProcessingOptions,
  runtime: AudioRuntime,
  runner: CommandRunner,
): Promise<void> {
  const loudnorm = [
    `loudnorm=I=${options.targetLufs}`,
    `LRA=${options.targetLra}`,
    `TP=${options.truePeakDbtp}`,
    `measured_I=${loudness.inputI}`,
    `measured_LRA=${loudness.inputLra}`,
    `measured_TP=${loudness.inputTp}`,
    `measured_thresh=${loudness.inputThreshold}`,
    `offset=${loudness.targetOffset}`,
    "linear=true",
    "print_format=summary",
  ].join(":");

  await runner.run(runtime.ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    input,
    "-af",
    `${loudnorm},aresample=44100`,
    "-map_metadata",
    "-1",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "64k",
    "-ac",
    "1",
    "-id3v2_version",
    "3",
    ...metadataArguments(metadata),
    output,
  ]);
}
