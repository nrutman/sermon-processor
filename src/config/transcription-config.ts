import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { loadEnvironmentConfiguration, type EnvironmentLoadOptions } from "./environment.js";

export interface TranscriptionConfig {
  command: string;
  modelPath: string;
  vadModelPath: string;
}

/** Returns local Whisper configuration when a model has been explicitly configured. */
export async function loadTranscriptionConfig(
  options: EnvironmentLoadOptions = {},
): Promise<TranscriptionConfig | undefined> {
  const environment = await loadEnvironmentConfiguration(options);
  const configuredModelPath = environment.WHISPER_MODEL_PATH?.trim();
  const configuredVadModelPath = environment.WHISPER_VAD_MODEL_PATH?.trim();
  if (!configuredModelPath && !configuredVadModelPath) return undefined;
  if (!configuredModelPath || !configuredVadModelPath) {
    throw new Error(
      "WHISPER_MODEL_PATH and WHISPER_VAD_MODEL_PATH must both be configured to enable transcription",
    );
  }

  const modelPath = resolve(configuredModelPath.replace(/^~(?=\/)/, environment.HOME ?? "~"));
  const vadModelPath = resolve(configuredVadModelPath.replace(/^~(?=\/)/, environment.HOME ?? "~"));
  await Promise.all([access(modelPath, constants.R_OK), access(vadModelPath, constants.R_OK)]);
  return {
    command: environment.WHISPER_CLI_PATH?.trim() || "whisper-cli",
    modelPath,
    vadModelPath,
  };
}
