import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadTranscriptionConfig } from "../transcription-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("transcription configuration", () => {
  it("stays disabled until a model is explicitly configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "transcription-config-"));
    temporaryDirectories.push(directory);
    await expect(loadTranscriptionConfig({ directory, environment: {} })).resolves.toBeUndefined();
  });

  it("loads a readable model and an optional command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "transcription-config-"));
    temporaryDirectories.push(directory);
    const modelPath = join(directory, "ggml-base.en.bin");
    const vadModelPath = join(directory, "ggml-silero-v6.2.0.bin");
    await Promise.all([writeFile(modelPath, "model"), writeFile(vadModelPath, "model")]);

    await expect(
      loadTranscriptionConfig({
        environment: {
          WHISPER_CLI_PATH: "/opt/whisper-cli",
          WHISPER_MODEL_PATH: modelPath,
          WHISPER_VAD_MODEL_PATH: vadModelPath,
        },
      }),
    ).resolves.toEqual({ command: "/opt/whisper-cli", modelPath, vadModelPath });
  });

  it("rejects a partial Whisper configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "transcription-config-"));
    temporaryDirectories.push(directory);
    await expect(
      loadTranscriptionConfig({
        directory,
        environment: { WHISPER_MODEL_PATH: "/models/whisper.bin" },
      }),
    ).rejects.toThrow("WHISPER_MODEL_PATH and WHISPER_VAD_MODEL_PATH");
  });
});
