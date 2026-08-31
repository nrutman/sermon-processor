import { join, resolve } from "node:path";
import { config } from "dotenv";

export interface EnvironmentLoadOptions {
  directory?: string;
  environment?: Record<string, string | undefined>;
}

/** Returns merged project configuration with runtime variables taking precedence. */
export async function loadEnvironmentConfiguration(
  options: EnvironmentLoadOptions = {},
): Promise<Record<string, string | undefined>> {
  const directory = resolve(options.directory ?? process.cwd());
  const fileEnvironment: Record<string, string> = {};
  config({
    override: true,
    path: [join(directory, ".env"), join(directory, ".env.local")],
    processEnv: fileEnvironment,
    quiet: true,
  });
  return {
    ...fileEnvironment,
    ...(options.environment ?? process.env),
  };
}
