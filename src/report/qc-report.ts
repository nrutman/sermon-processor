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
    output: LoudnessMeasurement;
  };
  metadata: Mp3Metadata;
  noise: NoiseAnalysis;
  output: VerifiedMp3Output & { path: string };
  runtime: AudioRuntime;
  schemaVersion: 1;
  warnings: string[];
}
