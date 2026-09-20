import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { analyzeNoiseFloor, selectRoomToneInterval } from "../audio/analyze.js";
import { measureLoudness, verifyOutputLoudness } from "../audio/loudness.js";
import { detectSpeechSegments, removeHandlingNoise } from "../audio/handling-noise.js";
import { verifyMp3Metadata } from "../audio/metadata.js";
import { probeAudioInput } from "../audio/probe.js";
import {
  createPremaster,
  captureNoiseProfile,
  decodeToCanonicalWav,
  encodeMp3,
  normalizePremaster,
  repairAndDenoise,
} from "../audio/render.js";
import { inspectAudioRuntime } from "../audio/runtime.js";
import { transcribeAndShortenGaps } from "../audio/transcription.js";
import {
  assertAudioInputPath,
  assertArtworkPath,
  processRequestSchema,
  type ProcessRequest,
} from "../config/schema.js";
import { buildMp3Metadata } from "../metadata/sermon-metadata.js";
import type { QcReport } from "../report/qc-report.js";
import { ExecaCommandRunner, type CommandRunner } from "./run-command.js";

export interface ProcessResult {
  outputPath: string;
  qcReportPath: string;
  workDirectory?: string;
}

export interface ProcessingProgress {
  durationSeconds?: number;
  message?: string;
  stage: string;
  status: "completed" | "failed" | "started";
}

export type ProcessingProgressReporter = (progress: ProcessingProgress) => void;

const mp3CodecTruePeakHeadroomDb = 2.8;
const mp3CodecRetrySafetyMarginDb = 0.2;
const maximumEncodingAttempts = 3;
const normalizedPcmTruePeakToleranceDb = 0.6;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function withAdaptiveCodecHeadroom<
  Result extends { outputLoudnessLufs: number; outputTruePeakDbtp: number },
>(
  renderAttempt: (codecHeadroomDb: number, attempt: number) => Promise<Result>,
  minimumOutputLufs: number,
  outputTruePeakTargetDbtp: number,
  reportProgress: ProcessingProgressReporter,
  options: {
    initialHeadroomDb?: number;
    maximumAttempts?: number;
    retrySafetyMarginDb?: number;
  } = {},
): Promise<{ attempts: number; result: Result }> {
  let codecHeadroomDb = options.initialHeadroomDb ?? mp3CodecTruePeakHeadroomDb;
  const maximumAttempts = options.maximumAttempts ?? maximumEncodingAttempts;
  const retrySafetyMarginDb = options.retrySafetyMarginDb ?? mp3CodecRetrySafetyMarginDb;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    // Each attempt derives its extra headroom from the preceding encoded MP3 measurement.
    // eslint-disable-next-line no-await-in-loop
    const result = await renderAttempt(codecHeadroomDb, attempt);
    const truePeakOvershootDb = result.outputTruePeakDbtp - outputTruePeakTargetDbtp;
    if (truePeakOvershootDb <= 0 || attempt === maximumAttempts) {
      return { attempts: attempt, result };
    }
    const additionalHeadroomDb = truePeakOvershootDb + retrySafetyMarginDb;
    if (result.outputLoudnessLufs - additionalHeadroomDb < minimumOutputLufs) {
      reportProgress({
        stage: "Skip final retry",
        status: "completed",
        message: `The ${additionalHeadroomDb.toFixed(2)} dB peak correction would exceed the loudness contract`,
      });
      return { attempts: attempt, result };
    }
    codecHeadroomDb += additionalHeadroomDb;
    reportProgress({
      stage: "Retry final encode",
      status: "completed",
      message: `MP3 true peak exceeded the target by ${truePeakOvershootDb.toFixed(2)} dB; retrying from the premaster with ${codecHeadroomDb.toFixed(2)} dB headroom`,
    });
  }
  throw new Error("MP3 encoding exhausted its retry limit");
}

export async function processSermon(
  rawRequest: ProcessRequest,
  runner: CommandRunner = new ExecaCommandRunner(),
  reportProgress: ProcessingProgressReporter = () => undefined,
): Promise<ProcessResult> {
  const processingStartedAt = performance.now();
  const stageTimings: QcReport["processing"]["stages"] = [];
  const runStage = async <Result>(
    stage: string,
    action: () => Promise<Result>,
    message?: string,
  ): Promise<Result> => {
    reportProgress({ stage, status: "started", ...(message ? { message } : {}) });
    const startedAt = performance.now();
    try {
      const result = await action();
      const durationSeconds = (performance.now() - startedAt) / 1_000;
      stageTimings.push({ stage, durationSeconds });
      reportProgress({ stage, status: "completed", durationSeconds });
      return result;
    } catch (error) {
      const durationSeconds = (performance.now() - startedAt) / 1_000;
      stageTimings.push({ stage, durationSeconds });
      reportProgress({
        stage,
        status: "failed",
        durationSeconds,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  const request = processRequestSchema.parse(rawRequest);
  assertAudioInputPath(request.input);
  assertArtworkPath(request.artwork);
  if (!request.overwrite && (await pathExists(request.output))) {
    throw new Error(`Output already exists: ${request.output}`);
  }
  await mkdir(dirname(request.output), { recursive: true });

  const runtime = await runStage("Inspect audio tools", () => inspectAudioRuntime(runner));
  const inputProbe = await runStage("Probe input", () =>
    probeAudioInput(request.input, runtime, runner),
  );
  const workDirectory = join(
    tmpdir(),
    `sermon-${basename(request.input, extname(request.input))}-${randomUUID()}`,
  );
  await mkdir(workDirectory, { recursive: true });
  const canonicalPath = join(workDirectory, "01-canonical.wav");
  const denoisedPath = join(workDirectory, "02-denoised.wav");
  const handlingCleanPath = join(workDirectory, "03-handling-clean.wav");
  const transcriptCleanPath = join(workDirectory, "04-transcript-clean.wav");
  const premasterPath = join(workDirectory, "05-premaster.wav");
  const normalizedPath = join(workDirectory, "06-normalized.wav");
  const encodedPath = join(workDirectory, "07-output.mp3");
  let completed = false;

  try {
    await runStage("Decode canonical WAV", () =>
      decodeToCanonicalWav(request.input, canonicalPath, runtime, runner),
    );
    const [noiseBeforeDenoising, speechSegments] = await Promise.all([
      runStage("Analyze source noise", () =>
        analyzeNoiseFloor(canonicalPath, inputProbe.durationSeconds, runtime, runner),
      ),
      runStage("Detect speech", () =>
        detectSpeechSegments(canonicalPath, join(workDirectory, "speech.vad.f32"), runtime, runner),
      ),
    ]);
    const roomToneInterval = selectRoomToneInterval(noiseBeforeDenoising, speechSegments);
    const noiseProfile =
      roomToneInterval === undefined
        ? undefined
        : await runStage("Capture room-tone profile", () =>
            captureNoiseProfile(
              canonicalPath,
              roomToneInterval,
              noiseBeforeDenoising.noiseFloorDb,
              runtime,
              runner,
            ),
          );
    await runStage("Repair and denoise", () =>
      repairAndDenoise(
        canonicalPath,
        denoisedPath,
        noiseBeforeDenoising.noiseFloorDb,
        noiseProfile,
        request.processing,
        runtime,
        runner,
      ),
    );
    const [noiseAfterDenoising, handlingNoise]: [
      Awaited<ReturnType<typeof analyzeNoiseFloor>>,
      QcReport["handlingNoise"],
    ] = await Promise.all([
      runStage("Analyze denoised noise", () =>
        analyzeNoiseFloor(denoisedPath, inputProbe.durationSeconds, runtime, runner),
      ),
      runStage("Remove handling noise", () =>
        removeHandlingNoise(
          canonicalPath,
          denoisedPath,
          handlingCleanPath,
          inputProbe.durationSeconds,
          noiseBeforeDenoising.silenceThresholdDb,
          request.processing.handlingNoise,
          speechSegments,
          runtime,
          runner,
        ),
      ),
    ]);

    const transcription = await runStage("Transcribe and shorten non-speech gaps", () =>
      transcribeAndShortenGaps(
        canonicalPath,
        handlingCleanPath,
        transcriptCleanPath,
        join(workDirectory, "transcript"),
        inputProbe.durationSeconds,
        speechSegments,
        request.processing.transcription,
        runtime,
        runner,
      ),
    );

    await runStage("Create premaster", () =>
      createPremaster(
        transcriptCleanPath,
        premasterPath,
        noiseAfterDenoising.pauseThresholdDb,
        request.processing,
        runtime,
        runner,
      ),
    );
    const metadata = buildMp3Metadata(request.metadata);
    const encoded = await withAdaptiveCodecHeadroom(
      async (codecHeadroomDb, attempt) => {
        const attemptSuffix = attempt === 1 ? "" : ` (attempt ${attempt})`;
        const normalizationTruePeakTargetDbtp = request.processing.truePeakDbtp - codecHeadroomDb;
        const loudnessBeforeNormalization = await runStage(
          `Measure premaster${attemptSuffix}`,
          () =>
            measureLoudness(
              premasterPath,
              {
                lufs: request.processing.targetLufs,
                lra: request.processing.targetLra,
                truePeak: normalizationTruePeakTargetDbtp,
              },
              runtime,
              runner,
            ),
          `Codec headroom ${codecHeadroomDb.toFixed(2)} dB`,
        );
        await runStage(`Normalize PCM${attemptSuffix}`, () =>
          normalizePremaster(
            premasterPath,
            normalizedPath,
            loudnessBeforeNormalization,
            request.processing,
            normalizationTruePeakTargetDbtp,
            runtime,
            runner,
          ),
        );
        const normalizedLoudness = await runStage(`Verify normalized PCM${attemptSuffix}`, () =>
          measureLoudness(
            normalizedPath,
            {
              lufs: request.processing.targetLufs,
              lra: request.processing.targetLra,
              truePeak: normalizationTruePeakTargetDbtp,
            },
            runtime,
            runner,
          ),
        );
        verifyOutputLoudness(
          normalizedLoudness,
          {
            lufs: request.processing.targetLufs,
            truePeak: normalizationTruePeakTargetDbtp,
          },
          normalizedPcmTruePeakToleranceDb,
        );
        await runStage(`Encode MP3${attemptSuffix}`, () =>
          encodeMp3(normalizedPath, encodedPath, request.artwork, metadata, runtime, runner),
        );
        const outputLoudness = await runStage(`Measure MP3${attemptSuffix}`, () =>
          measureLoudness(
            encodedPath,
            {
              lufs: request.processing.targetLufs,
              lra: request.processing.targetLra,
              truePeak: request.processing.truePeakDbtp,
            },
            runtime,
            runner,
          ),
        );
        return {
          loudnessBeforeNormalization,
          normalizationTruePeakTargetDbtp,
          normalizedLoudness,
          outputLoudnessLufs: outputLoudness.inputI,
          outputLoudness,
          outputTruePeakDbtp: outputLoudness.inputTp,
        };
      },
      request.processing.targetLufs - 2,
      request.processing.truePeakDbtp,
      reportProgress,
    );
    verifyOutputLoudness(encoded.result.outputLoudness, {
      lufs: request.processing.targetLufs,
      truePeak: request.processing.truePeakDbtp,
    });
    const outputTechnical = await runStage("Verify MP3 metadata", () =>
      verifyMp3Metadata(encodedPath, metadata, request.artwork, runtime, runner),
    );
    await rename(encodedPath, request.output);

    const qcReportPath = join(request.qcDirectory, `${basename(request.output)}.qc.json`);
    const report: QcReport = {
      schemaVersion: 4,
      createdAt: new Date().toISOString(),
      input: { path: request.input, ...inputProbe },
      output: { path: request.output, ...outputTechnical },
      processing: {
        encodingAttempts: encoded.attempts,
        stages: stageTimings,
        totalDurationSeconds: (performance.now() - processingStartedAt) / 1_000,
      },
      metadata,
      runtime,
      noise: {
        beforeDenoising: noiseBeforeDenoising,
        afterDenoising: noiseAfterDenoising,
        ...(roomToneInterval !== undefined && noiseProfile !== undefined
          ? { profile: { interval: roomToneInterval, bandNoiseDb: noiseProfile } }
          : {}),
      },
      loudness: {
        beforeNormalization: encoded.result.loudnessBeforeNormalization,
        normalizedPcm: encoded.result.normalizedLoudness,
        normalizationTruePeakTargetDbtp: encoded.result.normalizationTruePeakTargetDbtp,
        output: encoded.result.outputLoudness,
      },
      handlingNoise,
      ...(transcription === undefined ? {} : { transcription }),
      warnings: [
        ...(noiseBeforeDenoising.usedFallback || noiseAfterDenoising.usedFallback
          ? [
              "No usable room-tone frames were found for one noise-floor measurement; the conservative fallback was used.",
            ]
          : []),
        ...(noiseProfile === undefined
          ? [
              "No verified speech-free room-tone interval was available; adaptive denoising was used.",
            ]
          : []),
      ],
    };
    await mkdir(request.qcDirectory, { recursive: true });
    await writeFile(qcReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    completed = true;
    return {
      outputPath: request.output,
      qcReportPath,
      ...(request.keepWorkFiles ? { workDirectory } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nWork files preserved: ${workDirectory}`, { cause: error });
  } finally {
    if (completed && !request.keepWorkFiles) {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }
}

export const processSermonInternals = { withAdaptiveCodecHeadroom };
