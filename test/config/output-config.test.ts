import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildConfiguredOutputPath,
  loadOutputConfig,
  outputConfigSchema,
} from "../../src/config/output-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("output configuration", () => {
  it("builds the Providence Church filename in Downloads", () => {
    const output = buildConfiguredOutputPath(
      outputConfigSchema.parse({
        outputDirectory: "~/Downloads",
        filenameFormat: "PCOP-YYYY-MM-DD-LAST",
      }),
      { date: "2026-08-23", preacher: "Rob Ivy" },
    );

    expect(output).toBe(join(homedir(), "Downloads", "PCOP-2026-08-23-Ivy.mp3"));
  });

  it("loads a custom configuration file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sermon-config-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "custom.json");
    await writeFile(
      configPath,
      JSON.stringify({
        outputDirectory: directory,
        filenameFormat: "Sermon-YYYY-MM-DD-LAST.mp3",
      }),
    );

    await expect(loadOutputConfig(configPath)).resolves.toEqual({
      outputDirectory: directory,
      filenameFormat: "Sermon-YYYY-MM-DD-LAST.mp3",
    });
  });

  it("rejects formats that omit required naming tokens", () => {
    expect(() =>
      outputConfigSchema.parse({
        outputDirectory: "~/Downloads",
        filenameFormat: "sermon-LAST",
      }),
    ).toThrow("Filename format must contain");
  });
});
