import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { processRequestSchema } from "../../config/schema.js";
import { processSermon } from "../process-sermon.js";
import type { CommandRunner } from "../run-command.js";

describe("processSermon failure handling", () => {
  it("preserves and reports its work directory when processing fails", async () => {
    const runner: CommandRunner = {
      async run(command, arguments_) {
        if (arguments_.includes("-version")) {
          return { stderr: "", stdout: `${command} version test` };
        }
        if (arguments_.includes("-filters")) {
          return {
            stderr: "",
            stdout:
              "acompressor acrossfade adeclick afftdn ametadata aresample asetnsamples asetpts astats aspectralstats atrim dynaudnorm highpass loudnorm silenceremove",
          };
        }
        if (arguments_.includes("-encoders")) {
          return { stderr: "", stdout: "libmp3lame pcm_s24le" };
        }
        if (arguments_.includes("-show_streams")) {
          return {
            stderr: "",
            stdout: JSON.stringify({
              format: { duration: "60", format_name: "aiff" },
              streams: [
                {
                  channels: 1,
                  codec_name: "pcm_s16be",
                  codec_type: "audio",
                  sample_rate: "48000",
                },
              ],
            }),
          };
        }
        throw new Error("simulated FFmpeg failure");
      },
    };
    const request = processRequestSchema.parse({
      artwork: join(tmpdir(), "artwork.png"),
      input: join(tmpdir(), "failed-sermon.aiff"),
      output: join(tmpdir(), "failed-sermon.mp3"),
      metadata: {
        organization: "Example Organization",
        preacher: "Test Preacher",
        sermonSeries: "Test Series",
        date: "2026-08-23",
        scripture: "Matthew 7:7–12",
      },
    });

    let workDirectory: string | undefined;
    try {
      await processSermon(request, runner);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      workDirectory = message.match(/Work files preserved: (.+)$/)?.[1];
    }

    expect(workDirectory).toBeDefined();
    await expect(access(workDirectory!)).resolves.toBeUndefined();
    await rm(workDirectory!, { recursive: true, force: true });
  });
});
