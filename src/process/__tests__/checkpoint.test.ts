import { mkdtemp, readFile, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn<typeof fs.rename>(fs.rename) };
});
import { processRequestSchema } from "../../config/schema.js";
import { readCheckpoint, writeCheckpoint, type Preparation } from "../checkpoint.js";
let directory: string;
let checkpoint: string;
const noise = {
  noiseFloorDb: -60,
  pauseThresholdDb: -48,
  silenceThresholdDb: -54,
  usedFallback: false,
  sampledIntervals: [],
  silenceIntervals: [],
};
const preparation: Preparation = {
  noiseBeforeDenoising: noise,
  noiseAfterDenoising: noise,
  handlingNoise: [],
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "checkpoint-test-"));
  const request = processRequestSchema.parse({
    input: join(directory, "source.aiff"),
    artwork: join(directory, "art.png"),
    output: join(directory, "out.mp3"),
    metadata: {
      organization: "Church",
      preacher: "Alice Smith",
      sermonSeries: "Series",
      date: "2026-11-01",
      scripture: "2 Corinthians 4:1–6",
    },
  });
  await Promise.all([
    writeFile(request.input, "source"),
    writeFile(request.artwork, "art"),
    writeFile(join(directory, "05-premaster.wav"), "PCM"),
  ]);
  checkpoint = await writeCheckpoint({
    request,
    preparation,
    workDirectory: directory,
    elapsedSeconds: 12,
    stages: [{ stage: "Repair and denoise", durationSeconds: 5 }],
  });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
describe("lossless processing checkpoints", () => {
  it("preserves the previous readable checkpoint when atomic replacement fails", async () => {
    const original = await readCheckpoint(checkpoint);
    vi.mocked(rename).mockRejectedValueOnce(new Error("Disk error"));
    await expect(writeCheckpoint(original)).rejects.toThrow("Disk error");
    expect(await readCheckpoint(checkpoint)).toEqual(original);
  });
  it("retains original edit audit, request, and timings", async () => {
    const restored = await readCheckpoint(checkpoint);
    expect({
      preparation: restored.preparation,
      elapsed: restored.elapsedSeconds,
      stages: restored.stages,
    }).toEqual({
      preparation,
      elapsed: 12,
      stages: [{ stage: "Repair and denoise", durationSeconds: 5 }],
    });
  });
  it.each(["source.aiff", "art.png", "05-premaster.wav"])(
    "refuses changed %s bytes",
    async (file) => {
      await writeFile(join(directory, file), "changed");
      await expect(readCheckpoint(checkpoint)).rejects.toThrow("inputs changed");
    },
  );
  it("rejects a malformed checkpoint before using its paths", async () => {
    const data = JSON.parse(await readFile(checkpoint, "utf8"));
    data.request.metadata.date = "not-a-date";
    await writeFile(checkpoint, JSON.stringify(data));
    await expect(readCheckpoint(checkpoint)).rejects.toThrow("ISO date");
  });
});
