import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "dotenv";

export interface EnvironmentLoadOptions {
  directory?: string;
  environment?: Record<string, string | undefined>;
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

/** Returns merged project configuration with runtime variables taking precedence. */
export async function loadEnvironmentConfiguration(
  options: EnvironmentLoadOptions = {},
): Promise<Record<string, string | undefined>> {
  const directory = resolve(options.directory ?? process.cwd());
  const [template, local] = await Promise.all([
    parseEnvFile(join(directory, ".env")),
    parseEnvFile(join(directory, ".env.local")),
  ]);
  return {
    ...template,
    ...local,
    ...(options.environment ?? process.env),
  };
}
