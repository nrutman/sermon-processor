import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { sermonMetadataSchema } from "../config/schema.js";
import type { WordPressConfig } from "../config/wordpress-config.js";
import { verifyOutputLoudness } from "../audio/loudness.js";
import { buildMp3Metadata } from "../metadata/sermon-metadata.js";
import type { WordPressApi } from "./client.js";
import {
  buildScriptureMeta,
  createSermonDraft,
  resolveTerm,
  sermonSchema,
  verifyQcReport,
  verifySermonReadback,
  verifyUploadedMediaUrl,
} from "./draft-sermon.js";

const requestSchema = z.object({
  input: z.string(),
  qcReport: z.string(),
  artwork: z.string().optional(),
  metadata: sermonMetadataSchema,
  wordpressScripture: z.string().optional(),
});
const receiptSchema = z.object({
  version: z.literal(1),
  siteUrl: z.url(),
  mediaHost: z.string(),
  request: requestSchema,
  audioSha256: z.string(),
  qcSha256: z.string(),
  artworkSha256: z.string().optional(),
  durationSeconds: z.number(),
  speaker: z.object({ id: z.number(), name: z.string() }),
  series: z.object({ id: z.number(), name: z.string() }),
  artworkId: z.number(),
  state: z.enum(["planned", "mutating", "draft", "published", "failed"]),
  postId: z.number().optional(),
  mediaId: z.number().optional(),
  mediaUrl: z.url().optional(),
  postUrl: z.url().optional(),
  error: z.string().optional(),
  localAudioRemoved: z.boolean().default(false),
  journal: z.array(
    z.object({
      action: z.string(),
      phase: z.enum(["intent", "complete"]),
      result: z.unknown().optional(),
    }),
  ),
});
export type PublicationReceipt = z.infer<typeof receiptSchema>;
export type PublicationInput = z.infer<typeof requestSchema>;

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function save(path: string, receipt: PublicationReceipt): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function locked<T>(path: string, action: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  try {
    await mkdir(lock);
  } catch {
    throw new Error(
      `Receipt is locked: ${lock}. Inspect any interrupted process before removing the lock.`,
    );
  }
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true });
  }
}

async function load(path: string, config: WordPressConfig): Promise<PublicationReceipt> {
  const receipt = receiptSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (receipt.siteUrl !== config.siteUrl || receipt.mediaHost !== config.mediaHost) {
    throw new Error("Publication receipt belongs to another site or media host");
  }
  const cleanupStarted = receipt.journal.some(
    (entry) => entry.action === "CLEANUP" && entry.phase === "intent",
  );
  let audioHash: string | undefined;
  try {
    audioHash = await sha256(receipt.request.input);
  } catch (error) {
    if (!(cleanupStarted && error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  if (
    (audioHash !== undefined && audioHash !== receipt.audioSha256) ||
    (await sha256(receipt.request.qcReport)) !== receipt.qcSha256 ||
    (receipt.request.artwork && (await sha256(receipt.request.artwork)) !== receipt.artworkSha256)
  ) {
    throw new Error("Publication files changed after planning; create a new plan");
  }
  return receipt;
}

async function all(api: WordPressApi, resource: string, page = 1): Promise<unknown[]> {
  let response: unknown;
  try {
    response = await api.get(`${resource}&per_page=100&page=${page}`);
  } catch (error) {
    // WordPress rejects the page after an exactly-full final page instead of returning [].
    if (
      page > 1 &&
      error instanceof Error &&
      /"code"\s*:\s*"rest_post_invalid_page_number"/.test(error.message)
    )
      return [];
    throw error;
  }
  const batch = z.array(z.unknown()).parse(response);
  return batch.length < 100 ? batch : [...batch, ...(await all(api, resource, page + 1))];
}

async function datePosts(api: WordPressApi, date: string): Promise<unknown[]> {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return all(
    api,
    `sermons?context=edit&status=publish,future,draft,pending,private,trash&after=${date}T00%3A00%3A00&before=${next.toISOString().slice(0, 10)}T00%3A00%3A00`,
  );
}

async function matchingMedia(api: WordPressApi, input: string): Promise<unknown[]> {
  return all(
    api,
    `media?context=edit&status=inherit,private,trash&search=${encodeURIComponent(basename(input).replace(/\.mp3$/i, ""))}`,
  );
}

/** Creates a local, credential-free publication plan using only remote GET requests. */
export async function planPublication(
  input: PublicationInput,
  path: string,
  config: WordPressConfig,
  api: WordPressApi,
): Promise<PublicationReceipt> {
  const parsed = requestSchema.parse(input);
  buildScriptureMeta(parsed.wordpressScripture ?? parsed.metadata.scripture);
  const request = {
    ...parsed,
    input: resolve(parsed.input),
    qcReport: resolve(parsed.qcReport),
    ...(parsed.artwork ? { artwork: resolve(parsed.artwork) } : {}),
  };
  const durationSeconds = await verifyQcReport({
    ...request,
    mediaHost: config.mediaHost,
  });
  const qcBytes = await readFile(request.qcReport, "utf8");
  const approvedHash = z
    .object({ output: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }) })
    .parse(JSON.parse(qcBytes)).output.sha256;
  if ((await sha256(request.input)) !== approvedHash)
    throw new Error("MP3 bytes do not match the QC fingerprint");
  const qc = z
    .object({
      loudness: z.object({
        output: z.object({
          inputI: z.number(),
          inputTp: z.number(),
          inputLra: z.number(),
          inputThreshold: z.number(),
          targetOffset: z.number(),
        }),
      }),
    })
    .parse(JSON.parse(qcBytes));
  verifyOutputLoudness(qc.loudness.output, { lufs: -16, truePeak: -1.5 });
  z.object({ timezone: z.literal("America/New_York") }).parse(await api.get("settings"));
  if ((await datePosts(api, request.metadata.date)).length)
    throw new Error(
      "A sermon already exists on this date (including drafts/trash); reconcile before uploading",
    );
  if ((await matchingMedia(api, request.input)).length)
    throw new Error("Possible existing/orphan audio attachment; reconcile before uploading");
  const [speaker, series] = await Promise.all([
    resolveTerm(api, "sermon-speakers", request.metadata.preacher, {
      personName: true,
    }),
    resolveTerm(api, "sermon-series", request.metadata.sermonSeries, {
      personName: false,
    }),
  ]);
  const prior = z
    .array(sermonSchema)
    .parse(
      await all(api, `sermons?context=edit&sermon-series=${series.id}&orderby=date&order=desc`),
    );
  const artworkId = prior.find((post) => post.featured_media > 0)?.featured_media ?? 0;
  if (!artworkId && !request.artwork)
    throw new Error("Series has no artwork; supply a local JPEG/PNG");
  if (artworkId) await api.get(`media/${artworkId}?context=edit`);
  const receipt: PublicationReceipt = {
    version: 1,
    siteUrl: config.siteUrl,
    mediaHost: config.mediaHost,
    request,
    audioSha256: await sha256(request.input),
    qcSha256: await sha256(request.qcReport),
    ...(request.artwork ? { artworkSha256: await sha256(request.artwork) } : {}),
    durationSeconds,
    speaker,
    series,
    artworkId,
    state: "planned",
    journal: [],
    localAudioRemoved: false,
  };
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return receipt;
}

function expectedMeta(receipt: PublicationReceipt, mediaUrl: string): Record<string, string> {
  const seconds = Math.round(receipt.durationSeconds);
  const duration = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
  return {
    _ct_sm_audio_file: mediaUrl,
    _ct_sm_audio_length: duration,
    _ct_sm_audio_button_text: "Download Audio",
    ...buildScriptureMeta(receipt.request.wordpressScripture ?? receipt.request.metadata.scripture),
  };
}

/** Verifies a receipt's post, associated audio bytes, storage paths, and public page. */
export async function verifyPublication(
  receipt: PublicationReceipt,
  api: WordPressApi,
): Promise<PublicationReceipt> {
  if (!receipt.postId || !receipt.mediaId || !receipt.mediaUrl)
    throw new Error("Receipt has no complete draft; reconcile first");
  verifyUploadedMediaUrl(receipt.mediaUrl, receipt.mediaHost);
  z.object({ timezone: z.literal("America/New_York") }).parse(await api.get("settings"));
  const rawPost = await api.get(`sermons/${receipt.postId}?context=edit`);
  const post = sermonSchema.parse(rawPost);
  const gmt = z
    .object({ date_gmt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/) })
    .parse(rawPost).date_gmt;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(`${gmt}Z`));
  const part = (name: string) => parts.find((value) => value.type === name)?.value;
  if (
    `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}` !==
    `${receipt.request.metadata.date}T12:00:00`
  )
    throw new Error("Post UTC date is not noon Eastern");
  if (post.status !== "draft" && post.status !== "publish")
    throw new Error(`Unexpected sermon status ${post.status}`);
  verifySermonReadback(post, {
    date: `${receipt.request.metadata.date}T12:00:00`,
    featuredMedia: receipt.artworkId,
    meta: expectedMeta(receipt, receipt.mediaUrl),
    seriesId: receipt.series.id,
    speakerId: receipt.speaker.id,
    status: post.status,
    title: buildMp3Metadata(receipt.request.metadata).title,
  });
  const attachment = z
    .object({ post: z.number(), source_url: z.string() })
    .parse(await api.get(`media/${receipt.mediaId}?context=edit`));
  if (attachment.post !== post.id || attachment.source_url !== receipt.mediaUrl)
    throw new Error("Audio attachment association/URL changed");
  if (
    receipt.journal.some(
      (entry) => entry.action.startsWith("UPLOAD image/") && entry.phase === "complete",
    )
  ) {
    const image = z
      .object({ id: z.number(), post: z.number(), source_url: z.string() })
      .parse(await api.get(`media/${receipt.artworkId}?context=edit`));
    if (image.id !== receipt.artworkId || image.post !== post.id)
      throw new Error("Uploaded artwork association changed");
    verifyUploadedMediaUrl(image.source_url, receipt.mediaHost);
  }
  const remote = await fetch(receipt.mediaUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  if (remote.status !== 200 || !remote.body)
    throw new Error(`Audio returned HTTP ${remote.status}`);
  const hash = createHash("sha256");
  for await (const chunk of remote.body) hash.update(chunk);
  if (hash.digest("hex") !== receipt.audioSha256)
    throw new Error("Uploaded audio differs from approved MP3");
  const mediaPath = new URL(receipt.mediaUrl).pathname;
  if (!mediaPath.startsWith("/wp-content/uploads/"))
    throw new Error("Cannot derive equivalent local upload path safely");
  const local = await fetch(new URL(mediaPath, receipt.siteUrl), {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (local.status !== 404)
    throw new Error(`Local upload path returned HTTP ${local.status}; expected 404`);
  if (post.status === "publish") {
    if (new URL(post.link).origin !== new URL(receipt.siteUrl).origin)
      throw new Error("Public permalink belongs to another site");
    const page = await fetch(post.link, { signal: AbortSignal.timeout(30_000) });
    if (
      page.status !== 200 ||
      !(await page.text()).includes(post.title.rendered ?? post.title.raw ?? "")
    )
      throw new Error("Public page/title verification failed");
  }
  return {
    ...receipt,
    state: post.status === "publish" ? "published" : "draft",
    postUrl: post.link,
  };
}

/** Creates one draft from a planned receipt and journals every remote mutation. */
export async function draftPublication(
  path: string,
  config: WordPressConfig,
  api: WordPressApi,
): Promise<PublicationReceipt> {
  return locked(path, async () => {
    let receipt = await load(path, config);
    if (receipt.state !== "planned")
      throw new Error("Receipt already used; verify or reconcile, never upload again");
    if ((await datePosts(api, receipt.request.metadata.date)).length)
      throw new Error("Sermon date now occupied; reconcile first");
    if ((await matchingMedia(api, receipt.request.input)).length)
      throw new Error("Possible orphan attachment; reconcile before uploading");
    z.object({ timezone: z.literal("America/New_York") }).parse(await api.get("settings"));
    const [speaker, series] = await Promise.all([
      resolveTerm(api, "sermon-speakers", receipt.request.metadata.preacher, {
        personName: true,
      }),
      resolveTerm(api, "sermon-series", receipt.request.metadata.sermonSeries, {
        personName: false,
      }),
    ]);
    if (speaker.id !== receipt.speaker.id || series.id !== receipt.series.id)
      throw new Error("Term mapping changed; plan again");
    const record = async <T>(action: string, fn: () => Promise<T>): Promise<T> => {
      receipt.state = "mutating";
      receipt.journal.push({ action, phase: "intent" });
      await save(path, receipt);
      const result = await fn();
      if (action.startsWith("UPLOAD image/"))
        receipt.artworkId = z.object({ id: z.number() }).parse(result).id;
      receipt.journal.push({ action, phase: "complete", result });
      await save(path, receipt);
      return result;
    };
    const journalApi: WordPressApi = {
      get: (resource) => api.get(resource),
      post: (resource, body) => {
        if (resource === "sermon-speakers" || resource === "sermon-series")
          throw new Error("Planned term disappeared; reconcile and plan again");
        return record(`POST ${resource}`, () => api.post(resource, body));
      },
      delete: (resource) => record(`DELETE ${resource}`, () => api.delete(resource)),
      uploadMedia: (file, type) =>
        record(`UPLOAD ${type ?? "audio/mpeg"}`, () => api.uploadMedia(file, type)),
    };
    try {
      const result = await createSermonDraft(
        {
          ...receipt.request,
          mediaHost: config.mediaHost,
          featuredMediaId: receipt.artworkId,
        },
        journalApi,
      );
      const image = receipt.journal.find(
        (entry) => entry.action.startsWith("UPLOAD image/") && entry.phase === "complete",
      );
      if (image) receipt.artworkId = z.object({ id: z.number() }).parse(image.result).id;
      receipt = {
        ...receipt,
        postId: result.postId,
        postUrl: result.postUrl,
        mediaId: result.mediaId,
        mediaUrl: result.mediaUrl,
      };
      receipt = await verifyPublication(receipt, api);
      await save(path, receipt);
      return receipt;
    } catch (error) {
      receipt.state = "failed";
      receipt.error = error instanceof Error ? error.message : String(error);
      await save(path, receipt);
      throw new Error(
        `${receipt.error}. Receipt preserved; run publication reconcile before retrying.`,
        { cause: error },
      );
    }
  });
}

/** Reads current publication state; optionally adopts an explicitly selected, fully verified draft. */
export async function reconcilePublication(
  path: string,
  config: WordPressConfig,
  api: WordPressApi,
  postId?: number,
): Promise<unknown> {
  return locked(path, async () => {
    const receipt = await load(path, config);
    const posts = await datePosts(api, receipt.request.metadata.date);
    const media = await matchingMedia(api, receipt.request.input);
    if (postId !== undefined) {
      const image = receipt.journal.find(
        (entry) => entry.action.startsWith("UPLOAD image/") && entry.phase === "complete",
      );
      if (image) receipt.artworkId = z.object({ id: z.number() }).parse(image.result).id;
      const post = sermonSchema.parse(
        posts.find((value) => sermonSchema.parse(value).id === postId),
      );
      const match = z
        .array(z.object({ id: z.number(), post: z.number(), source_url: z.string() }))
        .parse(media)
        .filter(
          (item) => item.post === postId && item.source_url === post.meta["_ct_sm_audio_file"],
        );
      if (match.length !== 1)
        throw new Error("Cannot uniquely identify associated audio; no changes made");
      const adopted = await verifyPublication(
        { ...receipt, postId, mediaId: match[0]!.id, mediaUrl: match[0]!.source_url },
        api,
      );
      await save(path, adopted);
      return adopted;
    }
    return {
      state: receipt.state,
      posts,
      media,
      journal: receipt.journal,
      instruction:
        "No remote changes made. Adopt a verified post with --post-id; investigate orphan media before planning another upload.",
    };
  });
}

/** Verifies a receipt and publishes its existing draft only with explicit approval. */
export async function finishPublication(
  path: string,
  config: WordPressConfig,
  api: WordPressApi,
  approved = false,
): Promise<PublicationReceipt> {
  return locked(path, async () => {
    let receipt = await load(path, config);
    receipt = await verifyPublication(receipt, api);
    if (approved && receipt.state !== "published") {
      receipt.state = "mutating";
      receipt.journal.push({ action: `PUBLISH ${receipt.postId}`, phase: "intent" });
      await save(path, receipt);
      await api.post(`sermons/${receipt.postId}`, {
        status: "publish",
        date: `${receipt.request.metadata.date}T12:00:00`,
      });
      receipt = await verifyPublication(receipt, api);
      if (receipt.state !== "published") throw new Error("WordPress did not publish the draft");
      receipt.journal.push({ action: `PUBLISH ${receipt.postId}`, phase: "complete" });
    }
    await save(path, receipt);
    return receipt;
  });
}

/** Removes only the pinned local MP3 after verifying its published post and remote bytes. */
export async function cleanupPublication(
  path: string,
  config: WordPressConfig,
  api: WordPressApi,
): Promise<PublicationReceipt> {
  return locked(path, async () => {
    let receipt = await load(path, config);
    receipt = await verifyPublication(receipt, api);
    if (receipt.state !== "published") throw new Error("Cannot clean up unpublished audio");
    if (!receipt.request.input.toLowerCase().endsWith(".mp3"))
      throw new Error("Cleanup only supports MP3 output files");
    if (!receipt.localAudioRemoved) {
      // Persist intent before unlink so an interrupted cleanup can be resumed safely.
      receipt.journal.push({ action: "CLEANUP", phase: "intent" });
      await save(path, receipt);
      // Recheck immediately before deletion: a replacement file must never be removed.
      try {
        if ((await sha256(receipt.request.input)) !== receipt.audioSha256)
          throw new Error("Local MP3 changed; refusing cleanup");
        await unlink(receipt.request.input);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      receipt.localAudioRemoved = true;
      receipt.journal.push({ action: "CLEANUP", phase: "complete" });
      await save(path, receipt);
    }
    return receipt;
  });
}
