import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { processRequestSchema } from "../../config/schema.js";
import { processSermon } from "../process-sermon.js";
import type { CommandRunner } from "../run-command.js";

describe("processSermon failure handling", () => {
  it("refuses to replace an existing output without explicit approval", async () => {
    const directory = await mkdtemp(join(tmpdir(), "process-sermon-test-"));
    const output = join(directory, "sermon.mp3");
    await writeFile(output, "existing output");
    const runner = { run: vi.fn<CommandRunner["run"]>() };
    const request = processRequestSchema.parse({
      artwork: join(directory, "artwork.png"),
      input: join(directory, "sermon.aiff"),
      output,
      metadata: {
        organization: "Example Organization",
        preacher: "Test Preacher",
        sermonSeries: "Test Series",
        date: "2026-08-23",
        scripture: "Matthew 7:7–12",
      },
    });

    await expect(processSermon(request, runner)).rejects.toThrow(
      `Output already exists: ${output}`,
    );
    await expect(readFile(output, "utf8")).resolves.toBe("existing output");
    expect(runner.run).not.toHaveBeenCalled();
  });

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
