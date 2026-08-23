import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { analyzeNoiseFloor } from "../audio/analyze.js";
import { measureLoudness, verifyOutputLoudness } from "../audio/loudness.js";
import { removeHandlingNoise } from "../audio/handling-noise.js";
import { verifyMp3Metadata } from "../audio/metadata.js";
import { probeAiff } from "../audio/probe.js";
import {
  createPremaster,
  decodeToCanonicalWav,
  encodeMp3,
  repairAndDenoise,
} from "../audio/render.js";
import { inspectAudioRuntime } from "../audio/runtime.js";
import { assertAiffPath, processRequestSchema, type ProcessRequest } from "../config/schema.js";
import { buildMp3Metadata } from "../metadata/sermon-metadata.js";
import type { QcReport } from "../report/qc-report.js";
import { ExecaCommandRunner, type CommandRunner } from "./run-command.js";

export interface ProcessResult {
  outputPath: string;
  qcReportPath: string;
  workDirectory?: string;
}

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
  const encodedPath = join(workDirectory, "05-output.mp3");

  try {
    await decodeToCanonicalWav(request.input, canonicalPath, runtime, runner);
    const noise = await analyzeNoiseFloor(
      canonicalPath,
      inputProbe.durationSeconds,
      runtime,
      runner,
    );
    await repairAndDenoise(
      canonicalPath,
      denoisedPath,
      noise.noiseFloorDb,
      request.processing,
      runtime,
      runner,
    );

    const handlingNoise: QcReport["handlingNoise"] = await removeHandlingNoise(
      canonicalPath,
      denoisedPath,
      handlingCleanPath,
      inputProbe.durationSeconds,
      noise.silenceThresholdDb,
      request.processing.handlingNoise,
      runtime,
      runner,
    );

    await createPremaster(
      handlingCleanPath,
      premasterPath,
      noise.silenceThresholdDb,
      request.processing,
      runtime,
      runner,
    );
    const loudnessBeforeNormalization = await measureLoudness(
      premasterPath,
      {
        lufs: request.processing.targetLufs,
        lra: request.processing.targetLra,
        truePeak: request.processing.truePeakDbtp,
      },
      runtime,
      runner,
    );
    const metadata = buildMp3Metadata(request.metadata);
    await encodeMp3(
      premasterPath,
      encodedPath,
      metadata,
      loudnessBeforeNormalization,
      request.processing,
      runtime,
      runner,
    );
    const outputTechnical = await verifyMp3Metadata(encodedPath, metadata, runtime, runner);
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
    await rename(encodedPath, request.output);

    const qcReportPath = `${request.output}.qc.json`;
    const report: QcReport = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      input: { path: request.input, ...inputProbe },
      output: { path: request.output, ...outputTechnical },
      metadata,
      runtime,
      noise,
      loudness: {
        beforeNormalization: loudnessBeforeNormalization,
        output: outputLoudness,
      },
      handlingNoise,
      warnings: noise.usedFallback
        ? ["No usable room-tone frames were found; the noise floor used the conservative fallback."]
        : [],
    };
    await writeFile(qcReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    return {
      outputPath: request.output,
      qcReportPath,
      ...(request.keepWorkFiles ? { workDirectory } : {}),
    };
  } finally {
    if (!request.keepWorkFiles) {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }
}
