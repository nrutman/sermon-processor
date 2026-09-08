import { z } from "zod";
import { loadEnvironmentConfiguration, type EnvironmentLoadOptions } from "./environment.js";

export const wordpressConfigSchema = z
  .object({
    applicationPassword: z.string().trim().min(1),
    mediaHost: z.hostname().trim().toLowerCase(),
    siteUrl: z
      .url()
      .refine((value) => new URL(value).protocol === "https:", "WordPress URL must use HTTPS")
      .transform((value) => value.replace(/\/$/, "")),
    username: z.string().trim().min(1),
  })
  .strict();

const wordpressEnvironmentSchema = z.object({
  WORDPRESS_APPLICATION_PASSWORD: z.string().trim().min(1),
  WORDPRESS_MEDIA_HOST: z.string().trim().min(1),
  WORDPRESS_URL: z.string().trim().min(1),
  WORDPRESS_USERNAME: z.string().trim().min(1),
});

export type WordPressConfig = z.infer<typeof wordpressConfigSchema>;

/** Loads WordPress Application Password credentials for the publishing API. */
export async function loadWordPressConfig(
  options: EnvironmentLoadOptions = {},
): Promise<WordPressConfig> {
  const environment = wordpressEnvironmentSchema.parse(await loadEnvironmentConfiguration(options));
  return wordpressConfigSchema.parse({
    applicationPassword: environment.WORDPRESS_APPLICATION_PASSWORD,
    mediaHost: environment.WORDPRESS_MEDIA_HOST,
    siteUrl: environment.WORDPRESS_URL,
    username: environment.WORDPRESS_USERNAME,
  });
}
