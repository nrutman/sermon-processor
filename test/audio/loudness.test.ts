import { describe, expect, it } from "vitest";
import { parseLoudnessMeasurement, verifyOutputLoudness } from "../../src/audio/loudness.js";

describe("parseLoudnessMeasurement", () => {
  it("extracts FFmpeg loudnorm JSON from surrounding log output", () => {
    const output = `noise before\n{
      "input_i" : "-22.40",
      "input_tp" : "-4.12",
      "input_lra" : "5.30",
      "input_thresh" : "-33.00",
      "target_offset" : "0.10"
    }\nnoise after`;

    expect(parseLoudnessMeasurement(output)).toEqual({
      inputI: -22.4,
      inputTp: -4.12,
      inputLra: 5.3,
      inputThreshold: -33,
      targetOffset: 0.1,
    });
  });
});

describe("verifyOutputLoudness", () => {
  const measurement = {
    inputI: -16.2,
    inputTp: -1.5,
    inputLra: 5,
    inputThreshold: -27,
    targetOffset: 0,
  };

  it("accepts encoded output within the explicit tolerance", () => {
    expect(() => verifyOutputLoudness(measurement, { lufs: -16, truePeak: -1.5 })).not.toThrow();
  });

  it("rejects output that misses the loudness contract", () => {
    expect(() =>
      verifyOutputLoudness({ ...measurement, inputI: -18.1 }, { lufs: -16, truePeak: -1.5 }),
    ).toThrow("outside");
  });

  it("rejects output above the true-peak ceiling", () => {
    expect(() =>
      verifyOutputLoudness({ ...measurement, inputTp: -1.49 }, { lufs: -16, truePeak: -1.5 }),
    ).toThrow("exceeds");
  });
});
