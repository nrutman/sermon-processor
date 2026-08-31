import { describe, expect, it } from "vitest";
import { assertAiffPath, assertArtworkPath, processRequestSchema } from "../schema.js";

describe("processRequestSchema", () => {
  it("applies conservative processing defaults", () => {
    const request = processRequestSchema.parse({
      artwork: "artwork.png",
      input: "sermon.aiff",
      output: "sermon.mp3",
      metadata: {
        organization: "Example Organization",
        preacher: "Jane Smith",
        sermonSeries: "The Kingdom",
        date: "2026-08-23",
        scripture: "Matthew 7:7–12",
      },
    });

    expect(request.processing).toMatchObject({
      leadingSpeechConfirmationSeconds: 0.1,
      silenceMinimumSeconds: 1,
      retainedSilenceSeconds: 0.4,
      targetLufs: -16,
      truePeakDbtp: -1.5,
      handlingNoise: {
        enabled: true,
        minimumDurationSeconds: 0.4,
        maximumDurationSeconds: 1.5,
        minimumConfidence: 0.86,
      },
    });
  });

  it("rejects impossible calendar dates", () => {
    expect(() =>
      processRequestSchema.parse({
        artwork: "artwork.png",
        input: "sermon.aiff",
        output: "sermon.mp3",
        metadata: {
          organization: "Example Organization",
          preacher: "Jane Smith",
          sermonSeries: "The Kingdom",
          date: "2026-02-31",
          scripture: "Matthew 7:7–12",
        },
      }),
    ).toThrow("Date is not valid");
  });

  it.each([
    ["recording.wav", assertAiffPath, "Input must be an AIFF file"],
    ["artwork.gif", assertArtworkPath, "Artwork must be a JPEG or PNG file"],
  ])("rejects an unsupported path for %s", (path, assertPath, message) => {
    expect(() => assertPath(path)).toThrow(message);
  });
});
