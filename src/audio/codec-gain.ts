import type { LoudnessMeasurement } from "./loudness.js";

/** Returns a bounded PCM gain correction for an MP3 below the loudness floor, or zero when none is needed. */
export function planCodecGain(
  pcm: LoudnessMeasurement,
  mp3: LoudnessMeasurement,
  target: { lufs: number; truePeak: number; pcmTruePeak: number },
): number {
  if (mp3.inputI >= target.lufs - 2) return 0;
  // Leave 0.2 dB of measured margin at both peak boundaries and aim inside the loudness tolerance.
  const gain = target.lufs - 1.8 - mp3.inputI;
  const available = Math.min(
    target.truePeak - mp3.inputTp - 0.2,
    target.pcmTruePeak + 0.6 - pcm.inputTp - 0.2,
  );
  if (gain > available || gain <= 0)
    throw new Error(
      "Insufficient measured peak margin to correct MP3 loudness safely; use the preserved encoding checkpoint",
    );
  return gain;
}
