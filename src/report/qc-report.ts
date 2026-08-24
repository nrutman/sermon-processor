import type { AudioProbe } from "../audio/probe.js";
import type { NoiseAnalysis } from "../audio/analyze.js";
import type { LoudnessMeasurement } from "../audio/loudness.js";
import type { AudioRuntime } from "../audio/runtime.js";
import type { Mp3Metadata } from "../metadata/sermon-metadata.js";
import type { VerifiedMp3Output } from "../audio/metadata.js";

export interface HandlingNoiseEvent {
  action: "removed" | "reported";
  confidence: number;
  durationSeconds: number;
  endSeconds: number;
  reason?: string;
  startSeconds: number;
}

export interface QcReport {
  createdAt: string;
  handlingNoise: HandlingNoiseEvent[];
  input: AudioProbe & { path: string };
  loudness: {
    beforeNormalization: LoudnessMeasurement;
    normalizedPcm: LoudnessMeasurement;
    normalizationTruePeakTargetDbtp: number;
    output: LoudnessMeasurement;
  };
  metadata: Mp3Metadata;
  noise: {
    afterDenoising: NoiseAnalysis;
    beforeDenoising: NoiseAnalysis;
    profile?: {
      bandNoiseDb: number[];
      interval: import("../audio/analyze.js").RoomToneInterval;
    };
  };
  output: VerifiedMp3Output & { path: string };
  runtime: AudioRuntime;
  schemaVersion: 2;
  warnings: string[];
}
