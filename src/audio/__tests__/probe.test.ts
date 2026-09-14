import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../../process/run-command.js";
import { probeAudioInput } from "../probe.js";
import type { AudioRuntime } from "../runtime.js";

const runtime: AudioRuntime = {
  ffmpegPath: "ffmpeg",
  ffmpegVersion: "test",
  ffprobePath: "ffprobe",
  ffprobeVersion: "test",
};

function runnerReturning(value: object): CommandRunner {
  return {
    async run() {
      return { stderr: "", stdout: JSON.stringify(value) };
    },
  };
}

describe("probeAudioInput", () => {
  it("rejects input without a supported audio stream", async () => {
    const runner = runnerReturning({
      format: { duration: "10", format_name: "aiff" },
      streams: [{ codec_name: "bin_data", codec_type: "data" }],
    });

    await expect(probeAudioInput("input.aiff", runtime, runner)).rejects.toThrow(
      "Input does not contain a supported audio stream",
    );
  });

  it("accepts WAV input", async () => {
    const runner = runnerReturning({
      format: { duration: "10", format_name: "wav" },
      streams: [
        { codec_name: "pcm_s24le", codec_type: "audio", channels: 1, sample_rate: "48000" },
      ],
    });

    await expect(probeAudioInput("input.wav", runtime, runner)).resolves.toMatchObject({
      codec: "pcm_s24le",
      format: "wav",
    });
  });

  it("rejects audio in an unsupported container", async () => {
    const runner = runnerReturning({
      format: { duration: "10", format_name: "flac" },
      streams: [{ codec_name: "flac", codec_type: "audio", channels: 1, sample_rate: "48000" }],
    });

    await expect(probeAudioInput("input.flac", runtime, runner)).rejects.toThrow(
      "Input is not an AIFF or WAV container: flac",
    );
  });
});
