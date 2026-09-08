import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  classifyHandlingNoise,
  parseSpectralFrames,
  removeHandlingNoise,
  type SpectralFrame,
} from "../handling-noise.js";
import { processingOptionsSchema } from "../../config/schema.js";
import type { AudioRuntime } from "../runtime.js";
import type { CommandRunner } from "../../process/run-command.js";

const options = processingOptionsSchema.parse({}).handlingNoise;
const runtime: AudioRuntime = {
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  ffmpegVersion: "test",
  ffprobeVersion: "test",
};

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

  it("copies the input unchanged when handling-noise removal is disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "handling-noise-test-"));
    const input = join(directory, "input.wav");
    const output = join(directory, "output.wav");
    await writeFile(input, "lossless audio fixture");
    const runner = { run: vi.fn<CommandRunner["run"]>() };

    const events = await removeHandlingNoise(
      input,
      input,
      output,
      10,
      -50,
      { ...options, enabled: false },
      [],
      runtime,
      runner,
    );

    expect(events).toEqual([]);
    await expect(readFile(output, "utf8")).resolves.toBe("lossless audio fixture");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("copies the input unchanged when analysis finds no removable events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "handling-noise-test-"));
    const input = join(directory, "input.wav");
    const output = join(directory, "output.wav");
    await writeFile(input, "lossless audio fixture");
    const runner = {
      run: vi.fn<CommandRunner["run"]>().mockResolvedValue({ stderr: "", stdout: "" }),
    };

    const events = await removeHandlingNoise(
      input,
      input,
      output,
      10,
      -50,
      options,
      [],
      runtime,
      runner,
    );

    expect(events).toEqual([]);
    await expect(readFile(output, "utf8")).resolves.toBe("lossless audio fixture");
    expect(runner.run).toHaveBeenCalledTimes(1);
  });
});
