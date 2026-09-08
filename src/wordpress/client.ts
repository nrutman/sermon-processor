import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { basename } from "node:path";
import type { WordPressConfig } from "../config/wordpress-config.js";

export interface WordPressApi {
  delete(path: string): Promise<void>;
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  uploadMedia(path: string): Promise<unknown>;
}

export class WordPressClient implements WordPressApi {
  private readonly authorization: string;
  private readonly baseUrl: string;

  constructor(config: WordPressConfig) {
    this.authorization = `Basic ${Buffer.from(`${config.username}:${config.applicationPassword}`).toString("base64")}`;
    this.baseUrl = `${config.siteUrl}/wp-json/wp/v2`;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", this.authorization);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/${path.replace(/^\//, "")}`, {
        ...init,
        headers,
      });
    } catch (error) {
      const detail =
        error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
      throw new Error(
        `WordPress request failed before receiving a response${detail ? `: ${detail}` : ""}`,
        {
          cause: error,
        },
      );
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `WordPress request failed (${response.status} ${response.statusText}): ${detail}`,
      );
    }
    if (response.status === 204) {
      return undefined;
    }
    return response.json();
  }

  get(path: string): Promise<unknown> {
    return this.request(path);
  }

  post(path: string, body: unknown): Promise<unknown> {
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async uploadMedia(path: string): Promise<unknown> {
    const { size } = await stat(path);
    const filename = basename(path).replaceAll(/["\r\n]/g, "");
    const boundary = `sermon-processor-${randomBytes(16).toString("hex")}`;
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/mpeg\r\n\r\n`,
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    return new Promise((resolvePromise, reject) => {
      const request = httpsRequest(`${this.baseUrl}/media`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: this.authorization,
          "Content-Length": prefix.length + size + suffix.length,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
      });
      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const detail = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            reject(
              new Error(
                `WordPress request failed (${response.statusCode ?? 0} ${response.statusMessage ?? ""}): ${detail}`,
              ),
            );
            return;
          }
          try {
            resolvePromise(JSON.parse(detail));
          } catch (error) {
            reject(new Error("WordPress media upload returned invalid JSON", { cause: error }));
          }
        });
      });
      request.on("error", (error) => {
        reject(new Error(`WordPress media upload failed: ${error.message}`, { cause: error }));
      });
      request.write(prefix);
      const stream = createReadStream(path);
      stream.on("error", (error) => request.destroy(error));
      stream.on("end", () => request.end(suffix));
      stream.pipe(request, { end: false });
    });
  }

  async delete(path: string): Promise<void> {
    await this.request(path, { method: "DELETE" });
  }
}
