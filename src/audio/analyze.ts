import type { AudioRuntime } from "./runtime.js";
import type { CommandRunner } from "../process/run-command.js";
import type { SpeechSegment } from "./handling-noise.js";

export interface SilenceInterval {
  durationSeconds: number;
  endSeconds: number;
  startSeconds: number;
}

export interface NoiseAnalysis {
  noiseFloorDb: number;
  pauseThresholdDb: number;
  sampledIntervals: Array<SilenceInterval & { rmsDb: number }>;
  silenceIntervals: SilenceInterval[];
  silenceThresholdDb: number;
  usedFallback: boolean;
}

export interface RoomToneInterval extends SilenceInterval {
  rmsDb: number;
}

export function selectRoomToneInterval(
  noise: NoiseAnalysis,
  speechSegments: SpeechSegment[],
): RoomToneInterval | undefined {
  const candidate = noise.sampledIntervals
    .filter((interval) => interval.durationSeconds >= 1)
    .filter(
      (interval) =>
        !speechSegments.some(
          (speech) =>
            Math.min(speech.endSeconds, interval.endSeconds) -
              Math.max(speech.startSeconds, interval.startSeconds) >
            0,
        ),
    )
    .toSorted(
      (left, right) => right.durationSeconds - left.durationSeconds || left.rmsDb - right.rmsDb,
    )[0];
  if (candidate === undefined) {
    return undefined;
  }
  const durationSeconds = Math.min(3, candidate.durationSeconds);
  const startSeconds = candidate.startSeconds + (candidate.durationSeconds - durationSeconds) / 2;
  return {
    startSeconds,
    endSeconds: startSeconds + durationSeconds,
    durationSeconds,
    rmsDb: candidate.rmsDb,
  };
}

function parseSilences(output: string, durationSeconds: number): SilenceInterval[] {
  const events = [...output.matchAll(/silence_(start|end):\s*([\d.]+)/g)];
  const intervals: SilenceInterval[] = [];
  let start: number | undefined;

  for (const event of events) {
    const value = Number(event[2]);
    if (!Number.isFinite(value)) {
      continue;
    }
    if (event[1] === "start") {
      start = value;
    } else if (start !== undefined && value > start) {
      intervals.push({
        startSeconds: start,
        endSeconds: value,
        durationSeconds: value - start,
      });
      start = undefined;
    }
  }

  if (start !== undefined && durationSeconds > start) {
    intervals.push({
      startSeconds: start,
      endSeconds: durationSeconds,
      durationSeconds: durationSeconds - start,
    });
  }
  return intervals;
}

function median(values: number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle];
  if (value === undefined) {
    throw new Error("Cannot calculate a median without values");
  }
  if (sorted.length % 2 === 1) {
    return value;
  }
  return (value + (sorted[middle - 1] ?? value)) / 2;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseFrameRms(output: string): number[] {
  return [...output.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf)/g)].flatMap(
    (match) => {
      const raw = match[1];
      if (raw === undefined || raw === "-inf") {
        return [];
      }
      const value = Number(raw);
      return Number.isFinite(value) && value > -90 && value <= 0 ? [value] : [];
    },
  );
}

async function estimateLowPercentileRms(
  input: string,
  runtime: AudioRuntime,
  runner: CommandRunner,
): Promise<{ noiseFloorDb: number; usedFallback: boolean }> {
  const result = await runner.run(runtime.ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-i",
    input,
    "-af",
    "aresample=8000,asetnsamples=n=800:p=1,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
    "-f",
    "null",
    "-",
  ]);
  const values = parseFrameRms(result.stderr).toSorted((left, right) => left - right);
  if (values.length < 5) {
    return { noiseFloorDb: -50, usedFallback: true };
  }
  const quietFrameCount = Math.max(5, Math.floor(values.length * 0.1));
  return {
    noiseFloorDb: median(values.slice(0, quietFrameCount)),
    usedFallback: false,
  };
}

async function measureIntervalRms(
  input: string,
  interval: SilenceInterval,
  runtime: AudioRuntime,
  runner: CommandRunner,
): Promise<number | undefined> {
  const sampleDuration = Math.min(2, interval.durationSeconds);
  const sampleStart = interval.startSeconds + (interval.durationSeconds - sampleDuration) / 2;
  const result = await runner.run(runtime.ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-ss",
    sampleStart.toFixed(3),
    "-t",
    sampleDuration.toFixed(3),
    "-i",
    input,
    "-af",
    "astats=metadata=0:reset=0",
    "-f",
    "null",
    "-",
  ]);
  const matches = [...result.stderr.matchAll(/RMS level dB:\s*(-?\d+(?:\.\d+)?|-inf)/g)];
  const last = matches.at(-1)?.[1];
  if (last === undefined || last === "-inf") {
    return undefined;
  }
  const value = Number(last);
  return Number.isFinite(value) ? value : undefined;
}

export async function analyzeNoiseFloor(
  input: string,
  durationSeconds: number,
  runtime: AudioRuntime,
  runner: CommandRunner,
): Promise<NoiseAnalysis> {
  const estimate = await estimateLowPercentileRms(input, runtime, runner);
  const preliminaryThresholdDb = clamp(estimate.noiseFloorDb + 6, -55, -25);
  const result = await runner.run(runtime.ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-i",
    input,
    "-af",
    `silencedetect=noise=${preliminaryThresholdDb.toFixed(1)}dB:duration=0.25`,
    "-f",
    "null",
    "-",
  ]);
  const silenceIntervals = parseSilences(result.stderr, durationSeconds);
  const candidates = silenceIntervals
    .filter((interval) => interval.durationSeconds >= 0.25)
    .toSorted((left, right) => right.durationSeconds - left.durationSeconds)
    .slice(0, 5);

  const measured = await Promise.all(
    candidates.map(async (interval) => ({
      startSeconds: interval.startSeconds,
      endSeconds: interval.endSeconds,
      durationSeconds: interval.durationSeconds,
      rmsDb: await measureIntervalRms(input, interval, runtime, runner),
    })),
  );
  const sampledIntervals = measured.flatMap((sample) =>
    sample.rmsDb === undefined || sample.rmsDb <= -90 ? [] : [{ ...sample, rmsDb: sample.rmsDb }],
  );
  const noiseFloorDb =
    sampledIntervals.length > 0
      ? median(sampledIntervals.map((sample) => sample.rmsDb))
      : estimate.noiseFloorDb;

  return {
    noiseFloorDb,
    pauseThresholdDb: clamp(noiseFloorDb + 12, -50, -25),
    sampledIntervals,
    silenceIntervals,
    silenceThresholdDb: clamp(noiseFloorDb + 6, -55, -25),
    usedFallback: estimate.usedFallback && sampledIntervals.length === 0,
  };
}

export const analysisInternals = { clamp, median, parseFrameRms, parseSilences };
