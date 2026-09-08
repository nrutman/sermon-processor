import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const httpsRequestMock = vi.hoisted(() =>
  vi.fn<
    (
      url: string,
      options: { headers?: Record<string, string | number>; method?: string },
    ) => PassThrough
  >(),
);
vi.mock("node:https", () => ({ request: httpsRequestMock }));

import { WordPressClient } from "../client.js";

afterEach(() => {
  httpsRequestMock.mockReset();
  vi.unstubAllGlobals();
});

describe("WordPressClient", () => {
  it("authenticates JSON requests with the Application Password", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([{ id: 108, name: "Sermon on the Mount" }]), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new WordPressClient({
      applicationPassword: "app-password",
      mediaHost: "media.example.org",
      siteUrl: "https://church.example.org",
      username: "publisher",
    });

    await client.get("sermon-series?slug=sermon-on-the-mount");

    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe(
      "https://church.example.org/wp-json/wp/v2/sermon-series?slug=sermon-on-the-mount",
    );
    expect(new Headers(request?.[1]?.headers).get("Authorization")).toBe(
      `Basic ${Buffer.from("publisher:app-password").toString("base64")}`,
    );
  });

  it("includes WordPress response details in errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('{"message":"not allowed"}', { status: 403 })),
    );
    const client = new WordPressClient({
      applicationPassword: "app-password",
      mediaHost: "media.example.org",
      siteUrl: "https://church.example.org",
      username: "publisher",
    });

    await expect(client.get("sermons")).rejects.toThrow(
      'WordPress request failed (403 ): {"message":"not allowed"}',
    );
  });

  it("sends JSON updates and deletes through the authenticated REST client", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 40 }), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WordPressClient({
      applicationPassword: "app-password",
      mediaHost: "media.example.org",
      siteUrl: "https://church.example.org",
      username: "publisher",
    });

    await expect(client.post("sermons/40", { status: "publish" })).resolves.toEqual({
      id: 40,
    });
    await expect(client.delete("media/50?force=true")).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });

  it("streams media as a browser-compatible multipart upload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordpress-client-test-"));
    const path = join(directory, "sermon.mp3");
    await writeFile(path, "audio-data");
    let body = Buffer.alloc(0);
    let requestOptions: { headers?: Record<string, string | number>; method?: string } = {};
    let requestUrl = "";
    httpsRequestMock.mockImplementation((url, options) => {
      requestUrl = url;
      requestOptions = options;
      const request = new PassThrough();
      request.on("data", (chunk: Buffer) => {
        body = Buffer.concat([body, chunk]);
      });
      request.on("finish", () => {
        const response = Object.assign(new PassThrough(), {
          statusCode: 201,
          statusMessage: "Created",
        });
        queueMicrotask(() => {
          request.emit("response", response);
          response.end(
            JSON.stringify({
              id: 50,
              source_url: "https://media.example.org/wp-content/uploads/sermon.mp3",
            }),
          );
        });
      });
      return request;
    });
    const client = new WordPressClient({
      applicationPassword: "app-password",
      mediaHost: "media.example.org",
      siteUrl: "https://church.example.org",
      username: "publisher",
    });

    await expect(client.uploadMedia(path)).resolves.toMatchObject({ id: 50 });

    expect(requestUrl).toBe("https://church.example.org/wp-json/wp/v2/media");
    expect(requestOptions.method).toBe("POST");
    expect(requestOptions.headers?.["Content-Type"]).toMatch(
      /^multipart\/form-data; boundary=sermon-processor-/,
    );
    expect(body.toString("utf8")).toContain(
      'Content-Disposition: form-data; name="file"; filename="sermon.mp3"',
    );
    expect(body.toString("utf8")).toContain("audio-data");
    expect(requestOptions.headers?.["Content-Length"]).toBe(body.length);
  });

  it("reports media upload connection failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wordpress-client-test-"));
    const path = join(directory, "sermon.mp3");
    await writeFile(path, "audio-data");
    httpsRequestMock.mockImplementation(() => {
      const request = new PassThrough();
      queueMicrotask(() => request.emit("error", new Error("socket closed")));
      return request;
    });
    const client = new WordPressClient({
      applicationPassword: "app-password",
      mediaHost: "media.example.org",
      siteUrl: "https://church.example.org",
      username: "publisher",
    });

    await expect(client.uploadMedia(path)).rejects.toThrow(
      "WordPress media upload failed: socket closed",
    );
  });
});
