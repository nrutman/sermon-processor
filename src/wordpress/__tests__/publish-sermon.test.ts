import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMp3Metadata } from "../../metadata/sermon-metadata.js";
import type { WordPressApi } from "../client.js";
import {
  buildScriptureMeta,
  publishSermon,
  publishSermonInternals,
  type PublishSermonRequest,
} from "../publish-sermon.js";

const metadata = {
  organization: "Providence Church",
  preacher: "Nathan Rutman",
  sermonSeries: "Sermon on the Mount",
  date: "2026-09-06",
  scripture: "Matthew 7:24–29",
  title: "Hearers and Doers",
};

let request: PublishSermonRequest;

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "wordpress-publish-test-"));
  const input = join(directory, "PCOP-2026-09-06-Rutman.mp3");
  const qcReport = join(directory, "sermon.qc.json");
  await writeFile(input, "audio");
  await writeFile(
    qcReport,
    JSON.stringify({
      metadata: buildMp3Metadata(metadata),
      output: { bitrateKbps: 64, codec: "mp3", durationSeconds: 2107.9, path: input },
    }),
  );
  request = {
    input,
    mediaHost: "provchurch-messages.s3.amazonaws.com",
    metadata,
    publish: false,
    qcReport,
  };
});

function sermon(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: "2026-09-06T12:00:00",
    featured_media: 23621,
    id: 24000,
    link: "https://provchurch.org/?post_type=ct_sermon&p=24000",
    meta: {
      _ct_sm_audio_file:
        "https://provchurch-messages.s3.amazonaws.com/wp-content/uploads/sermon.mp3",
    },
    status: "draft",
    title: { raw: "Hearers and Doers" },
    ...overrides,
  };
}

function createApi() {
  const get = vi.fn<(path: string) => Promise<unknown>>(async (path) => {
    if (path.startsWith("sermons?context=edit&status=any")) return [];
    if (path.startsWith("sermon-speakers?")) return [];
    if (path.startsWith("sermon-series?context=edit&hide_empty=")) {
      return [{ id: 108, name: "Sermon on the Mount", slug: "sermon-on-the-mount" }];
    }
    if (path.startsWith("sermons?context=edit&sermon-series=108")) {
      return [sermon({ id: 23659 })];
    }
    if (path === "sermons/24000?context=edit") return sermon();
    throw new Error(`Unexpected GET ${path}`);
  });
  const post = vi.fn<(path: string, body: unknown) => Promise<unknown>>(async (path, body) => {
    if (path === "sermon-speakers") {
      return { id: 120, name: "Nathan Rutman", slug: "nathan-rutman" };
    }
    if (path === "media/25000") return { id: 25000 };
    if (path === "sermons") {
      if (typeof body !== "object" || body === null || !("meta" in body)) {
        throw new Error("Missing sermon metadata");
      }
      return sermon({ meta: body.meta });
    }
    throw new Error(`Unexpected POST ${path}`);
  });
  return {
    delete: vi.fn<(path: string) => Promise<void>>(async () => undefined),
    get,
    post,
    uploadMedia: vi.fn<(path: string) => Promise<unknown>>(async () => ({
      id: 25000,
      source_url: "https://provchurch-messages.s3.amazonaws.com/wp-content/uploads/sermon.mp3",
    })),
  } satisfies WordPressApi;
}

describe("WordPress sermon publishing", () => {
  it("creates a verified draft using Series artwork and legacy sermon fields", async () => {
    const api = createApi();

    const result = await publishSermon(request, api);

    expect(result).toEqual({
      mediaId: 25000,
      mediaUrl: "https://provchurch-messages.s3.amazonaws.com/wp-content/uploads/sermon.mp3",
      postId: 24000,
      postStatus: "draft",
      postUrl: "https://provchurch.org/?post_type=ct_sermon&p=24000",
    });
    expect(api.post).toHaveBeenCalledWith("sermons", {
      title: "Hearers and Doers",
      status: "draft",
      date: "2026-09-06T12:00:00",
      featured_media: 23621,
      meta: {
        _ct_sm_audio_file:
          "https://provchurch-messages.s3.amazonaws.com/wp-content/uploads/sermon.mp3",
        _ct_sm_audio_length: "00:35:08",
        _ct_sm_audio_button_text: "Download Audio",
        _ct_sm_bible01_book: "Matthew",
        _ct_sm_bible01_start_chap: "7",
        _ct_sm_bible01_start_verse: "24",
        _ct_sm_bible01_end_chap: "7",
        _ct_sm_bible01_end_verse: "29",
      },
      "sermon-speakers": [120],
      "sermon-series": [108],
    });
  });

  it("refuses to upload when a sermon already exists on the date", async () => {
    const api = createApi();
    api.get.mockResolvedValueOnce([sermon({ id: 23670 })]);

    await expect(publishSermon(request, api)).rejects.toThrow(
      "A sermon already exists on 2026-09-06: Hearers and Doers (23670)",
    );
    expect(api.uploadMedia).not.toHaveBeenCalled();
  });

  it("removes an uploaded file when post creation fails", async () => {
    const api = createApi();
    api.post.mockImplementation(async (path: string): Promise<unknown> => {
      if (path === "sermon-speakers") {
        return { id: 120, name: "Nathan Rutman", slug: "nathan-rutman" };
      }
      if (path === "media/25000") return { id: 25000 };
      throw new Error("post rejected");
    });

    await expect(publishSermon(request, api)).rejects.toThrow("post rejected");
    expect(api.delete).toHaveBeenCalledWith("media/25000?force=true");
  });

  it("removes media and refuses to create a sermon when WordPress does not return the S3 host", async () => {
    const api = createApi();
    api.uploadMedia.mockResolvedValue({
      id: 25000,
      source_url: "https://provchurch.org/wp-content/uploads/sermon.mp3",
    });

    await expect(publishSermon(request, api)).rejects.toThrow(
      "expected HTTPS storage on provchurch-messages.s3.amazonaws.com",
    );
    expect(api.post).not.toHaveBeenCalledWith("sermons", expect.anything());
    expect(api.delete).toHaveBeenCalledWith("media/25000?force=true");
  });

  it("removes the draft and media when read-back verification fails", async () => {
    const api = createApi();
    api.get.mockImplementation(async (path: string): Promise<unknown> => {
      if (path.startsWith("sermons?context=edit&status=any")) return [];
      if (path.startsWith("sermon-speakers?")) return [];
      if (path.startsWith("sermon-series?context=edit&hide_empty=")) {
        return [{ id: 108, name: "Sermon on the Mount", slug: "sermon-on-the-mount" }];
      }
      if (path.startsWith("sermons?context=edit&sermon-series=108")) {
        return [sermon({ id: 23659 })];
      }
      if (path === "sermons/24000?context=edit") {
        return sermon({ meta: { _ct_sm_audio_file: "https://cdn.example.com/wrong.mp3" } });
      }
      throw new Error(`Unexpected GET ${path}`);
    });

    await expect(publishSermon(request, api)).rejects.toThrow(
      "WordPress did not preserve the verified media fields",
    );
    expect(api.delete).toHaveBeenCalledWith("sermons/24000?force=true");
    expect(api.delete).toHaveBeenCalledWith("media/25000?force=true");
  });

  it("preserves the publishing error when rollback cleanup also fails", async () => {
    const api = createApi();
    api.get.mockImplementation(async (path: string): Promise<unknown> => {
      if (path.startsWith("sermons?context=edit&status=any")) return [];
      if (path.startsWith("sermon-speakers?")) return [];
      if (path.startsWith("sermon-series?context=edit&hide_empty=")) {
        return [{ id: 108, name: "Sermon on the Mount", slug: "sermon-on-the-mount" }];
      }
      if (path.startsWith("sermons?context=edit&sermon-series=108")) {
        return [sermon({ id: 23659 })];
      }
      if (path === "sermons/24000?context=edit") {
        return sermon({ meta: { _ct_sm_audio_file: "https://example.com/wrong.mp3" } });
      }
      throw new Error(`Unexpected GET ${path}`);
    });
    api.delete.mockRejectedValue(new Error("cleanup unavailable"));

    await expect(publishSermon(request, api)).rejects.toThrow(
      "WordPress did not preserve the verified media fields",
    );
    expect(api.delete).toHaveBeenCalledTimes(2);
  });

  it("parses a same-chapter scripture range", () => {
    expect(buildScriptureMeta("Matthew 7:24–29")).toMatchObject({
      _ct_sm_bible01_book: "Matthew",
      _ct_sm_bible01_start_chap: "7",
      _ct_sm_bible01_start_verse: "24",
      _ct_sm_bible01_end_chap: "7",
      _ct_sm_bible01_end_verse: "29",
    });
    expect(publishSermonInternals.formatDuration(3599.6)).toBe("01:00:00");
  });

  it("matches harmless Planning Center and WordPress naming differences", () => {
    expect(publishSermonInternals.normalizedTermName("The Sermon on the Mount")).toBe(
      "sermon-on-the-mount",
    );
    expect(publishSermonInternals.personNamesMatch("Robert Ivy", "Rob Ivy")).toBe(true);
    expect(publishSermonInternals.personNamesMatch("Matthew Bartko", "Matt Bartko")).toBe(true);
    expect(publishSermonInternals.personNamesMatch("Nathan Rutman", "Rob Ivy")).toBe(false);
    expect(
      publishSermonInternals.similarity("Sermon on the Mount", "The Sermon on the Mount"),
    ).toBe(1);
  });

  it("preserves verse suffixes", () => {
    expect(buildScriptureMeta("John 12:12–28a")).toMatchObject({
      _ct_sm_bible01_start_verse: "12",
      _ct_sm_bible01_end_verse: "28a",
    });
  });
});
