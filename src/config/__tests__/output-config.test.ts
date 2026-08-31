import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildConfiguredOutputPath,
  loadSermonConfig,
  sermonConfigSchema,
} from "../output-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("output configuration", () => {
  it("builds a configured sermon filename in Downloads", () => {
    const output = buildConfiguredOutputPath(
      sermonConfigSchema.parse({
        organization: "Example Organization",
        outputDirectory: "~/Downloads",
        filenameFormat: "SERMON-YYYY-MM-DD-LAST",
      }),
      { date: "2026-08-23", preacher: "Rob Ivy" },
    );

    expect(output).toBe(join(homedir(), "Downloads", "SERMON-2026-08-23-Ivy.mp3"));
  });

  it("lets .env.local override the committed .env template", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sermon-config-"));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, ".env"),
      "SERMON_ORGANIZATION=Template Organization\nSERMON_OUTPUT_DIRECTORY=/template\nSERMON_FILENAME_FORMAT=Template-YYYY-MM-DD-LAST\n",
    );
    await writeFile(
      join(directory, ".env.local"),
      `SERMON_ORGANIZATION=Local Organization\nSERMON_OUTPUT_DIRECTORY=${directory}\nSERMON_FILENAME_FORMAT=Sermon-YYYY-MM-DD-LAST.mp3\n`,
    );

    await expect(loadSermonConfig({ directory, environment: {} })).resolves.toEqual({
      organization: "Local Organization",
      outputDirectory: directory,
      filenameFormat: "Sermon-YYYY-MM-DD-LAST.mp3",
    });
  });

  it("lets runtime environment variables override env files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sermon-config-"));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, ".env.local"),
      "SERMON_ORGANIZATION=Local Organization\nSERMON_OUTPUT_DIRECTORY=/local\nSERMON_FILENAME_FORMAT=Local-YYYY-MM-DD-LAST\n",
    );

    await expect(
      loadSermonConfig({
        directory,
        environment: {
          SERMON_ORGANIZATION: "Runtime Organization",
          SERMON_OUTPUT_DIRECTORY: "/runtime",
          SERMON_FILENAME_FORMAT: "Runtime-YYYY-MM-DD-LAST",
        },
      }),
    ).resolves.toEqual({
      organization: "Runtime Organization",
      outputDirectory: "/runtime",
      filenameFormat: "Runtime-YYYY-MM-DD-LAST",
    });
  });

  it("rejects formats that omit required naming tokens", () => {
    expect(() =>
      sermonConfigSchema.parse({
        organization: "Example Organization",
        outputDirectory: "~/Downloads",
        filenameFormat: "sermon-LAST",
      }),
    ).toThrow("Filename format must contain");
  });
});
