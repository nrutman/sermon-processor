import { describe, expect, it } from "vitest";
import { planCodecGain, planPcmGain } from "../codec-gain.js";
const measurement = {
  inputI: -17.78,
  inputTp: -4.66,
  inputLra: 3.3,
  inputThreshold: -28,
  targetOffset: 0,
};
const target = { lufs: -16, truePeak: -1.5, pcmTruePeak: -4.3 };
describe("normalized PCM loudness correction", () => {
  const pcmTarget = { lufs: -16, truePeak: -4.3 };
  it("recovers the sermon undershoot without spending verification tolerance", () => {
    expect(planPcmGain({ ...measurement, inputI: -18.06, inputTp: -4.8 }, pcmTarget)).toBeCloseTo(
      0.26,
    );
  });
  it("leaves PCM at the loudness floor unchanged", () => {
    expect(planPcmGain({ ...measurement, inputI: -18 }, pcmTarget)).toBe(0);
  });
  it("refuses correction when measured peak margin is insufficient", () => {
    expect(() => planPcmGain({ ...measurement, inputI: -18.06, inputTp: -4.5 }, pcmTarget)).toThrow(
      "Insufficient measured peak margin",
    );
  });
});
describe("codec loudness correction", () => {
  it("corrects measured codec loudness loss inside both peak margins", () => {
    expect(
      planCodecGain(measurement, { ...measurement, inputI: -18.17, inputTp: -2.35 }, target),
    ).toBeCloseTo(0.37);
  });
  it("does not change an MP3 at the loudness boundary", () => {
    expect(planCodecGain(measurement, { ...measurement, inputI: -18 }, target)).toBe(0);
  });
  it.each([
    { name: "MP3 peak", pcm: measurement, mp3: { ...measurement, inputI: -18.17, inputTp: -1.6 } },
    {
      name: "PCM peak",
      pcm: { ...measurement, inputTp: -3.8 },
      mp3: { ...measurement, inputI: -18.17, inputTp: -3 },
    },
  ])("refuses correction without $name margin", ({ pcm, mp3 }) => {
    expect(() => planCodecGain(pcm, mp3, target)).toThrow("Insufficient measured peak margin");
  });
});
