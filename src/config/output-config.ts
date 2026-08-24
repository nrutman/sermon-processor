import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import type { SermonMetadata } from "./schema.js";

const requiredFilenameTokens = ["YYYY", "MM", "DD", "LAST"] as const;

export const outputConfigSchema = z
  .object({
    outputDirectory: z.string().trim().min(1),
    filenameFormat: z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) => !value.includes("/") && !value.includes("\\"),
        "Filename format cannot contain path separators",
      )
      .refine(
        (value) => requiredFilenameTokens.every((token) => value.includes(token)),
        `Filename format must contain ${requiredFilenameTokens.join(", ")}`,
      ),
  })
  .strict();

const defaultOutputConfig = {
  outputDirectory: "~/Downloads",
  filenameFormat: "PCOP-YYYY-MM-DD-LAST",
} as const;

export type OutputConfig = z.infer<typeof outputConfigSchema>;

function expandHomeDirectory(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return resolve(path);
}

function safeFilenameToken(value: string): string {
  const normalized = Array.from(value.normalize("NFKC"))
    .filter((character) => (character.codePointAt(0) ?? 0) >= 32)
    .filter((character) => !'<>:"/\\|?*'.includes(character))
    .join("");
  const sanitized = normalized.replaceAll(/\s+/g, "-").replaceAll(/^\.+|\.+$/g, "");
  if (sanitized.length === 0) {
    throw new Error(`Cannot create a safe filename from ${JSON.stringify(value)}`);
  }
  return sanitized;
}

export async function loadOutputConfig(configPath?: string): Promise<OutputConfig> {
  const path = resolve(configPath ?? "sermon.config.json");
  try {
    return outputConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (
      configPath === undefined &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return outputConfigSchema.parse(defaultOutputConfig);
    }
    throw new Error(`Unable to load output configuration from ${path}`, { cause: error });
  }
}

export function buildConfiguredOutputPath(
  config: OutputConfig,
  metadata: Pick<SermonMetadata, "date" | "preacher">,
): string {
  const [year, month, day] = metadata.date.split("-");
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Cannot build an output filename from date ${metadata.date}`);
  }
  const lastName = metadata.preacher.trim().split(/\s+/).at(-1);
  if (lastName === undefined) {
    throw new Error("Cannot build an output filename without a preacher name");
  }

  const filename = config.filenameFormat
    .replaceAll("YYYY", safeFilenameToken(year))
    .replaceAll("MM", safeFilenameToken(month))
    .replaceAll("DD", safeFilenameToken(day))
    .replaceAll("LAST", safeFilenameToken(lastName));
  const filenameWithExtension = filename.toLowerCase().endsWith(".mp3")
    ? filename
    : `${filename}.mp3`;
  const outputDirectory = expandHomeDirectory(config.outputDirectory);
  const outputPath = join(outputDirectory, filenameWithExtension);

  if (basename(outputPath) !== filenameWithExtension) {
    throw new Error("Configured filename escaped the output directory");
  }
  return outputPath;
}

export const outputConfigInternals = { expandHomeDirectory, safeFilenameToken };
