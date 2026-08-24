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

  it("lets .env.local override the committed .env template", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sermon-config-"));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, ".env"),
      "SERMON_OUTPUT_DIRECTORY=/template\nSERMON_FILENAME_FORMAT=Template-YYYY-MM-DD-LAST\n",
    );
    await writeFile(
      join(directory, ".env.local"),
      `SERMON_OUTPUT_DIRECTORY=${directory}\nSERMON_FILENAME_FORMAT=Sermon-YYYY-MM-DD-LAST.mp3\n`,
    );

    await expect(loadOutputConfig({ directory, environment: {} })).resolves.toEqual({
      outputDirectory: directory,
      filenameFormat: "Sermon-YYYY-MM-DD-LAST.mp3",
    });
  });

  it("lets runtime environment variables override env files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sermon-config-"));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, ".env.local"),
      "SERMON_OUTPUT_DIRECTORY=/local\nSERMON_FILENAME_FORMAT=Local-YYYY-MM-DD-LAST\n",
    );

    await expect(
      loadOutputConfig({
        directory,
        environment: {
          SERMON_OUTPUT_DIRECTORY: "/runtime",
          SERMON_FILENAME_FORMAT: "Runtime-YYYY-MM-DD-LAST",
        },
      }),
    ).resolves.toEqual({
      outputDirectory: "/runtime",
      filenameFormat: "Runtime-YYYY-MM-DD-LAST",
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
