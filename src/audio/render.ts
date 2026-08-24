import type { AudioRuntime } from "./runtime.js";
import type { CommandRunner } from "../process/run-command.js";
import type { ProcessingOptions } from "../config/schema.js";
import type { Mp3Metadata } from "../metadata/sermon-metadata.js";
import type { LoudnessMeasurement } from "./loudness.js";
import type { RoomToneInterval } from "./analyze.js";

export function parseNoiseProfile(output: string): number[] {
  const values = output
    .match(/\bbn=([\d.eE+\- ]+)/)?.[1]
    ?.trim()
    .split(/\s+/)
    .map(Number);
  if (
    values === undefined ||
    values.length !== 15 ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("FFmpeg did not return a valid 15-band room-tone profile");
  }
  return values;
}

export async function captureNoiseProfile(
  input: string,
  interval: RoomToneInterval,
  noiseFloorDb: number,
  runtime: AudioRuntime,
  runner: CommandRunner,
): Promise<number[]> {
  const stopSamplingSeconds = Math.max(0.05, interval.durationSeconds - 0.05);
  const afftdnNoiseFloorDb = Math.min(-20, Math.max(-80, noiseFloorDb));
  const result = await runner.run(runtime.ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-ss",
    interval.startSeconds.toFixed(3),
    "-t",
    interval.durationSeconds.toFixed(3),
    "-i",
    input,
    "-af",
    `asendcmd=c='0 afftdn sn start;${stopSamplingSeconds.toFixed(3)} afftdn sn stop',afftdn=nf=${afftdnNoiseFloorDb.toFixed(1)}`,
    "-f",
    "null",
    "-",
  ]);
  return parseNoiseProfile(result.stderr);
}

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
  noiseProfile: number[] | undefined,
  options: ProcessingOptions,
  runtime: AudioRuntime,
  runner: CommandRunner,
): Promise<void> {
  const afftdnNoiseFloorDb = Math.min(-20, Math.max(-80, noiseFloorDb));
  const denoiser = noiseProfile
    ? `afftdn=nr=${options.noiseReductionDb}:nf=${afftdnNoiseFloorDb.toFixed(1)}:nt=c:bn=${noiseProfile.join("|")}:tn=0:gs=4`
    : `afftdn=nr=${options.noiseReductionDb}:nf=${afftdnNoiseFloorDb.toFixed(1)}:tn=1:gs=4`;
  const filter = [
    `highpass=f=${options.highpassHz}`,
    "adeclick=w=55:o=75:a=2:t=2:b=2",
    denoiser,
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
      "silenceremove=start_periods=1",
      `start_duration=${options.leadingSpeechConfirmationSeconds}`,
      `start_threshold=${silenceThresholdDb.toFixed(1)}dB`,
      `start_silence=${options.retainedSilenceSeconds}`,
      "start_mode=all",
      "stop_periods=-1",
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
  artwork: string,
  metadata: Mp3Metadata,
  runtime: AudioRuntime,
  runner: CommandRunner,
): Promise<void> {
  await runner.run(runtime.ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    input,
    "-i",
    artwork,
    "-map",
    "0:a:0",
    "-map",
    "1:v:0",
    "-map_metadata",
    "-1",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "64k",
    "-ac",
    "1",
    "-c:v",
    "copy",
    "-disposition:v",
    "attached_pic",
    "-metadata:s:v",
    "title=Album cover",
    "-metadata:s:v",
    "comment=Cover (front)",
    "-id3v2_version",
    "3",
    ...metadataArguments(metadata),
    output,
  ]);
}

export async function normalizePremaster(
  input: string,
  output: string,
  loudness: LoudnessMeasurement,
  options: ProcessingOptions,
  truePeakDbtp: number,
  runtime: AudioRuntime,
  runner: CommandRunner,
): Promise<void> {
  const loudnorm = [
    `loudnorm=I=${options.targetLufs}`,
    `LRA=${options.targetLra}`,
    `TP=${truePeakDbtp}`,
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
    "-c:a",
    "pcm_s24le",
    "-ac",
    "1",
    output,
  ]);
}
