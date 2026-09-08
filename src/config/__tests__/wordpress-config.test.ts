import { describe, expect, it } from "vitest";
import { loadWordPressConfig } from "../wordpress-config.js";

describe("loadWordPressConfig", () => {
  it("loads and normalizes WordPress Application Password credentials", async () => {
    await expect(
      loadWordPressConfig({
        directory: "/missing",
        environment: {
          WORDPRESS_APPLICATION_PASSWORD: "app password",
          WORDPRESS_MEDIA_HOST: "PROVCHURCH-MESSAGES.S3.AMAZONAWS.COM",
          WORDPRESS_URL: "https://provchurch.org/",
          WORDPRESS_USERNAME: "nathan",
        },
      }),
    ).resolves.toEqual({
      applicationPassword: "app password",
      mediaHost: "provchurch-messages.s3.amazonaws.com",
      siteUrl: "https://provchurch.org",
      username: "nathan",
    });
  });

  it("rejects a WordPress URL that could expose credentials over plaintext", async () => {
    await expect(
      loadWordPressConfig({
        directory: "/missing",
        environment: {
          WORDPRESS_APPLICATION_PASSWORD: "app password",
          WORDPRESS_MEDIA_HOST: "provchurch-messages.s3.amazonaws.com",
          WORDPRESS_URL: "http://provchurch.org",
          WORDPRESS_USERNAME: "nathan",
        },
      }),
    ).rejects.toThrow("WordPress URL must use HTTPS");
  });
});
