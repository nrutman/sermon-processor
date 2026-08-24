import type { AudioRuntime } from "./runtime.js";
import type { CommandRunner } from "../process/run-command.js";
import { z } from "zod";

const loudnormOutputSchema = z.object({
  input_i: z.unknown(),
  input_tp: z.unknown(),
  input_lra: z.unknown(),
  input_thresh: z.unknown(),
  target_offset: z.unknown(),
});

export interface LoudnessMeasurement {
  inputI: number;
  inputLra: number;
  inputThreshold: number;
  inputTp: number;
  targetOffset: number;
}

function parseNumber(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`FFmpeg returned an invalid loudness value for ${field}`);
  }
  return parsed;
}

export function parseLoudnessMeasurement(output: string): LoudnessMeasurement {
  const json = output.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0];
  if (json === undefined) {
    throw new Error("FFmpeg did not return a loudness measurement");
  }
  const parsed = loudnormOutputSchema.parse(JSON.parse(json));
  return {
    inputI: parseNumber(parsed.input_i, "input_i"),
    inputTp: parseNumber(parsed.input_tp, "input_tp"),
    inputLra: parseNumber(parsed.input_lra, "input_lra"),
    inputThreshold: parseNumber(parsed.input_thresh, "input_thresh"),
    targetOffset: parseNumber(parsed.target_offset, "target_offset"),
  };
}

export async function measureLoudness(
  input: string,
  target: { lufs: number; lra: number; truePeak: number },
  runtime: AudioRuntime,
  runner: CommandRunner,
): Promise<LoudnessMeasurement> {
  const result = await runner.run(runtime.ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-i",
    input,
    "-af",
    `loudnorm=I=${target.lufs}:LRA=${target.lra}:TP=${target.truePeak}:print_format=json`,
    "-f",
    "null",
    "-",
  ]);
  return parseLoudnessMeasurement(result.stderr);
}

export function verifyOutputLoudness(
  measurement: LoudnessMeasurement,
  target: { lufs: number; truePeak: number },
  truePeakToleranceDb = 0,
): void {
  // Very short speech clips can move by more than 1 LU after MP3 encoding and
  // the EBU gating pass. Full sermons normally land much closer to the target.
  const loudnessToleranceLu = 2;
  if (Math.abs(measurement.inputI - target.lufs) > loudnessToleranceLu) {
    throw new Error(
      `Output loudness ${measurement.inputI} LUFS is outside the ${target.lufs} ± ${loudnessToleranceLu} LU contract`,
    );
  }
  if (measurement.inputTp > target.truePeak + truePeakToleranceDb) {
    throw new Error(
      `Output true peak ${measurement.inputTp} dBTP exceeds the ${target.truePeak} dBTP target`,
    );
  }
}
