import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { CommandRunner } from "../process/run-command.js";

const requiredFilters = [
  "acompressor",
  "acrossfade",
  "adeclick",
  "afftdn",
  "ametadata",
  "aresample",
  "asetnsamples",
  "asetpts",
  "astats",
  "aspectralstats",
  "atrim",
  "dynaudnorm",
  "highpass",
  "loudnorm",
  "silenceremove",
] as const;

const requiredEncoders = ["libmp3lame", "pcm_s24le"] as const;

export interface AudioRuntime {
  ffmpegPath: string;
  ffprobePath: string;
  ffmpegVersion: string;
  ffprobeVersion: string;
}

async function executableFromEnvironment(
  variable: "FFMPEG_PATH" | "FFPROBE_PATH",
  fallback: string,
): Promise<string> {
  const configured = process.env[variable];
  if (configured === undefined) {
    return fallback;
  }

  await access(configured, constants.X_OK);
  return configured;
}

function firstLine(output: string): string {
  return output.split("\n", 1)[0]?.trim() ?? output.trim();
}

export async function inspectAudioRuntime(runner: CommandRunner): Promise<AudioRuntime> {
  const ffmpegPath = await executableFromEnvironment("FFMPEG_PATH", "ffmpeg");
  const ffprobePath = await executableFromEnvironment("FFPROBE_PATH", "ffprobe");

  let ffmpegVersionResult;
  let ffprobeVersionResult;
  try {
    [ffmpegVersionResult, ffprobeVersionResult] = await Promise.all([
      runner.run(ffmpegPath, ["-version"]),
      runner.run(ffprobePath, ["-version"]),
    ]);
  } catch (error) {
    throw new Error(
      "FFmpeg and FFprobe are required. Install them or set FFMPEG_PATH and FFPROBE_PATH.",
      { cause: error },
    );
  }

  const filters = await runner.run(ffmpegPath, ["-hide_banner", "-filters"]);
  const missing = requiredFilters.filter(
    (filter) => !new RegExp(`\\b${filter}\\b`).test(filters.stdout),
  );
  if (missing.length > 0) {
    throw new Error(`FFmpeg is missing required filters: ${missing.join(", ")}`);
  }
  const encoders = await runner.run(ffmpegPath, ["-hide_banner", "-encoders"]);
  const missingEncoders = requiredEncoders.filter(
    (encoder) => !new RegExp(`\\b${encoder}\\b`).test(encoders.stdout),
  );
  if (missingEncoders.length > 0) {
    throw new Error(`FFmpeg is missing required encoders: ${missingEncoders.join(", ")}`);
  }

  return {
    ffmpegPath,
    ffprobePath,
    ffmpegVersion: firstLine(ffmpegVersionResult.stdout),
    ffprobeVersion: firstLine(ffprobeVersionResult.stdout),
  };
}
