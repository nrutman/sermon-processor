import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../../process/run-command.js";
import { inspectAudioRuntime } from "../runtime.js";

const filters =
  "acompressor acrossfade adeclick afftdn ametadata aresample asetnsamples asetpts astats aspectralstats atrim dynaudnorm highpass loudnorm silenceremove";

function runtimeRunner(filterOutput: string, encoderOutput: string): CommandRunner {
  return {
    async run(_command, arguments_) {
      if (arguments_.includes("-version")) return { stderr: "", stdout: "version test" };
      if (arguments_.includes("-filters")) return { stderr: "", stdout: filterOutput };
      return { stderr: "", stdout: encoderOutput };
    },
  };
}

describe("inspectAudioRuntime", () => {
  it("reports missing required FFmpeg filters", async () => {
    await expect(
      inspectAudioRuntime(runtimeRunner(filters.replace(" loudnorm", ""), "libmp3lame pcm_s24le")),
    ).rejects.toThrow("FFmpeg is missing required filters: loudnorm");
  });

  it("reports missing required FFmpeg encoders", async () => {
    await expect(inspectAudioRuntime(runtimeRunner(filters, "pcm_s24le"))).rejects.toThrow(
      "FFmpeg is missing required encoders: libmp3lame",
    );
  });
});
