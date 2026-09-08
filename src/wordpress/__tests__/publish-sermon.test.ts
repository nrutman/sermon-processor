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
  organization: "Example Church",
  preacher: "Alice Smith",
  sermonSeries: "Example Series",
  date: "2026-01-04",
  scripture: "Matthew 7:24–29",
  title: "Sample Sermon",
};

let request: PublishSermonRequest;
const mediaUrl = "https://media.example.org/wp-content/uploads/sermon.mp3";
const verifiedMeta = {
  _ct_sm_audio_button_text: "Download Audio",
  _ct_sm_audio_file: mediaUrl,
  _ct_sm_audio_length: "00:35:08",
  _ct_sm_bible01_book: "Matthew",
  _ct_sm_bible01_end_chap: "7",
  _ct_sm_bible01_end_verse: "29",
  _ct_sm_bible01_start_chap: "7",
  _ct_sm_bible01_start_verse: "24",
};

async function writeQcReport(
  options: { metadata?: ReturnType<typeof buildMp3Metadata>; outputPath?: string } = {},
): Promise<void> {
  await writeFile(
    request.qcReport,
    JSON.stringify({
      metadata: options.metadata ?? buildMp3Metadata(request.metadata),
      output: {
        bitrateKbps: 64,
        codec: "mp3",
        durationSeconds: 2107.9,
        path: options.outputPath ?? request.input,
      },
    }),
  );
}

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "wordpress-publish-test-"));
  const input = join(directory, "SERMON-2026-01-04-Smith.mp3");
  const qcReport = join(directory, "sermon.qc.json");
  await writeFile(input, "audio");
  request = {
    input,
    mediaHost: "media.example.org",
    metadata,
    publish: false,
    qcReport,
  };
  await writeQcReport();
});

function sermon(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: "2026-01-04T12:00:00",
    featured_media: 30,
    id: 40,
    link: "https://church.example.org/?post_type=ct_sermon&p=40",
    meta: { ...verifiedMeta },
    "sermon-series": [20],
    "sermon-speakers": [10],
    status: "draft",
    title: { raw: "Sample Sermon" },
    ...overrides,
  };
}

interface ApiOptions {
  postError?: Error;
  seriesPosts?: unknown[];
  seriesTerms?: unknown[];
  verifiedMedia?: Record<string, unknown>;
  verifiedSermon?: Record<string, unknown>;
}

function createApi(options: ApiOptions = {}) {
  let createdSermon: Record<string, unknown> | undefined;
  const get = vi.fn<(path: string) => Promise<unknown>>(async (path) => {
    if (path.startsWith("sermons?context=edit&status=any")) return [];
    if (path.startsWith("sermon-speakers?")) return [];
    if (path.startsWith("sermon-series?context=edit&hide_empty=")) {
      return options.seriesTerms ?? [{ id: 20, name: "Example Series", slug: "example-series" }];
    }
    if (path.startsWith("sermons?context=edit&sermon-series=20")) {
      return options.seriesPosts ?? [sermon({ id: 35 })];
    }
    if (path === "sermons/40?context=edit") {
      return options.verifiedSermon ?? createdSermon ?? sermon();
    }
    if (path === "media/50?context=edit") {
      return options.verifiedMedia ?? { id: 50, post: 40, source_url: mediaUrl };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
  const post = vi.fn<(path: string, body: unknown) => Promise<unknown>>(async (path, body) => {
    if (path === "sermon-speakers") {
      return { id: 10, name: "Alice Smith", slug: "alice-smith" };
    }
    if (path === "media/50") return { id: 50 };
    if (path === "sermons") {
      if (options.postError) throw options.postError;
      if (typeof body !== "object" || body === null || !("meta" in body)) {
        throw new Error("Missing sermon metadata");
      }
      createdSermon = sermon({
        date: "date" in body ? body.date : undefined,
        featured_media: "featured_media" in body ? body.featured_media : undefined,
        meta: body.meta,
        status: "status" in body ? body.status : undefined,
        title: { raw: "title" in body ? body.title : undefined },
        "sermon-series": "sermon-series" in body ? body["sermon-series"] : undefined,
        "sermon-speakers": "sermon-speakers" in body ? body["sermon-speakers"] : undefined,
      });
      return createdSermon;
    }
    throw new Error(`Unexpected POST ${path}`);
  });
  return {
    delete: vi.fn<(path: string) => Promise<void>>(async () => undefined),
    get,
    post,
    uploadMedia: vi.fn<(path: string) => Promise<unknown>>(async () => ({
      id: 50,
      source_url: mediaUrl,
    })),
  } satisfies WordPressApi;
}

describe("WordPress sermon publishing", () => {
  it("creates a verified draft using Series artwork and legacy sermon fields", async () => {
    const api = createApi();

    const result = await publishSermon(request, api);

    expect(result).toEqual({
      mediaId: 50,
      mediaUrl,
      postId: 40,
      postStatus: "draft",
      postUrl: "https://church.example.org/?post_type=ct_sermon&p=40",
    });
    expect(api.post).toHaveBeenCalledWith("sermons", {
      title: "Sample Sermon",
      status: "draft",
      date: "2026-01-04T12:00:00",
      featured_media: 30,
      meta: {
        _ct_sm_audio_file: mediaUrl,
        _ct_sm_audio_length: "00:35:08",
        _ct_sm_audio_button_text: "Download Audio",
        _ct_sm_bible01_book: "Matthew",
        _ct_sm_bible01_start_chap: "7",
        _ct_sm_bible01_start_verse: "24",
        _ct_sm_bible01_end_chap: "7",
        _ct_sm_bible01_end_verse: "29",
      },
      "sermon-speakers": [10],
      "sermon-series": [20],
    });
    expect(api.get).toHaveBeenCalledWith("media/50?context=edit");
  });

  it("publishes at noon on the requested date when explicitly requested", async () => {
    request.publish = true;
    const api = createApi();

    const result = await publishSermon(request, api);

    expect(api.post).toHaveBeenCalledWith(
      "sermons",
      expect.objectContaining({ date: "2026-01-04T12:00:00", status: "publish" }),
    );
    expect(result.postStatus).toBe("publish");
  });

  it("refuses a QC report for another output before calling WordPress", async () => {
    await writeQcReport({ outputPath: "/tmp/another-sermon.mp3" });
    const api = createApi();

    await expect(publishSermon(request, api)).rejects.toThrow("does not match");
    expect(api.get).not.toHaveBeenCalled();
  });

  it("refuses mismatched QC metadata before calling WordPress", async () => {
    await writeQcReport({
      metadata: { ...buildMp3Metadata(request.metadata), title: "Another Sermon" },
    });
    const api = createApi();

    await expect(publishSermon(request, api)).rejects.toThrow("QC report metadata does not match");
    expect(api.get).not.toHaveBeenCalled();
  });

  it("refuses to upload when a sermon already exists on the date", async () => {
    const api = createApi();
    api.get.mockResolvedValueOnce([sermon({ id: 45 })]);

    await expect(publishSermon(request, api)).rejects.toThrow(
      "A sermon already exists on 2026-01-04: Sample Sermon (45)",
    );
    expect(api.uploadMedia).not.toHaveBeenCalled();
  });

  it("removes an uploaded file when post creation fails", async () => {
    const api = createApi({ postError: new Error("post rejected") });

    await expect(publishSermon(request, api)).rejects.toThrow("post rejected");
    expect(api.delete).toHaveBeenCalledWith("media/50?force=true");
  });

  it("refuses an uncertain Series match before uploading media", async () => {
    const api = createApi({
      seriesTerms: [
        { id: 20, name: "Example Series A", slug: "example-series-a" },
        { id: 21, name: "Example Series B", slug: "example-series-b" },
      ],
    });

    await expect(publishSermon(request, api)).rejects.toThrow(
      'No confident WordPress Series match for "Example Series"',
    );
    expect(api.uploadMedia).not.toHaveBeenCalled();
  });

  it("refuses a Series without reusable artwork before uploading media", async () => {
    const api = createApi({ seriesPosts: [sermon({ featured_media: 0 })] });

    await expect(publishSermon(request, api)).rejects.toThrow(
      "No existing sermon in Example Series has Series artwork to reuse",
    );
    expect(api.uploadMedia).not.toHaveBeenCalled();
  });

  it("removes media and refuses to create a sermon when WordPress returns the wrong host", async () => {
    const api = createApi();
    api.uploadMedia.mockResolvedValue({
      id: 50,
      source_url: "https://church.example.org/wp-content/uploads/sermon.mp3",
    });

    await expect(publishSermon(request, api)).rejects.toThrow(
      "expected HTTPS storage on media.example.org",
    );
    expect(api.post).not.toHaveBeenCalledWith("sermons", expect.anything());
    expect(api.delete).toHaveBeenCalledWith("media/50?force=true");
  });

  it.each([
    { field: "status", overrides: { status: "publish" } },
    { field: "date", overrides: { date: "2026-01-04T13:00:00" } },
    { field: "title", overrides: { title: { raw: "Another Sermon" } } },
    { field: "featured media", overrides: { featured_media: 0 } },
    { field: "speaker", overrides: { "sermon-speakers": [] } },
    { field: "Series", overrides: { "sermon-series": [] } },
    {
      field: "sermon metadata",
      overrides: { meta: { ...verifiedMeta, _ct_sm_audio_length: "00:00:01" } },
    },
  ])("removes the draft and media when WordPress changes $field", async ({ field, overrides }) => {
    const api = createApi({ verifiedSermon: sermon(overrides) });

    await expect(publishSermon(request, api)).rejects.toThrow(
      `WordPress did not preserve the verified sermon fields on post 40: ${field}`,
    );
    expect(api.delete).toHaveBeenCalledWith("sermons/40?force=true");
    expect(api.delete).toHaveBeenCalledWith("media/50?force=true");
  });

  it("removes the draft and media when the attachment is not associated", async () => {
    const api = createApi({
      verifiedMedia: { id: 50, post: 0, source_url: mediaUrl },
    });

    await expect(publishSermon(request, api)).rejects.toThrow(
      "WordPress did not associate media 50 with post 40",
    );
    expect(api.delete).toHaveBeenCalledWith("sermons/40?force=true");
    expect(api.delete).toHaveBeenCalledWith("media/50?force=true");
  });

  it("preserves the publishing error when rollback cleanup also fails", async () => {
    const api = createApi({
      verifiedSermon: sermon({
        meta: { ...verifiedMeta, _ct_sm_audio_file: "https://example.com/wrong.mp3" },
      }),
    });
    api.delete.mockRejectedValue(new Error("cleanup unavailable"));

    await expect(publishSermon(request, api)).rejects.toThrow(
      "WordPress did not preserve the verified sermon fields",
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
    expect(publishSermonInternals.personNamesMatch("Robert Parker", "Rob Parker")).toBe(true);
    expect(publishSermonInternals.personNamesMatch("Matthew Jones", "Matt Jones")).toBe(true);
    expect(publishSermonInternals.personNamesMatch("Alice Smith", "Rob Parker")).toBe(false);
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
