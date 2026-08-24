import { copyFile, readFile, rm } from "node:fs/promises";
import { RealTimeVAD } from "avr-vad";
import type { AudioRuntime } from "./runtime.js";
import type { CommandRunner } from "../process/run-command.js";
import type { ProcessingOptions } from "../config/schema.js";
import type { HandlingNoiseEvent } from "../report/qc-report.js";

const analysisSampleRate = 16_000;
const samplesPerFrame = 2_048;
const frameDurationSeconds = samplesPerFrame / analysisSampleRate;
const vadFrameSamples = 512;
const vadRedemptionFrames = 8;

export interface SpectralFrame {
  centroidHz: number;
  flatness: number;
  rmsDb: number;
  timeSeconds: number;
}

interface CandidateGroup {
  endFrame: number;
  frames: SpectralFrame[];
  startFrame: number;
}

export interface SpeechSegment {
  endSeconds: number;
  startSeconds: number;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function parseSpectralFrames(output: string): SpectralFrame[] {
  const frames: SpectralFrame[] = [];
  let current: Partial<SpectralFrame> | undefined;

  const commit = (): void => {
    if (
      current?.timeSeconds !== undefined &&
      current.rmsDb !== undefined &&
      current.centroidHz !== undefined &&
      current.flatness !== undefined
    ) {
      frames.push({
        timeSeconds: current.timeSeconds,
        rmsDb: current.rmsDb,
        centroidHz: current.centroidHz,
        flatness: current.flatness,
      });
    }
  };

  for (const line of output.split("\n")) {
    const frame = line.match(/frame:\d+\s+pts:\S+\s+pts_time:([\d.]+)/);
    if (frame?.[1] !== undefined) {
      commit();
      current = { timeSeconds: Number(frame[1]) };
      continue;
    }
    const rms = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf)/)?.[1];
    if (rms !== undefined && current !== undefined) {
      current.rmsDb = rms === "-inf" ? -120 : Number(rms);
      continue;
    }
    const centroid = line.match(/lavfi\.aspectralstats\.1\.centroid=([\deE+.-]+)/)?.[1];
    if (centroid !== undefined && current !== undefined) {
      current.centroidHz = Number(centroid);
      continue;
    }
    const flatness = line.match(/lavfi\.aspectralstats\.1\.flatness=([\deE+.-]+)/)?.[1];
    if (flatness !== undefined && current !== undefined) {
      current.flatness = Number(flatness);
    }
  }
  commit();
  return frames.filter((frame) =>
    [frame.timeSeconds, frame.rmsDb, frame.centroidHz, frame.flatness].every(Number.isFinite),
  );
}

async function extractSpectralFrames(
  input: string,
  runtime: AudioRuntime,
  runner: CommandRunner,
): Promise<SpectralFrame[]> {
  const filter = [
    `aresample=${analysisSampleRate}`,
    `asetnsamples=n=${samplesPerFrame}:p=1`,
    "astats=metadata=1:reset=1",
    `aspectralstats=win_size=${samplesPerFrame}:overlap=0:measure=centroid+flatness`,
    "ametadata=print",
  ].join(",");
  const result = await runner.run(runtime.ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-i",
    input,
    "-af",
    filter,
    "-f",
    "null",
    "-",
  ]);
  return parseSpectralFrames(result.stderr);
}

export async function detectSpeechSegments(
  input: string,
  rawAudioPath: string,
  runtime: AudioRuntime,
  runner: CommandRunner,
): Promise<SpeechSegment[]> {
  await runner.run(runtime.ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    input,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "f32le",
    rawAudioPath,
  ]);
  try {
    const audioBuffer = await readFile(rawAudioPath);
    const arrayBuffer = audioBuffer.buffer.slice(
      audioBuffer.byteOffset,
      audioBuffer.byteOffset + audioBuffer.byteLength,
    );
    const audio = new Float32Array(arrayBuffer);
    const segments: SpeechSegment[] = [];
    let processedSamples = 0;
    let flushing = false;
    const vad = await RealTimeVAD.new({
      model: "v5",
      sampleRate: 16_000,
      positiveSpeechThreshold: 0.95,
      negativeSpeechThreshold: 0.8,
      frameSamples: vadFrameSamples,
      redemptionFrames: vadRedemptionFrames,
      onFrameProcessed: (_probabilities, frame) => {
        processedSamples += frame.length;
      },
      onSpeechEnd: (speechAudio) => {
        const rawEndSeconds = processedSamples / 16_000;
        const redemptionSeconds = (vadFrameSamples * vadRedemptionFrames) / 16_000;
        const endSeconds = flushing
          ? rawEndSeconds
          : Math.max(0, rawEndSeconds - redemptionSeconds);
        segments.push({
          startSeconds: Math.max(0, rawEndSeconds - speechAudio.length / 16_000),
          endSeconds,
        });
      },
    });
    try {
      vad.start();
      await vad.processAudio(audio);
      flushing = true;
      await vad.flush();
      return segments;
    } finally {
      await vad.destroy();
    }
  } finally {
    await rm(rawAudioPath, { force: true });
  }
}

function groupCandidateFrames(
  frames: SpectralFrame[],
  silenceThresholdDb: number,
): CandidateGroup[] {
  const isNoiseLike = (frame: SpectralFrame): boolean =>
    frame.rmsDb >= silenceThresholdDb + 8 &&
    frame.rmsDb <= -3 &&
    frame.flatness >= 0.5 &&
    frame.centroidHz >= 1_800;

  const groups: CandidateGroup[] = [];
  let activeIndexes: number[] = [];
  let gapFrames = 0;
  const commit = (): void => {
    const startFrame = activeIndexes[0];
    const endFrame = activeIndexes.at(-1);
    if (startFrame !== undefined && endFrame !== undefined) {
      groups.push({
        startFrame,
        endFrame,
        frames: activeIndexes.map((index) => frames[index]).filter((frame) => frame !== undefined),
      });
    }
    activeIndexes = [];
    gapFrames = 0;
  };

  frames.forEach((frame, index) => {
    if (isNoiseLike(frame)) {
      activeIndexes.push(index);
      gapFrames = 0;
    } else if (activeIndexes.length > 0) {
      gapFrames += 1;
      if (gapFrames > 1) {
        commit();
      }
    }
  });
  commit();
  return groups;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function classifyHandlingNoise(
  frames: SpectralFrame[],
  silenceThresholdDb: number,
  options: ProcessingOptions["handlingNoise"],
  speechSegments: SpeechSegment[],
): HandlingNoiseEvent[] {
  const groups = groupCandidateFrames(frames, silenceThresholdDb);
  return groups.flatMap((group) => {
    const startSeconds = frames[group.startFrame]?.timeSeconds;
    const finalFrame = frames[group.endFrame];
    if (startSeconds === undefined || finalFrame === undefined || group.frames.length === 0) {
      return [];
    }
    const endSeconds = finalFrame.timeSeconds + frameDurationSeconds;
    const durationSeconds = endSeconds - startSeconds;
    if (
      durationSeconds < options.minimumDurationSeconds ||
      durationSeconds > options.maximumDurationSeconds
    ) {
      return [];
    }

    const boundaryFrames = [
      ...frames.slice(Math.max(0, group.startFrame - 2), group.startFrame),
      ...frames.slice(group.endFrame + 1, group.endFrame + 3),
    ];
    const quietBoundaryCount = boundaryFrames.filter(
      (frame) => frame.rmsDb <= silenceThresholdDb + 4,
    ).length;
    // A frame can straddle the burst boundary, so require three quiet frames
    // rather than allowing one mixed transition frame to veto an otherwise
    // well-bounded event.
    const hasQuietBoundaries = boundaryFrames.length >= 3 && quietBoundaryCount >= 3;
    const flatness = mean(group.frames.map((frame) => frame.flatness));
    const centroid = mean(group.frames.map((frame) => frame.centroidHz));
    const confidence = clamp(
      clamp((flatness - 0.45) / 0.4) * 0.45 +
        clamp((centroid - 1_800) / 3_000) * 0.25 +
        (hasQuietBoundaries ? 0.3 : 0),
    );
    const overlappingSpeech = speechSegments.find((segment) => {
      const overlapSeconds =
        Math.min(segment.endSeconds, endSeconds) - Math.max(segment.startSeconds, startSeconds);
      return overlapSeconds >= 0.1;
    });
    const overlapsSpeech = overlappingSpeech !== undefined;
    const removable =
      confidence >= options.minimumConfidence && hasQuietBoundaries && !overlapsSpeech;

    return [
      {
        startSeconds,
        endSeconds,
        durationSeconds,
        confidence,
        action: removable ? "removed" : "reported",
        ...(!removable
          ? {
              reason: overlapsSpeech
                ? `Silero VAD detected possible speech overlap (${overlappingSpeech.startSeconds.toFixed(3)}–${overlappingSpeech.endSeconds.toFixed(3)}s)`
                : "Candidate lacks quiet boundaries or sufficient confidence",
            }
          : {}),
      } satisfies HandlingNoiseEvent,
    ];
  });
}

function buildRemovalFilter(
  durationSeconds: number,
  events: HandlingNoiseEvent[],
  crossfadeSeconds: number,
): string | undefined {
  const cuts = events
    .filter((event) => event.action === "removed")
    .map((event) => ({
      start: event.startSeconds,
      end: event.endSeconds,
    }))
    .filter(
      (cut) => cut.end - cut.start > 0.1 && cut.start > 0.05 && cut.end < durationSeconds - 0.05,
    )
    .toSorted((left, right) => left.start - right.start);
  if (cuts.length === 0) {
    return undefined;
  }

  const segments: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor) {
      segments.push({ start: cursor, end: cut.start });
    }
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < durationSeconds) {
    segments.push({ start: cursor, end: durationSeconds });
  }
  if (segments.length < 2) {
    return undefined;
  }

  const trims = segments.map(
    (segment, index) =>
      `[0:a]atrim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},asetpts=PTS-STARTPTS[s${index}]`,
  );
  let previous = "s0";
  const joins: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const output = index === segments.length - 1 ? "out" : `x${index}`;
    joins.push(
      `[${previous}][s${index}]acrossfade=d=${crossfadeSeconds.toFixed(3)}:c1=tri:c2=tri[${output}]`,
    );
    previous = output;
  }
  return [...trims, ...joins].join(";");
}

export async function removeHandlingNoise(
  analysisInput: string,
  renderInput: string,
  output: string,
  durationSeconds: number,
  silenceThresholdDb: number,
  options: ProcessingOptions["handlingNoise"],
  speechSegments: SpeechSegment[],
  runtime: AudioRuntime,
  runner: CommandRunner,
): Promise<HandlingNoiseEvent[]> {
  if (!options.enabled) {
    await copyFile(renderInput, output);
    return [];
  }

  const frames = await extractSpectralFrames(analysisInput, runtime, runner);
  const events = classifyHandlingNoise(frames, silenceThresholdDb, options, speechSegments);
  const filter = buildRemovalFilter(durationSeconds, events, options.crossfadeSeconds);
  if (filter === undefined) {
    await copyFile(renderInput, output);
    return events;
  }
  await runner.run(runtime.ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    renderInput,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-c:a",
    "pcm_s24le",
    output,
  ]);
  return events;
}

export const handlingNoiseInternals = { buildRemovalFilter, groupCandidateFrames };
