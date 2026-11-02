import { access, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createHash } from "node:crypto";
import { buildMp3Metadata } from "../../metadata/sermon-metadata.js";
import type { WordPressApi } from "../client.js";
import {
  cleanupPublication,
  draftPublication,
  finishPublication,
  planPublication,
  reconcilePublication,
  type PublicationInput,
} from "../publication.js";

const config = {
  siteUrl: "https://church.example.org",
  mediaHost: "media.example.org",
  username: "test",
  applicationPassword: "secret",
};
const mediaUrl = "https://media.example.org/wp-content/uploads/sermon.mp3";
const metadata = {
  organization: "Church",
  preacher: "Alice Smith",
  sermonSeries: "Example Series",
  date: "2026-11-01",
  scripture: "2 Corinthians 4:1–6",
  title: "Gospel",
};
let directory: string;
let path: string;
let request: PublicationInput;
let post: Record<string, unknown> | undefined;
let timezone = "America/New_York";
let remoteBody = "audio";
let localStatus = 404;
let publicStatus = 200;
let orphan = false;
let losePublishResponse = false;
let seriesPosts: unknown[] | undefined;
let api: WordPressApi & {
  get: ReturnType<typeof vi.fn<WordPressApi["get"]>>;
  post: ReturnType<typeof vi.fn<WordPressApi["post"]>>;
  uploadMedia: ReturnType<typeof vi.fn<WordPressApi["uploadMedia"]>>;
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "publication-test-"));
  path = join(directory, "receipt.json");
  request = {
    input: join(directory, "sermon.mp3"),
    qcReport: join(directory, "sermon.qc.json"),
    metadata,
  };
  await writeFile(request.input, "audio");
  await writeFile(
    request.qcReport,
    JSON.stringify({
      metadata: buildMp3Metadata(metadata),
      output: {
        path: request.input,
        codec: "mp3",
        bitrateKbps: 64,
        durationSeconds: 2107.9,
        sha256: createHash("sha256").update("audio").digest("hex"),
      },
      loudness: {
        output: { inputI: -16, inputTp: -2, inputLra: 3, inputThreshold: -26, targetOffset: 0 },
      },
    }),
  );
  post = undefined;
  timezone = "America/New_York";
  remoteBody = "audio";
  localStatus = 404;
  publicStatus = 200;
  orphan = false;
  losePublishResponse = false;
  seriesPosts = undefined;
  api = {
    get: vi.fn<WordPressApi["get"]>(async (resource: string) => {
      if (resource === "settings") return { timezone };
      if (resource.startsWith("sermons?context=edit&status=")) return post ? [post] : [];
      if (resource.startsWith("sermon-speakers?"))
        return [{ id: 10, name: "Alice Smith", slug: "alice-smith" }];
      if (resource.startsWith("sermon-series?"))
        return [{ id: 20, name: "Example Series", slug: "example-series" }];
      if (resource.startsWith("sermons?context=edit&sermon-series="))
        return (
          seriesPosts ?? [
            {
              id: 35,
              date: "2026-10-25T12:00:00",
              featured_media: 30,
              link: "https://church.example.org/prior",
              status: "publish",
              title: { raw: "Prior" },
            },
          ]
        );
      if (resource === "media/30?context=edit") return { id: 30 };
      if (resource === "media/31?context=edit")
        return {
          id: 31,
          post: 40,
          source_url: "https://media.example.org/wp-content/uploads/art.png",
        };
      if (resource.startsWith("media?"))
        return post || orphan ? [{ id: 50, post: post ? 40 : 0, source_url: mediaUrl }] : [];
      if (resource === "sermons/40?context=edit") return post;
      if (resource === "media/50?context=edit") return { id: 50, post: 40, source_url: mediaUrl };
      throw new Error(`Unexpected GET ${resource}`);
    }),
    post: vi.fn<WordPressApi["post"]>(async (resource: string, body: unknown) => {
      if (resource === "sermons") {
        const payload = z.record(z.string(), z.unknown()).parse(body);
        post = {
          ...payload,
          id: 40,
          date_gmt: "2026-11-01T17:00:00",
          link: "https://church.example.org/sermons/gospel",
          title: { raw: payload.title, rendered: payload.title },
        };
        return post;
      }
      if (resource === "sermons/40") {
        Object.assign(post!, body);
        if (losePublishResponse) throw new Error("Response lost");
        return post;
      }
      if (resource === "media/50") return { id: 50 };
      if (resource === "media/31") return { id: 31 };
      throw new Error(`Unexpected POST ${resource}`);
    }),
    uploadMedia: vi.fn<WordPressApi["uploadMedia"]>(async (_input, type) =>
      type?.startsWith("image/")
        ? { id: 31, source_url: "https://media.example.org/wp-content/uploads/art.png" }
        : { id: 50, source_url: mediaUrl },
    ),
    delete: vi.fn<WordPressApi["delete"]>(async () => undefined),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === mediaUrl) return new Response(remoteBody, { status: 200 });
      if (url === "https://church.example.org/wp-content/uploads/sermon.mp3")
        return new Response(null, { status: localStatus });
      if (url === "https://church.example.org/sermons/gospel")
        return new Response("<h1>Gospel</h1>", { status: publicStatus });
      throw new Error(`Unexpected fetch ${url}`);
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
async function planned() {
  return planPublication(request, path, config, api);
}
async function drafted() {
  await planned();
  return draftPublication(path, config, api);
}

describe("receipt publication lifecycle", () => {
  it("rejects unsupported scripture during read-only planning", async () => {
    request.metadata = { ...metadata, scripture: "John 3:16" };
    await expect(planned()).rejects.toThrow("requires one verse range");
    expect(api.uploadMedia).not.toHaveBeenCalled();
  });
  it("handles an exactly-full final WordPress page without hiding other errors", async () => {
    const read = api.get;
    api.get = vi.fn<WordPressApi["get"]>(async (resource) => {
      if (resource.startsWith("sermons?context=edit&sermon-series=")) {
        if (resource.endsWith("page=2"))
          throw new Error(
            'WordPress request failed (400 Bad Request): {"code":"rest_post_invalid_page_number"}',
          );
        return Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          date: "2026-10-25T12:00:00",
          featured_media: 30,
          link: "https://church.example.org/prior",
          status: "publish",
          title: { raw: "Prior" },
        }));
      }
      return read(resource);
    });
    expect((await planned()).artworkId).toBe(30);
  });
  it("drafts using the artwork approved in its plan even if Series artwork changes", async () => {
    await planned();
    seriesPosts = [
      {
        id: 35,
        date: "2026-10-25T12:00:00",
        featured_media: 99,
        link: "https://church.example.org/prior",
        status: "publish",
        title: { raw: "Prior" },
      },
    ];
    expect((await draftPublication(path, config, api)).artworkId).toBe(30);
    expect(post?.featured_media).toBe(30);
  });
  it("uses approved artwork beyond the latest twenty Series posts", async () => {
    seriesPosts = Array.from({ length: 21 }, (_, i) => ({
      id: i + 1,
      date: "2026-10-25T12:00:00",
      featured_media: i === 20 ? 30 : 0,
      link: "https://church.example.org/prior",
      status: "publish",
      title: { raw: "Prior" },
    }));
    await planned();
    seriesPosts = seriesPosts.slice(0, 20);
    expect((await draftPublication(path, config, api)).artworkId).toBe(30);
  });
  it("recovers uploaded artwork identity from the journal when adopting an interrupted first-Series draft", async () => {
    seriesPosts = [];
    request.artwork = join(directory, "art.png");
    await writeFile(request.artwork, "art");
    await planned();
    const draft = await draftPublication(path, config, api);
    const interrupted = {
      ...draft,
      state: "mutating",
      artworkId: 0,
      postId: undefined,
      mediaId: undefined,
      mediaUrl: undefined,
    };
    await writeFile(path, JSON.stringify(interrupted));
    expect(await reconcilePublication(path, config, api, 40)).toMatchObject({
      state: "draft",
      artworkId: 31,
    });
  });
  it("plans exact mapped payload without remote mutations or credentials in its receipt", async () => {
    const plan = await planned();
    expect({
      state: plan.state,
      speaker: plan.speaker.id,
      series: plan.series.id,
      artwork: plan.artworkId,
    }).toEqual({ state: "planned", speaker: 10, series: 20, artwork: 30 });
    expect(api.post).not.toHaveBeenCalled();
    expect(api.uploadMedia).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).not.toContain("secret");
  });
  it("creates a draft, publishes the same post at Eastern noon, and never reuploads on retry", async () => {
    await drafted();
    await finishPublication(path, config, api, true);
    const result = await finishPublication(path, config, api, true);
    expect({ state: result.state, id: result.postId }).toEqual({ state: "published", id: 40 });
    expect(api.post).toHaveBeenCalledWith("sermons/40", {
      status: "publish",
      date: "2026-11-01T12:00:00",
    });
    expect(api.uploadMedia).toHaveBeenCalledTimes(1);
    expect(api.post.mock.calls.filter(([p]) => p === "sermons/40")).toHaveLength(1);
  });
  it("verification does not publish without approval", async () => {
    await drafted();
    const result = await finishPublication(path, config, api);
    expect(result.state).toBe("draft");
    expect(post?.status).toBe("draft");
  });
  it("refuses changed local audio before remote mutation", async () => {
    await planned();
    await writeFile(request.input, "replacement");
    await expect(draftPublication(path, config, api)).rejects.toThrow("files changed");
    expect(api.uploadMedia).not.toHaveBeenCalled();
  });
  it("rejects MP3 bytes that no longer match their QC before planning", async () => {
    await writeFile(request.input, "replacement");
    await expect(planned()).rejects.toThrow("QC fingerprint");
    expect(api.post).not.toHaveBeenCalled();
  });
  it("refuses possible orphan media before creating a new plan", async () => {
    orphan = true;
    await expect(planned()).rejects.toThrow("orphan");
    expect(api.uploadMedia).not.toHaveBeenCalled();
  });
  it("refuses duplicate dates including trashed posts without uploading", async () => {
    post = { status: "trash" };
    await expect(planned()).rejects.toThrow("including drafts/trash");
    expect(api.uploadMedia).not.toHaveBeenCalled();
  });
  it("refuses an overwritten receipt", async () => {
    await planned();
    await expect(planned()).rejects.toThrow("EEXIST");
    expect(api.uploadMedia).not.toHaveBeenCalled();
  });
  it.each(["UTC", "America/Chicago"])("refuses non-Eastern site timezone %s", async (zone) => {
    timezone = zone;
    await expect(planned()).rejects.toThrow("America/New_York");
    expect(api.post).not.toHaveBeenCalled();
  });
  it("refuses a second draft attempt after a remote verification failure", async () => {
    await planned();
    remoteBody = "wrong";
    await expect(draftPublication(path, config, api)).rejects.toThrow("differs");
    await expect(draftPublication(path, config, api)).rejects.toThrow("already used");
    expect(api.uploadMedia).toHaveBeenCalledTimes(1);
  });
  it("reconciles a failed draft read-only, then adopts an explicitly selected verified post", async () => {
    await planned();
    remoteBody = "wrong";
    await expect(draftPublication(path, config, api)).rejects.toThrow("differs");
    remoteBody = "audio";
    const count = api.post.mock.calls.length;
    expect(await reconcilePublication(path, config, api)).toMatchObject({ state: "failed" });
    expect(await reconcilePublication(path, config, api, 40)).toMatchObject({
      state: "draft",
      postId: 40,
    });
    expect(api.post.mock.calls.length).toBe(count);
  });
  it("handles a lost publish response by verifying existing publication on retry", async () => {
    await drafted();
    losePublishResponse = true;
    await expect(finishPublication(path, config, api, true)).rejects.toThrow("Response lost");
    const recovered = await finishPublication(path, config, api, true);
    expect(recovered.state).toBe("published");
    expect(api.uploadMedia).toHaveBeenCalledTimes(1);
  });
  it.each([
    {
      name: "remote bytes",
      message: "differs",
      change: () => {
        remoteBody = "wrong";
      },
    },
    {
      name: "local upload path",
      message: "Local upload path",
      change: () => {
        localStatus = 200;
      },
    },
  ])("blocks publication when $name verification fails", async ({ change, message }) => {
    await drafted();
    change();
    await expect(finishPublication(path, config, api, true)).rejects.toThrow(message);
    expect(post?.status).toBe("draft");
  });
  it("preserves local MP3 when public page verification fails after publishing", async () => {
    await drafted();
    publicStatus = 503;
    await expect(finishPublication(path, config, api, true)).rejects.toThrow("Public page");
    await expect(access(request.input)).resolves.toBeUndefined();
  });
  it("cleans up only verified published MP3 and supports verification/cleanup retry afterward", async () => {
    await drafted();
    await finishPublication(path, config, api, true);
    await cleanupPublication(path, config, api);
    await expect(access(request.input)).rejects.toThrow("ENOENT");
    await expect(access(request.qcReport)).resolves.toBeUndefined();
    expect((await finishPublication(path, config, api)).state).toBe("published");
    expect((await cleanupPublication(path, config, api)).localAudioRemoved).toBe(true);
  });
  it("never cleans up a draft", async () => {
    await drafted();
    await expect(cleanupPublication(path, config, api)).rejects.toThrow("unpublished");
    await expect(access(request.input)).resolves.toBeUndefined();
  });
  it("finishes cleanup interrupted after unlink without needing the deleted MP3", async () => {
    await drafted();
    const receipt = await finishPublication(path, config, api, true);
    receipt.journal.push({ action: "CLEANUP", phase: "intent" });
    await writeFile(path, JSON.stringify(receipt));
    await unlink(request.input);
    expect((await cleanupPublication(path, config, api)).localAudioRemoved).toBe(true);
    await expect(access(request.qcReport)).resolves.toBeUndefined();
  });
  it("blocks cleanup when the post's UTC date no longer corresponds to noon Eastern", async () => {
    await drafted();
    await finishPublication(path, config, api, true);
    post!.date_gmt = "2026-11-01T16:00:00";
    await expect(cleanupPublication(path, config, api)).rejects.toThrow("noon Eastern");
    await expect(access(request.input)).resolves.toBeUndefined();
  });
  it("never deletes replacement local audio after publication", async () => {
    await drafted();
    await finishPublication(path, config, api, true);
    await writeFile(request.input, "replacement");
    await expect(cleanupPublication(path, config, api)).rejects.toThrow("files changed");
    expect(await readFile(request.input, "utf8")).toBe("replacement");
  });
  it("keeps local audio if remote verification fails during cleanup", async () => {
    await drafted();
    await finishPublication(path, config, api, true);
    remoteBody = "wrong";
    await expect(cleanupPublication(path, config, api)).rejects.toThrow("differs");
    await expect(access(request.input)).resolves.toBeUndefined();
  });
  it("refuses concurrent use of the same receipt", async () => {
    await planned();
    await import("node:fs/promises").then((fs) => fs.mkdir(`${path}.lock`));
    await expect(draftPublication(path, config, api)).rejects.toThrow("locked");
    expect(api.uploadMedia).not.toHaveBeenCalled();
  });
  it("refuses receipts for another site", async () => {
    await planned();
    await expect(
      draftPublication(path, { ...config, siteUrl: "https://other.example.org" }, api),
    ).rejects.toThrow("another site");
    expect(api.uploadMedia).not.toHaveBeenCalled();
  });
});
