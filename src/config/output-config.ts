import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parse } from "dotenv";
import { z } from "zod";
import type { SermonMetadata } from "./schema.js";

const requiredFilenameTokens = ["YYYY", "MM", "DD", "LAST"] as const;

export const sermonConfigSchema = z
  .object({
    organization: z.string().trim().min(1),
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

const outputEnvironmentSchema = z.object({
  SERMON_ORGANIZATION: z.string().trim().min(1),
  SERMON_OUTPUT_DIRECTORY: z.string().trim().min(1),
  SERMON_FILENAME_FORMAT: z.string().trim().min(1),
});

export type SermonConfig = z.infer<typeof sermonConfigSchema>;

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

async function parseEnvFile(path: string): Promise<Record<string, string>> {
  try {
    return parse(await readFile(path));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to load environment configuration from ${path}`, { cause: error });
  }
}

interface LoadSermonConfigOptions {
  directory?: string;
  environment?: Record<string, string | undefined>;
}

export async function loadSermonConfig(
  options: LoadSermonConfigOptions = {},
): Promise<SermonConfig> {
  const directory = resolve(options.directory ?? process.cwd());
  const [template, local] = await Promise.all([
    parseEnvFile(join(directory, ".env")),
    parseEnvFile(join(directory, ".env.local")),
  ]);
  const environment = outputEnvironmentSchema.parse({
    ...template,
    ...local,
    ...(options.environment ?? process.env),
  });
  return sermonConfigSchema.parse({
    organization: environment.SERMON_ORGANIZATION,
    outputDirectory: environment.SERMON_OUTPUT_DIRECTORY,
    filenameFormat: environment.SERMON_FILENAME_FORMAT,
  });
}

export function buildConfiguredOutputPath(
  config: SermonConfig,
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
