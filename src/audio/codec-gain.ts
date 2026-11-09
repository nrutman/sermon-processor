import type { LoudnessMeasurement } from "./loudness.js";

export class InsufficientPcmGainMarginError extends Error {}

/** Returns a PCM loudness-floor correction bounded by the measured normalization peak margin. */
export function planPcmGain(
  pcm: LoudnessMeasurement,
  target: { lufs: number; truePeak: number },
): number {
  if (pcm.inputI >= target.lufs - 2) return 0;
  const gain = target.lufs - 1.8 - pcm.inputI;
  // Keep measured peak headroom; the verification tolerance is not extra gain budget.
  if (gain > target.truePeak - pcm.inputTp - 0.2)
    throw new InsufficientPcmGainMarginError(
      "Insufficient measured peak margin to correct normalized PCM loudness safely",
    );
  return gain;
}

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
