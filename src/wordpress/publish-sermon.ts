import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { SermonMetadata } from "../config/schema.js";
import { buildMp3Metadata } from "../metadata/sermon-metadata.js";
import type { WordPressApi } from "./client.js";

const speakerRestBase = "sermon-speakers";
const seriesRestBase = "sermon-series";

const termSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  slug: z.string(),
});
const mediaSchema = z.object({
  id: z.number().int().positive(),
  source_url: z.url(),
});
const associatedMediaSchema = mediaSchema.extend({
  post: z.number().int().nonnegative(),
});
const sermonSchema = z.object({
  date: z.string(),
  featured_media: z.number().int().nonnegative(),
  id: z.number().int().positive(),
  link: z.url(),
  meta: z.record(z.string(), z.unknown()).default({}),
  [speakerRestBase]: z.array(z.number().int().positive()).default([]),
  [seriesRestBase]: z.array(z.number().int().positive()).default([]),
  status: z.string(),
  title: z.object({ raw: z.string().optional(), rendered: z.string().optional() }),
});
const mp3MetadataSchema = z.object({
  album: z.string(),
  albumArtist: z.string(),
  artist: z.string(),
  comment: z.string(),
  date: z.string(),
  genre: z.string(),
  title: z.string(),
});
const qcSchema = z.object({
  metadata: mp3MetadataSchema,
  output: z.object({
    bitrateKbps: z.number().min(60).max(68),
    codec: z.literal("mp3"),
    durationSeconds: z.number().positive(),
    path: z.string(),
  }),
});

export interface PublishSermonRequest {
  input: string;
  mediaHost: string;
  metadata: SermonMetadata;
  publish: boolean;
  qcReport: string;
}

function verifyUploadedMediaUrl(url: string, expectedHost: string): void {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== expectedHost.toLowerCase()
  ) {
    throw new Error(
      `WordPress returned media URL ${JSON.stringify(url)}; expected HTTPS storage on ${expectedHost}`,
    );
  }
}

export interface PublishSermonResult {
  mediaId: number;
  mediaUrl: string;
  postId: number;
  postStatus: string;
  postUrl: string;
}

function termSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

function normalizedTermName(name: string): string {
  return termSlug(name).replace(/^(?:a|an|the)-/, "");
}

function personNamesMatch(left: string, right: string): boolean {
  const leftParts = normalizedTermName(left).split("-");
  const rightParts = normalizedTermName(right).split("-");
  const leftFirst = leftParts[0];
  const rightFirst = rightParts[0];
  return (
    leftParts.at(-1) === rightParts.at(-1) &&
    leftFirst !== undefined &&
    rightFirst !== undefined &&
    (leftFirst === rightFirst ||
      (Math.min(leftFirst.length, rightFirst.length) >= 3 &&
        (leftFirst.startsWith(rightFirst) || rightFirst.startsWith(leftFirst))))
  );
}

function bigrams(value: string): string[] {
  if (value.length < 2) return [value];
  return Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2));
}

function similarity(left: string, right: string): number {
  const leftBigrams = bigrams(normalizedTermName(left));
  const available = bigrams(normalizedTermName(right));
  let overlap = 0;
  for (const bigram of leftBigrams) {
    const index = available.indexOf(bigram);
    if (index >= 0) {
      overlap += 1;
      available.splice(index, 1);
    }
  }
  return (2 * overlap) / (leftBigrams.length + bigrams(normalizedTermName(right)).length);
}

function nextDate(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function formatDuration(durationSeconds: number): string {
  const rounded = Math.round(durationSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  return [hours, minutes, seconds].map((value) => value.toString().padStart(2, "0")).join(":");
}

export function buildScriptureMeta(scripture: string): Record<string, string> {
  const match = scripture
    .trim()
    .match(/^(.+?)\s+(\d+):(\d+[a-z]?)\s*[–—-]\s*(?:(\d+):)?(\d+[a-z]?)$/iu);
  if (match === null) {
    throw new Error(
      `WordPress publishing requires one verse range such as "Matthew 7:24–29"; received ${JSON.stringify(scripture)}`,
    );
  }
  const [, book, startChapter, startVerse, explicitEndChapter, endVerse] = match;
  if (!book || !startChapter || !startVerse || !endVerse) {
    throw new Error(`Could not parse scripture reference ${JSON.stringify(scripture)}`);
  }
  return {
    _ct_sm_bible01_book: book,
    _ct_sm_bible01_start_chap: startChapter,
    _ct_sm_bible01_start_verse: startVerse,
    _ct_sm_bible01_end_chap: explicitEndChapter ?? startChapter,
    _ct_sm_bible01_end_verse: endVerse,
  };
}

async function resolveTerm(
  api: WordPressApi,
  restBase: string,
  name: string,
  options: { createIfMissing: boolean; personName: boolean },
): Promise<z.infer<typeof termSchema>> {
  const slug = termSlug(name);
  const terms = z
    .array(termSchema)
    .parse(await api.get(`${restBase}?context=edit&hide_empty=false&per_page=100`));
  const exact = terms.find(
    (term) =>
      normalizedTermName(term.name) === normalizedTermName(name) ||
      (options.personName && personNamesMatch(term.name, name)),
  );
  if (exact !== undefined) return exact;
  const candidates = terms
    .map((term) => ({ score: similarity(term.name, name), term }))
    .toSorted((left, right) => right.score - left.score);
  const first = candidates[0];
  const second = candidates[1];
  if (first !== undefined && first.score >= 0.82 && first.score - (second?.score ?? 0) >= 0.1) {
    return first.term;
  }
  if (options.createIfMissing) {
    return termSchema.parse(await api.post(restBase, { name, slug }));
  }
  const suggestions = candidates
    .slice(0, 3)
    .map(({ score, term }) => `${term.name} (${score.toFixed(2)})`)
    .join(", ");
  throw new Error(
    `No confident WordPress Series match for ${JSON.stringify(name)}${suggestions ? `; closest: ${suggestions}` : ""}`,
  );
}

async function verifyQcReport(request: PublishSermonRequest): Promise<number> {
  await access(request.input, constants.R_OK);
  const qc = qcSchema.parse(JSON.parse(await readFile(request.qcReport, "utf8")));
  if (resolve(qc.output.path) !== resolve(request.input)) {
    throw new Error(`QC report output ${qc.output.path} does not match ${request.input}`);
  }
  const expectedMetadata = mp3MetadataSchema.parse(buildMp3Metadata(request.metadata));
  if (JSON.stringify(qc.metadata) !== JSON.stringify(expectedMetadata)) {
    throw new Error("QC report metadata does not match the requested sermon metadata");
  }
  return qc.output.durationSeconds;
}

function verifySermonReadback(
  sermon: z.infer<typeof sermonSchema>,
  expected: {
    date: string;
    featuredMedia: number;
    meta: Record<string, string>;
    seriesId: number;
    speakerId: number;
    status: string;
    title: string;
  },
): void {
  const mismatches: string[] = [];
  if (sermon.status !== expected.status) mismatches.push("status");
  if (sermon.date !== expected.date) mismatches.push("date");
  if ((sermon.title.raw ?? sermon.title.rendered) !== expected.title) mismatches.push("title");
  if (sermon.featured_media !== expected.featuredMedia) mismatches.push("featured media");
  if (sermon[speakerRestBase].length !== 1 || sermon[speakerRestBase][0] !== expected.speakerId) {
    mismatches.push("speaker");
  }
  if (sermon[seriesRestBase].length !== 1 || sermon[seriesRestBase][0] !== expected.seriesId) {
    mismatches.push("Series");
  }
  if (Object.entries(expected.meta).some(([key, value]) => sermon.meta[key] !== value)) {
    mismatches.push("sermon metadata");
  }
  if (mismatches.length > 0) {
    throw new Error(
      `WordPress did not preserve the verified sermon fields on post ${sermon.id}: ${mismatches.join(", ")}`,
    );
  }
}

export async function publishSermon(
  request: PublishSermonRequest,
  api: WordPressApi,
): Promise<PublishSermonResult> {
  const durationSeconds = await verifyQcReport({
    ...request,
    input: resolve(request.input),
    qcReport: resolve(request.qcReport),
  });
  const existing = z
    .array(sermonSchema)
    .parse(
      await api.get(
        `sermons?context=edit&status=any&after=${request.metadata.date}T00%3A00%3A00&before=${nextDate(request.metadata.date)}T00%3A00%3A00&per_page=100`,
      ),
    );
  if (existing.length > 0) {
    throw new Error(
      `A sermon already exists on ${request.metadata.date}: ${existing.map((post) => `${post.title.raw ?? post.title.rendered ?? "Untitled"} (${post.id})`).join(", ")}`,
    );
  }

  const [speaker, series] = await Promise.all([
    resolveTerm(api, speakerRestBase, request.metadata.preacher, {
      createIfMissing: true,
      personName: true,
    }),
    resolveTerm(api, seriesRestBase, request.metadata.sermonSeries, {
      createIfMissing: false,
      personName: false,
    }),
  ]);
  const seriesPosts = z
    .array(sermonSchema)
    .parse(
      await api.get(
        `sermons?context=edit&${seriesRestBase}=${series.id}&orderby=date&order=desc&per_page=20`,
      ),
    );
  const featuredMedia = seriesPosts.find((post) => post.featured_media > 0)?.featured_media;
  if (!featuredMedia) {
    throw new Error(
      `No existing sermon in ${request.metadata.sermonSeries} has Series artwork to reuse`,
    );
  }

  const uploaded = mediaSchema.parse(await api.uploadMedia(request.input));
  let createdPostId: number | undefined;
  try {
    verifyUploadedMediaUrl(uploaded.source_url, request.mediaHost);
    await api.post(`media/${uploaded.id}`, {
      title: request.metadata.title ?? request.metadata.scripture,
    });
    const meta = {
      _ct_sm_audio_file: uploaded.source_url,
      _ct_sm_audio_length: formatDuration(durationSeconds),
      _ct_sm_audio_button_text: "Download Audio",
      ...buildScriptureMeta(request.metadata.scripture),
    };
    const title = request.metadata.title ?? request.metadata.scripture;
    const status = request.publish ? "publish" : "draft";
    const date = `${request.metadata.date}T12:00:00`;
    const created = sermonSchema.parse(
      await api.post("sermons", {
        title,
        status,
        date,
        featured_media: featuredMedia,
        meta,
        [speakerRestBase]: [speaker.id],
        [seriesRestBase]: [series.id],
      }),
    );
    createdPostId = created.id;
    await api.post(`media/${uploaded.id}`, { post: created.id });
    const verified = sermonSchema.parse(await api.get(`sermons/${created.id}?context=edit`));
    verifySermonReadback(verified, {
      date,
      featuredMedia,
      meta,
      seriesId: series.id,
      speakerId: speaker.id,
      status,
      title,
    });
    const verifiedMedia = associatedMediaSchema.parse(
      await api.get(`media/${uploaded.id}?context=edit`),
    );
    if (verifiedMedia.post !== created.id || verifiedMedia.source_url !== uploaded.source_url) {
      throw new Error(`WordPress did not associate media ${uploaded.id} with post ${created.id}`);
    }
    return {
      mediaId: uploaded.id,
      mediaUrl: uploaded.source_url,
      postId: verified.id,
      postStatus: verified.status,
      postUrl: verified.link,
    };
  } catch (error) {
    if (createdPostId !== undefined) {
      await api.delete(`sermons/${createdPostId}?force=true`).catch(() => undefined);
    }
    await api.delete(`media/${uploaded.id}?force=true`).catch(() => undefined);
    throw error;
  }
}

export const publishSermonInternals = {
  formatDuration,
  nextDate,
  normalizedTermName,
  personNamesMatch,
  similarity,
  termSlug,
  verifyUploadedMediaUrl,
};
