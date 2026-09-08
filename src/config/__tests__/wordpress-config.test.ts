import { describe, expect, it } from "vitest";
import { loadWordPressConfig } from "../wordpress-config.js";

describe("loadWordPressConfig", () => {
  it("loads and normalizes WordPress Application Password credentials", async () => {
    await expect(
      loadWordPressConfig({
        directory: "/missing",
        environment: {
          WORDPRESS_APPLICATION_PASSWORD: "app password",
          WORDPRESS_MEDIA_HOST: "MEDIA.EXAMPLE.ORG",
          WORDPRESS_URL: "https://church.example.org/",
          WORDPRESS_USERNAME: "publisher",
        },
      }),
    ).resolves.toEqual({
      applicationPassword: "app password",
      mediaHost: "media.example.org",
      siteUrl: "https://church.example.org",
      username: "publisher",
    });
  });

  it("rejects a WordPress URL that could expose credentials over plaintext", async () => {
    await expect(
      loadWordPressConfig({
        directory: "/missing",
        environment: {
          WORDPRESS_APPLICATION_PASSWORD: "app password",
          WORDPRESS_MEDIA_HOST: "media.example.org",
          WORDPRESS_URL: "http://church.example.org",
          WORDPRESS_USERNAME: "publisher",
        },
      }),
    ).rejects.toThrow("WordPress URL must use HTTPS");
  });
});
