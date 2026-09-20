import { describe, expect, it } from "vitest";
import { assertAudioInputPath, assertArtworkPath, processRequestSchema } from "../schema.js";

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
      transcription: {
        enabled: false,
        maximumGapSeconds: 30,
        minimumGapSeconds: 2,
        minimumWordConfidence: 0.5,
        retainedGapSeconds: 0.4,
      },
    });
  });

  it("requires a model when transcription-assisted shortening is enabled", () => {
    expect(() =>
      processRequestSchema.parse({
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
        processing: { transcription: { enabled: true } },
      }),
    ).toThrow("A Whisper model path is required");
  });

  it("requires a VAD model when transcription-assisted shortening is enabled", () => {
    expect(() =>
      processRequestSchema.parse({
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
        processing: {
          transcription: { enabled: true, modelPath: "/models/ggml-base.en.bin" },
        },
      }),
    ).toThrow("A Whisper VAD model path is required");
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
    ["recording.mp4", assertAudioInputPath, "Input must be an AIFF or WAV file"],
    ["artwork.gif", assertArtworkPath, "Artwork must be a JPEG or PNG file"],
  ])("rejects an unsupported path for %s", (path, assertPath, message) => {
    expect(() => assertPath(path)).toThrow(message);
  });

  it.each(["recording.aif", "recording.aiff", "recording.wav"])(
    "accepts supported audio input %s",
    (path) => {
      expect(() => assertAudioInputPath(path)).not.toThrow();
    },
  );
});
