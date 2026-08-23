import type { SermonMetadata } from "../config/schema.js";

const churchName = "Providence Church";

export interface Mp3Metadata {
  album: string;
  albumArtist: string;
  artist: string;
  comment: string;
  date: string;
  genre: string;
  title: string;
}

export function formatSermonDate(isoDate: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

export function buildMp3Metadata(metadata: SermonMetadata): Mp3Metadata {
  return {
    artist: metadata.preacher,
    album: metadata.sermonSeries,
    albumArtist: churchName,
    genre: "Preaching",
    title: metadata.title ?? metadata.scripture,
    date: metadata.date.slice(0, 4),
    comment: `${churchName}. ${formatSermonDate(metadata.date)}. ${metadata.scripture}.`,
  };
}
