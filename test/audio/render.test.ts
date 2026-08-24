import { describe, expect, it } from "vitest";
import {
  createPremaster,
  encodeMp3,
  normalizePremaster,
  parseNoiseProfile,
} from "../../src/audio/render.js";
import type { AudioRuntime } from "../../src/audio/runtime.js";
import type { CommandRunner } from "../../src/process/run-command.js";

const runtime: AudioRuntime = {
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  ffmpegVersion: "test",
  ffprobeVersion: "test",
};

function recordingRunner(): { calls: string[][]; runner: CommandRunner } {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      async run(_command, arguments_) {
        calls.push([...arguments_]);
        return { stderr: "", stdout: "" };
      },
    },
  };
}

describe("final rendering", () => {
  it("parses FFmpeg's 15-band sampled room-tone profile", () => {
    expect(
      parseNoiseProfile(`noise\nbn=${Array.from({ length: 15 }, (_, index) => index).join(" ")}\n`),
    ).toHaveLength(15);
  });

  it("retains a natural pause while trimming leading silence", async () => {
    const { calls, runner } = recordingRunner();
    await createPremaster(
      "input.wav",
      "premaster.wav",
      -55,
      {
        highpassHz: 75,
        noiseReductionDb: 10,
        leadingSpeechConfirmationSeconds: 0.1,
        silenceMinimumSeconds: 1,
        retainedSilenceSeconds: 0.4,
        targetLufs: -16,
        truePeakDbtp: -1.5,
        targetLra: 7,
        handlingNoise: {
          enabled: true,
          minimumDurationSeconds: 0.4,
          maximumDurationSeconds: 1.5,
          minimumConfidence: 0.86,
          crossfadeSeconds: 0.03,
        },
      },
      runtime,
      runner,
    );

    const filter = calls[0]?.at(calls[0]?.indexOf("-af") + 1);
    expect(filter).toContain("start_periods=1");
    expect(filter).toContain("start_duration=0.1");
    expect(filter).toContain("start_threshold=-55.0dB");
    expect(filter).toContain("start_silence=0.4");
  });

  it("creates a lossless normalized master at the codec-headroom target", async () => {
    const { calls, runner } = recordingRunner();
    await normalizePremaster(
      "premaster.wav",
      "normalized.wav",
      {
        inputI: -20,
        inputLra: 5,
        inputThreshold: -30,
        inputTp: -1,
        targetOffset: 0,
      },
      {
        highpassHz: 75,
        noiseReductionDb: 10,
        leadingSpeechConfirmationSeconds: 0.1,
        silenceMinimumSeconds: 1,
        retainedSilenceSeconds: 0.4,
        targetLufs: -16,
        truePeakDbtp: -1.5,
        targetLra: 7,
        handlingNoise: {
          enabled: true,
          minimumDurationSeconds: 0.4,
          maximumDurationSeconds: 1.5,
          minimumConfidence: 0.86,
          crossfadeSeconds: 0.03,
        },
      },
      -3.5,
      runtime,
      runner,
    );

    expect(calls[0]).toContain("pcm_s24le");
    expect(calls[0]?.at(calls[0]?.indexOf("-af") + 1)).toContain("TP=-3.5");
    expect(calls[0]?.at(calls[0]?.indexOf("-af") + 1)).toMatch(/loudnorm=.*aresample=44100/);
  });

  it("encodes the verified PCM master without additional DSP", async () => {
    const { calls, runner } = recordingRunner();
    await encodeMp3(
      "normalized.wav",
      "output.mp3",
      "artwork.png",
      {
        album: "Series",
        albumArtist: "Church",
        artist: "Preacher",
        comment: "Comment",
        date: "2026",
        genre: "Preaching",
        title: "Title",
      },
      runtime,
      runner,
    );

    expect(calls[0]).not.toContain("-af");
    expect(calls[0]).toContain("artwork.png");
    expect(calls[0]).toContain("attached_pic");
    expect(calls[0]).toContain("64k");
    expect(calls[0]).toContain("libmp3lame");
  });
});
