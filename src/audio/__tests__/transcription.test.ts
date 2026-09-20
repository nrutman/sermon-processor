import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { processingOptionsSchema } from "../../config/schema.js";
import type { CommandRunner } from "../../process/run-command.js";
import {
  classifyTranscriptGaps,
  parseWhisperWords,
  transcribeAndShortenGaps,
  transcriptionInternals,
  type TranscriptWord,
} from "../transcription.js";
import type { AudioRuntime } from "../runtime.js";

const options = processingOptionsSchema.parse({}).transcription;
const runtime: AudioRuntime = {
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  ffmpegVersion: "test",
  ffprobeVersion: "test",
};

function word(text: string, startSeconds: number, endSeconds: number): TranscriptWord {
  return { text, startSeconds, endSeconds, confidence: 0.9 };
}

describe("transcription-assisted non-speech detection", () => {
  it("parses lexical tokens with valid timestamps and preserves confidence", () => {
    const output = JSON.stringify({
      transcription: [
        {
          offsets: { from: 0, to: 1_000 },
          tokens: [
            { text: "[_BEG_]", p: 0.99, offsets: { from: 0, to: 0 } },
            { text: " Grace", p: 0.95, offsets: { from: 100, to: 500 } },
            { text: ",", p: 0.99, offsets: { from: 500, to: 600 } },
            { text: " uncertain", p: 0.2, offsets: { from: 600, to: 900 } },
            { text: " broken", p: 0.9, offsets: { from: 1_000, to: 900 } },
          ],
        },
      ],
    });

    expect(parseWhisperWords(output)).toEqual([
      { text: "Grace", confidence: 0.95, startSeconds: 0, endSeconds: 0.4 },
      { text: "uncertain", confidence: 0.2, startSeconds: 0.5, endSeconds: 0.8 },
    ]);
  });

  it("maps VAD-compacted token timestamps back to the original recording", () => {
    const output = JSON.stringify({
      transcription: [
        {
          offsets: { from: 24_500, to: 29_220 },
          tokens: [
            { text: " First", p: 0.9, offsets: { from: 11_720, to: 11_880 } },
            { text: " Samuel", p: 0.9, offsets: { from: 11_880, to: 12_120 } },
          ],
        },
      ],
    });

    expect(parseWhisperWords(output)).toEqual([
      { text: "First", confidence: 0.9, startSeconds: 24.5, endSeconds: 24.66 },
      { text: "Samuel", confidence: 0.9, startSeconds: 24.66, endSeconds: 24.9 },
    ]);
  });

  it("shortens a bounded transcript gap only when VAD also finds no speech", () => {
    const words = [word("before", 0, 0.5), word("after", 4, 4.5)];

    expect(classifyTranscriptGaps(words, [], options)).toEqual([
      expect.objectContaining({ action: "shortened", startSeconds: 0.5, endSeconds: 4 }),
    ]);
    expect(classifyTranscriptGaps(words, [{ startSeconds: 2, endSeconds: 2.5 }], options)).toEqual([
      expect.objectContaining({
        action: "reported",
        reason: expect.stringContaining("Silero VAD detected possible speech overlap"),
      }),
    ]);
  });

  it("reports unusually long transcript gaps instead of automatically shortening them", () => {
    const words = [word("before", 0, 0.5), word("after", 35, 35.5)];

    expect(classifyTranscriptGaps(words, [], options)).toEqual([
      expect.objectContaining({
        action: "reported",
        reason: "Transcript gap exceeds the 30.0 second automatic limit",
      }),
    ]);
  });

  it("reports a gap containing a low-confidence word instead of deleting ambiguous speech", () => {
    const words = [
      word("before", 0, 0.5),
      { ...word("maybe", 2, 2.5), confidence: 0.2 },
      word("after", 4, 4.5),
    ];

    expect(classifyTranscriptGaps(words, [], options)).toEqual([
      expect.objectContaining({
        action: "reported",
        reason: 'Whisper produced a low-confidence word ("maybe", confidence 0.200)',
      }),
    ]);
  });

  it("keeps a natural pause around a shortened gap", () => {
    const filter = transcriptionInternals.buildGapShorteningFilter(
      10,
      [{ action: "shortened", startSeconds: 2, endSeconds: 6, durationSeconds: 4 }],
      0.4,
      0.03,
    );

    expect(filter).toContain("atrim=start=0.000:end=2.200");
    expect(filter).toContain("atrim=start=5.800:end=10.000");
    expect(filter).toContain("acrossfade=d=0.030");
  });

  it("runs Whisper, shortens a confirmed gap, and records the tool contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "transcription-test-"));
    const analysisInput = join(directory, "analysis.wav");
    const renderInput = join(directory, "render.wav");
    const output = join(directory, "output.wav");
    const outputPrefix = join(directory, "transcript");
    await Promise.all([writeFile(analysisInput, "analysis"), writeFile(renderInput, "render")]);
    const calls: Array<{ arguments_: readonly string[]; command: string }> = [];
    const runner: CommandRunner = {
      async run(command, arguments_) {
        calls.push({ command, arguments_ });
        if (arguments_.includes("--version")) {
          return { stdout: "whisper.cpp version: 1.9.4", stderr: "" };
        }
        if (arguments_.includes("-ojf")) {
          await writeFile(
            `${outputPrefix}.json`,
            JSON.stringify({
              result: { language: "en" },
              transcription: [
                {
                  tokens: [
                    { text: " before", p: 0.9, offsets: { from: 0, to: 500 } },
                    { text: " after", p: 0.9, offsets: { from: 4_000, to: 4_500 } },
                  ],
                },
              ],
            }),
          );
        }
        return { stdout: "", stderr: "" };
      },
    };

    const analysis = await transcribeAndShortenGaps(
      analysisInput,
      renderInput,
      output,
      outputPrefix,
      10,
      [],
      {
        ...options,
        enabled: true,
        command: "whisper-cli",
        modelPath: "/models/ggml-base.en.bin",
        vadModelPath: "/models/ggml-silero-v6.2.0.bin",
      },
      runtime,
      runner,
    );

    expect(analysis).toMatchObject({
      language: "en",
      model: "ggml-base.en.bin",
      toolVersion: "1.9.4",
      vadModel: "ggml-silero-v6.2.0.bin",
      gaps: [expect.objectContaining({ action: "shortened" })],
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "whisper-cli",
          arguments_: expect.arrayContaining(["-ojf", "--vad", "-vm"]),
        }),
        expect.objectContaining({
          command: "ffmpeg",
          arguments_: expect.arrayContaining(["-filter_complex"]),
        }),
      ]),
    );
  });

  it("reuses the lossless input when transcription is disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "transcription-test-"));
    const input = join(directory, "input.wav");
    const output = join(directory, "output.wav");
    await writeFile(input, "lossless audio fixture");
    const runner = { run: vi.fn<CommandRunner["run"]>() };

    await expect(
      transcribeAndShortenGaps(
        input,
        input,
        output,
        join(directory, "transcript"),
        10,
        [],
        options,
        runtime,
        runner,
      ),
    ).resolves.toBeUndefined();
    await expect(readFile(output, "utf8")).resolves.toBe("lossless audio fixture");
    expect(runner.run).not.toHaveBeenCalled();
  });
});
