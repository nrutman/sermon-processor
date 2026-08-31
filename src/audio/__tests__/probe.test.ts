import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../../process/run-command.js";
import { probeAiff } from "../probe.js";
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

describe("probeAiff", () => {
  it("rejects input without a supported audio stream", async () => {
    const runner = runnerReturning({
      format: { duration: "10", format_name: "aiff" },
      streams: [{ codec_name: "bin_data", codec_type: "data" }],
    });

    await expect(probeAiff("input.aiff", runtime, runner)).rejects.toThrow(
      "Input does not contain a supported audio stream",
    );
  });

  it("rejects audio in a non-AIFF container", async () => {
    const runner = runnerReturning({
      format: { duration: "10", format_name: "wav" },
      streams: [
        { codec_name: "pcm_s24le", codec_type: "audio", channels: 1, sample_rate: "48000" },
      ],
    });

    await expect(probeAiff("input.aiff", runtime, runner)).rejects.toThrow(
      "Input is not an AIFF container: wav",
    );
  });
});
