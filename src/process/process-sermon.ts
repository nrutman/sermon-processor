import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { analyzeNoiseFloor, selectRoomToneInterval } from "../audio/analyze.js";
import { measureLoudness, verifyOutputLoudness } from "../audio/loudness.js";
import { detectSpeechSegments, removeHandlingNoise } from "../audio/handling-noise.js";
import { verifyMp3Metadata } from "../audio/metadata.js";
import { probeAiff } from "../audio/probe.js";
import {
  createPremaster,
  captureNoiseProfile,
  decodeToCanonicalWav,
  encodeMp3,
  normalizePremaster,
  repairAndDenoise,
} from "../audio/render.js";
import { inspectAudioRuntime } from "../audio/runtime.js";
import {
  assertAiffPath,
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

const mp3CodecTruePeakHeadroomDb = 2.5;
const normalizedPcmTruePeakToleranceDb = 0.6;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function processSermon(
  rawRequest: ProcessRequest,
  runner: CommandRunner = new ExecaCommandRunner(),
): Promise<ProcessResult> {
  const request = processRequestSchema.parse(rawRequest);
  assertAiffPath(request.input);
  assertArtworkPath(request.artwork);
  if (!request.overwrite && (await pathExists(request.output))) {
    throw new Error(`Output already exists: ${request.output}`);
  }
  await mkdir(dirname(request.output), { recursive: true });

  const runtime = await inspectAudioRuntime(runner);
  const inputProbe = await probeAiff(request.input, runtime, runner);
  const workDirectory = join(
    tmpdir(),
    `sermon-${basename(request.input, ".aiff")}-${randomUUID()}`,
  );
  await mkdir(workDirectory, { recursive: true });
  const canonicalPath = join(workDirectory, "01-canonical.wav");
  const denoisedPath = join(workDirectory, "02-denoised.wav");
  const handlingCleanPath = join(workDirectory, "03-handling-clean.wav");
  const premasterPath = join(workDirectory, "04-premaster.wav");
  const normalizedPath = join(workDirectory, "05-normalized.wav");
  const encodedPath = join(workDirectory, "06-output.mp3");
  let completed = false;

  try {
    await decodeToCanonicalWav(request.input, canonicalPath, runtime, runner);
    const noiseBeforeDenoising = await analyzeNoiseFloor(
      canonicalPath,
      inputProbe.durationSeconds,
      runtime,
      runner,
    );
    const speechSegments = await detectSpeechSegments(
      canonicalPath,
      join(workDirectory, "speech.vad.f32"),
      runtime,
      runner,
    );
    const roomToneInterval = selectRoomToneInterval(noiseBeforeDenoising, speechSegments);
    const noiseProfile =
      roomToneInterval === undefined
        ? undefined
        : await captureNoiseProfile(
            canonicalPath,
            roomToneInterval,
            noiseBeforeDenoising.noiseFloorDb,
            runtime,
            runner,
          );
    await repairAndDenoise(
      canonicalPath,
      denoisedPath,
      noiseBeforeDenoising.noiseFloorDb,
      noiseProfile,
      request.processing,
      runtime,
      runner,
    );
    const noiseAfterDenoising = await analyzeNoiseFloor(
      denoisedPath,
      inputProbe.durationSeconds,
      runtime,
      runner,
    );

    const handlingNoise: QcReport["handlingNoise"] = await removeHandlingNoise(
      canonicalPath,
      denoisedPath,
      handlingCleanPath,
      inputProbe.durationSeconds,
      noiseBeforeDenoising.silenceThresholdDb,
      request.processing.handlingNoise,
      speechSegments,
      runtime,
      runner,
    );

    await createPremaster(
      handlingCleanPath,
      premasterPath,
      noiseAfterDenoising.pauseThresholdDb,
      request.processing,
      runtime,
      runner,
    );
    const normalizationTruePeakTargetDbtp =
      request.processing.truePeakDbtp - mp3CodecTruePeakHeadroomDb;
    const loudnessBeforeNormalization = await measureLoudness(
      premasterPath,
      {
        lufs: request.processing.targetLufs,
        lra: request.processing.targetLra,
        truePeak: normalizationTruePeakTargetDbtp,
      },
      runtime,
      runner,
    );
    const metadata = buildMp3Metadata(request.metadata);
    await normalizePremaster(
      premasterPath,
      normalizedPath,
      loudnessBeforeNormalization,
      request.processing,
      normalizationTruePeakTargetDbtp,
      runtime,
      runner,
    );
    const normalizedLoudness = await measureLoudness(
      normalizedPath,
      {
        lufs: request.processing.targetLufs,
        lra: request.processing.targetLra,
        truePeak: normalizationTruePeakTargetDbtp,
      },
      runtime,
      runner,
    );
    verifyOutputLoudness(
      normalizedLoudness,
      {
        lufs: request.processing.targetLufs,
        truePeak: normalizationTruePeakTargetDbtp,
      },
      normalizedPcmTruePeakToleranceDb,
    );
    await encodeMp3(normalizedPath, encodedPath, request.artwork, metadata, runtime, runner);
    const outputLoudness = await measureLoudness(
      encodedPath,
      {
        lufs: request.processing.targetLufs,
        lra: request.processing.targetLra,
        truePeak: request.processing.truePeakDbtp,
      },
      runtime,
      runner,
    );
    verifyOutputLoudness(outputLoudness, {
      lufs: request.processing.targetLufs,
      truePeak: request.processing.truePeakDbtp,
    });
    const outputTechnical = await verifyMp3Metadata(
      encodedPath,
      metadata,
      request.artwork,
      runtime,
      runner,
    );
    await rename(encodedPath, request.output);

    const qcReportPath = join(request.qcDirectory, `${basename(request.output)}.qc.json`);
    const report: QcReport = {
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      input: { path: request.input, ...inputProbe },
      output: { path: request.output, ...outputTechnical },
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
        beforeNormalization: loudnessBeforeNormalization,
        normalizedPcm: normalizedLoudness,
        normalizationTruePeakTargetDbtp,
        output: outputLoudness,
      },
      handlingNoise,
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
