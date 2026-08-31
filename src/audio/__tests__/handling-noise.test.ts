import { describe, expect, it } from "vitest";
import {
  classifyHandlingNoise,
  parseSpectralFrames,
  type SpectralFrame,
} from "../handling-noise.js";
import { processingOptionsSchema } from "../../config/schema.js";

const options = processingOptionsSchema.parse({}).handlingNoise;

function frame(
  timeSeconds: number,
  values: Partial<Omit<SpectralFrame, "timeSeconds">> = {},
): SpectralFrame {
  return {
    timeSeconds,
    rmsDb: -70,
    flatness: 0.1,
    centroidHz: 800,
    ...values,
  };
}

describe("handling-noise detection", () => {
  it("removes a sustained broadband burst surrounded by quiet frames", () => {
    const frames = [
      frame(0),
      frame(0.128),
      ...Array.from({ length: 6 }, (_, index) =>
        frame(0.256 + index * 0.128, {
          rmsDb: -18,
          flatness: 0.92,
          centroidHz: 4_800,
        }),
      ),
      frame(1.024),
      frame(1.152),
    ];

    const events = classifyHandlingNoise(frames, -50, options, []);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "removed",
      startSeconds: 0.256,
    });
    expect(events[0]?.durationSeconds).toBeCloseTo(0.768);
  });

  it("reports a noise-like region without quiet speech boundaries", () => {
    const frames = [
      frame(0, { rmsDb: -20 }),
      frame(0.128, { rmsDb: -18 }),
      ...Array.from({ length: 5 }, (_, index) =>
        frame(0.256 + index * 0.128, {
          rmsDb: -16,
          flatness: 0.88,
          centroidHz: 4_200,
        }),
      ),
      frame(0.896, { rmsDb: -20 }),
      frame(1.024, { rmsDb: -19 }),
    ];

    expect(
      classifyHandlingNoise(frames, -50, options, [{ startSeconds: 0.2, endSeconds: 1.1 }]),
    ).toEqual([expect.objectContaining({ action: "reported" })]);
  });

  it("parses FFmpeg frame metadata", () => {
    const output = [
      "frame:0 pts:0 pts_time:0",
      "lavfi.astats.Overall.RMS_level=-18.5",
      "lavfi.aspectralstats.1.centroid=4200.25",
      "lavfi.aspectralstats.1.flatness=0.91",
    ].join("\n");

    expect(parseSpectralFrames(output)).toEqual([
      { timeSeconds: 0, rmsDb: -18.5, centroidHz: 4200.25, flatness: 0.91 },
    ]);
  });
});
