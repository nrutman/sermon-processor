import { describe, expect, it } from "vitest";
import { analysisInternals } from "../../src/audio/analyze.js";

describe("audio analysis", () => {
  it("pairs silence events and closes a trailing interval", () => {
    const output = [
      "silence_start: 1.25",
      "silence_end: 2.75 | silence_duration: 1.5",
      "silence_start: 8",
    ].join("\n");

    expect(analysisInternals.parseSilences(output, 10)).toEqual([
      { startSeconds: 1.25, endSeconds: 2.75, durationSeconds: 1.5 },
      { startSeconds: 8, endSeconds: 10, durationSeconds: 2 },
    ]);
  });

  it("calculates the median for odd and even samples", () => {
    expect(analysisInternals.median([-50, -60, -40])).toBe(-50);
    expect(analysisInternals.median([-60, -50, -40, -30])).toBe(-45);
  });

  it("parses finite frame RMS values while excluding digital silence", () => {
    const output = [
      "lavfi.astats.Overall.RMS_level=-inf",
      "lavfi.astats.Overall.RMS_level=-48.5",
      "lavfi.astats.Overall.RMS_level=-22",
      "lavfi.astats.Overall.RMS_level=-100",
    ].join("\n");
    expect(analysisInternals.parseFrameRms(output)).toEqual([-48.5, -22]);
  });
});
