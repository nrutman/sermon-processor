import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execa } from "execa";
import { z } from "zod";
import { processRequestSchema } from "../../config/schema.js";
import { processSermon, resumeSermon } from "../process-sermon.js";
import { captureNoiseProfile } from "../../audio/render.js";
import { inspectAudioRuntime } from "../../audio/runtime.js";
import { ExecaCommandRunner } from "../run-command.js";
import type { CommandRunner } from "../run-command.js";

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

function codecLossRunner(failAt?: "pcm" | "mp3" | "peak"): CommandRunner {
  const actual = new ExecaCommandRunner();
  let mp3Measurements = 0;
  return {
    async run(command, args) {
      const result = await actual.run(command, args);
      const stageInput = args[args.indexOf("-i") + 1];
      if (
        args.some((arg) => arg.startsWith("loudnorm=")) &&
        stageInput?.endsWith("07-output.mp3")
      ) {
        mp3Measurements++;
        if (mp3Measurements === 1)
          return {
            ...result,
            stderr: result.stderr
              .replace(/"input_i"\s*:\s*"[^"]+"/, '"input_i":"-18.17"')
              .replace(/"input_tp"\s*:\s*"[^"]+"/, '"input_tp":"-3.00"'),
          };
        if (failAt === "mp3")
          return {
            ...result,
            stderr: result.stderr.replace(/"input_i"\s*:\s*"[^"]+"/, '"input_i":"-25.00"'),
          };
        if (failAt === "peak" && mp3Measurements === 2)
          return {
            ...result,
            stderr: result.stderr
              .replace(/"input_i"\s*:\s*"[^"]+"/, '"input_i":"-17.80"')
              .replace(/"input_tp"\s*:\s*"[^"]+"/, '"input_tp":"-1.30"'),
          };
      }
      if (
        failAt === "pcm" &&
        args.some((arg) => arg.startsWith("loudnorm=")) &&
        stageInput?.endsWith("08-corrected.wav")
      )
        return {
          ...result,
          stderr: result.stderr.replace(/"input_i"\s*:\s*"[^"]+"/, '"input_i":"-25.00"'),
        };
      return result;
    },
  };
}

function pcmUndershootRunner(
  failCorrection: boolean | "margin" | "renormalization" = false,
): CommandRunner {
  const actual = new ExecaCommandRunner();
  return {
    async run(command, args) {
      const result = await actual.run(command, args);
      if (!args.some((arg) => arg.startsWith("loudnorm="))) return result;
      const inputPath = args[args.indexOf("-i") + 1];
      if (inputPath?.endsWith("06-normalized.wav"))
        return {
          ...result,
          stderr: result.stderr
            .replace(/"input_i"\s*:\s*"[^"]+"/, '"input_i":"-18.06"')
            .replace(
              /"input_tp"\s*:\s*"[^"]+"/,
              typeof failCorrection === "string" ? '"input_tp":"-4.40"' : '"input_tp":"-4.80"',
            ),
        };
      if (
        (failCorrection === true && inputPath?.endsWith("06-corrected.wav")) ||
        (failCorrection === "renormalization" && inputPath?.endsWith("06-renormalized.wav"))
      )
        return {
          ...result,
          stderr: result.stderr.replace(/"input_i"\s*:\s*"[^"]+"/, '"input_i":"-25.00"'),
        };
      return result;
    },
  };
}

const qcReportSubsetSchema = z.object({
  handlingNoise: z.array(z.object({ action: z.string() })),
  loudness: z.object({
    codecPreencodePeakLimitDbfs: z.number(),
    normalizedPcm: z.object({ inputI: z.number(), inputTp: z.number() }),
    normalizationTruePeakTargetDbtp: z.number(),
    output: z.object({ inputI: z.number(), inputTp: z.number() }),
  }),
  metadata: z.object({ comment: z.string() }),
  noise: z.object({
    afterDenoising: z.object({ pauseThresholdDb: z.number(), silenceThresholdDb: z.number() }),
    profile: z.object({ bandNoiseDb: z.array(z.number()).length(15) }),
  }),
  output: z.object({ artworkBytes: z.number().positive(), artworkMimeType: z.string() }),
  processing: z.object({
    encodingAttempts: z.number().int().positive(),
    stages: z.array(z.object({ durationSeconds: z.number().nonnegative(), stage: z.string() })),
    totalDurationSeconds: z.number().positive(),
  }),
  transcription: z
    .object({ gaps: z.array(z.object({ action: z.string() })), words: z.array(z.object({})) })
    .optional(),
});

describe.skipIf(!ffmpegAvailable)("sermon processing integration", () => {
  let directory: string;
  let artwork: string;
  let input: string;
  let output: string;
  let speechHandlingInput: string;

  it.each([1.09, 2.549, 3])(
    "captures all 15 noise bands from a %s-second sample",
    async (durationSeconds) => {
      const runner = new ExecaCommandRunner();
      const runtime = await inspectAudioRuntime(runner);
      const profile = await captureNoiseProfile(
        input,
        { startSeconds: 0, endSeconds: durationSeconds, durationSeconds, rmsDb: -50 },
        -50,
        runtime,
        runner,
      );
      expect(profile).toHaveLength(15);
      expect(profile.every(Number.isFinite)).toBe(true);
    },
  );

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "sermon-integration-"));
    artwork = join(directory, "artwork.png");
    input = join(directory, "fixture.wav");
    output = join(directory, "fixture.mp3");
    speechHandlingInput = join(directory, "speech-handling.aiff");
    await execa("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=32x32",
      "-frames:v",
      "1",
      artwork,
    ]);
    const filter = [
      "sine=frequency=220:sample_rate=48000:duration=2[a]",
      "anoisesrc=r=48000:d=2.5:c=pink:a=0.0003[b]",
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
      "pcm_s16le",
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
      artwork,
      input,
      output,
      qcDirectory: directory,
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
    expect(report.loudness.normalizationTruePeakTargetDbtp).toBe(-4.3);
    expect(report.loudness.codecPreencodePeakLimitDbfs).toBeCloseTo(-4.88, 2);
    expect(report.loudness.normalizedPcm.inputTp).toBeLessThanOrEqual(-3.4);
    expect(report.loudness.output.inputTp).toBeLessThanOrEqual(-1.5);
    expect(report.metadata.comment).toBe(
      "Example Organization. Sunday, August 23, 2026. Matthew 7:7–12.",
    );
    expect(report.output.artworkMimeType).toBe("image/png");
    expect(report.processing.encodingAttempts).toBe(1);
    expect(report.processing.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "Analyze source noise" }),
        expect.objectContaining({ stage: "Detect speech" }),
        expect.objectContaining({ stage: "Repair and denoise" }),
        expect.objectContaining({ stage: "Transcribe and shorten non-speech gaps" }),
      ]),
    );
    expect(report.noise.afterDenoising.pauseThresholdDb).toBeGreaterThan(
      report.noise.afterDenoising.silenceThresholdDb,
    );
  }, 30_000);

  it.skipIf(!ttsAvailable)(
    "does not let an earlier speech segment block a later handling-noise edit",
    async () => {
      const result = await processSermon(
        processRequestSchema.parse({
          artwork,
          input: speechHandlingInput,
          output: join(directory, "speech-handling.mp3"),
          qcDirectory: directory,
          metadata: {
            organization: "Example Organization",
            preacher: "Test Preacher",
            sermonSeries: "Test Series",
            date: "2026-08-23",
            scripture: "Matthew 5:9",
          },
          // This short synthetic clip cannot reach the full-sermon loudness
          // target while preserving the same lossy-codec peak headroom.
          processing: { targetLufs: -18 },
        }),
      );
      const report = qcReportSubsetSchema
        .pick({ handlingNoise: true })
        .parse(JSON.parse(await readFile(result.qcReportPath, "utf8")));
      expect(report.handlingNoise).toContainEqual(expect.objectContaining({ action: "removed" }));
    },
    30_000,
  );

  it("resumes a failed encode without decoding, denoising, or rebuilding edits", async () => {
    const request = processRequestSchema.parse({
      artwork,
      input,
      output: join(directory, "resumed.mp3"),
      qcDirectory: directory,
      metadata: {
        organization: "Church",
        preacher: "Alice Smith",
        sermonSeries: "Series",
        date: "2026-11-01",
        scripture: "2 Corinthians 4:1–6",
      },
    });
    const actual = new ExecaCommandRunner();
    let workDirectory: string | undefined;
    try {
      await processSermon(request, {
        async run(command, args) {
          if (
            args.some((arg) => arg.endsWith("05-premaster.wav")) &&
            args.some((arg) => arg.startsWith("loudnorm="))
          )
            throw new Error("Simulated encoding failure");
          return actual.run(command, args);
        },
      });
    } catch (error) {
      workDirectory = (error instanceof Error ? error.message : "").match(
        /Work files preserved: (.+)$/,
      )?.[1];
    }
    expect(workDirectory).toBeDefined();
    const preserved = workDirectory!;
    try {
      await Promise.all(
        [
          "01-canonical.wav",
          "02-denoised.wav",
          "03-handling-clean.wav",
          "04-transcript-clean.wav",
        ].map((file) => rm(join(preserved, file), { force: true })),
      );
      const result = await resumeSermon(join(preserved, "encoding-checkpoint.json"));
      const report = qcReportSubsetSchema.parse(
        JSON.parse(await readFile(result.qcReportPath, "utf8")),
      );
      expect(report.loudness.output.inputI).toBeGreaterThanOrEqual(-18);
      expect(report.loudness.output.inputTp).toBeLessThanOrEqual(-1.5);
      expect(report.handlingNoise).toContainEqual(expect.objectContaining({ action: "removed" }));
    } finally {
      await rm(preserved, { recursive: true, force: true });
    }
  }, 30_000);

  function codecLossRequest(name: string) {
    return processRequestSchema.parse({
      artwork,
      input,
      output: join(directory, `${name}.mp3`),
      qcDirectory: directory,
      metadata: {
        organization: "Church",
        preacher: "Alice Smith",
        sermonSeries: "Series",
        date: "2026-11-01",
        scripture: "2 Corinthians 4:1–6",
      },
    });
  }
  it("recovers normalized PCM undershoot and delivers independently verified MP3", async () => {
    const actual = pcmUndershootRunner();
    const correctionFilters: string[] = [];
    let correctedPcm: Buffer | undefined;
    let encodedCorrectedPcm = false;
    const result = await processSermon(codecLossRequest("pcm-undershoot"), {
      async run(command, args) {
        const inputPath = args[args.indexOf("-i") + 1];
        if (args.at(-1)?.endsWith("06-corrected.wav"))
          correctionFilters.push(args[args.indexOf("-af") + 1]!);
        if (inputPath?.endsWith("06-corrected.wav")) correctedPcm = await readFile(inputPath);
        if (inputPath?.endsWith("06-normalized.wav") && args.includes("libmp3lame"))
          encodedCorrectedPcm = (await readFile(inputPath)).equals(correctedPcm!);
        return actual.run(command, args);
      },
    });
    const report = qcReportSubsetSchema.parse(
      JSON.parse(await readFile(result.qcReportPath, "utf8")),
    );
    expect(report.processing.stages).toContainEqual(
      expect.objectContaining({ stage: "Verify corrected normalized PCM" }),
    );
    expect(report.loudness.normalizedPcm.inputI).toBeGreaterThanOrEqual(-18);
    expect(report.loudness.output.inputI).toBeGreaterThanOrEqual(-18);
    expect(report.loudness.output.inputTp).toBeLessThanOrEqual(-1.5);
    expect(correctionFilters).toContain("volume=0.260000dB");
    expect(encodedCorrectedPcm).toBe(true);
  }, 30_000);
  it("withholds delivery and preserves checkpoint if corrected normalized PCM fails QC", async () => {
    const request = codecLossRequest("pcm-undershoot-failed");
    let message = "";
    try {
      await processSermon(request, pcmUndershootRunner(true));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("outside the -16 ± 2 LU contract");
    await expect(access(request.output)).rejects.toThrow("ENOENT");
    const work = message.match(/Work files preserved: (.+)$/)?.[1];
    expect(work).toBeDefined();
    await expect(access(join(work!, "encoding-checkpoint.json"))).resolves.toBeUndefined();
    await rm(work!, { recursive: true, force: true });
  }, 30_000);
  it("encodes the corrected lossless PCM and reports its verified measurements", async () => {
    const result = await processSermon(codecLossRequest("codec-correction"), codecLossRunner());
    const report = qcReportSubsetSchema.parse(
      JSON.parse(await readFile(result.qcReportPath, "utf8")),
    );
    expect(report.processing.encodingAttempts).toBe(2);
    expect(report.processing.stages).toContainEqual(
      expect.objectContaining({ stage: "Verify corrected PCM" }),
    );
    expect(report.loudness.output.inputI).toBeGreaterThanOrEqual(-18);
    expect(report.loudness.output.inputTp).toBeLessThanOrEqual(-1.5);
  }, 30_000);
  it("recovers insufficient linear gain margin through independently verified dynamic normalization", async () => {
    const result = await processSermon(
      codecLossRequest("pcm-dynamic-recovery"),
      pcmUndershootRunner("margin"),
    );
    const report = qcReportSubsetSchema.parse(
      JSON.parse(await readFile(result.qcReportPath, "utf8")),
    );
    expect(report.processing.stages).toContainEqual(
      expect.objectContaining({ stage: "Verify renormalized PCM" }),
    );
    expect(report.loudness.normalizedPcm.inputI).toBeGreaterThanOrEqual(-18);
    expect(report.loudness.normalizedPcm.inputTp).toBeLessThanOrEqual(
      report.loudness.normalizationTruePeakTargetDbtp + 0.6,
    );
    expect(report.loudness.output.inputI).toBeGreaterThanOrEqual(-18);
    expect(report.loudness.output.inputTp).toBeLessThanOrEqual(-1.5);
  }, 30_000);
  it("withholds delivery if dynamic PCM recovery fails independent QC", async () => {
    const request = codecLossRequest("pcm-dynamic-failed");
    let message = "";
    try {
      await processSermon(request, pcmUndershootRunner("renormalization"));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("outside the -16 ± 2 LU contract");
    await expect(access(request.output)).rejects.toThrow("ENOENT");
    const work = message.match(/Work files preserved: (.+)$/)?.[1];
    expect(work).toBeDefined();
    await expect(access(join(work!, "encoding-checkpoint.json"))).resolves.toBeUndefined();
    await rm(work!, { recursive: true, force: true });
  }, 30_000);
  it.each(["pcm", "mp3"] as const)(
    "preserves diagnostics without delivering audio when corrected %s verification fails",
    async (failAt) => {
      const request = codecLossRequest(`failed-correction-${failAt}`);
      let message = "";
      try {
        await processSermon(request, codecLossRunner(failAt));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("outside the -16 ± 2 LU contract");
      const work = message.match(/Work files preserved: (.+)$/)?.[1];
      expect(work).toBeDefined();
      await expect(access(request.output)).rejects.toThrow("ENOENT");
      await expect(access(join(work!, "encoding-checkpoint.json"))).resolves.toBeUndefined();
      await rm(work!, { recursive: true, force: true });
    },
    30_000,
  );
  it("retries from premaster when codec gain introduces MP3 peak overshoot", async () => {
    const result = await processSermon(
      codecLossRequest("codec-gain-peak-retry"),
      codecLossRunner("peak"),
    );
    const report = qcReportSubsetSchema.parse(
      JSON.parse(await readFile(result.qcReportPath, "utf8")),
    );
    expect(report.processing.encodingAttempts).toBe(3);
    expect(report.processing.stages).toContainEqual(
      expect.objectContaining({ stage: "Normalize PCM (attempt 2)" }),
    );
    expect(report.loudness.output.inputI).toBeGreaterThanOrEqual(-18);
    expect(report.loudness.output.inputTp).toBeLessThanOrEqual(-1.5);
  }, 30_000);
});
