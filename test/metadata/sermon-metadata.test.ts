import { describe, expect, it } from "vitest";
import { buildMp3Metadata, formatSermonDate } from "../../src/metadata/sermon-metadata.js";

describe("sermon metadata", () => {
  it("formats an organization comment with Unicode scripture punctuation", () => {
    expect(
      buildMp3Metadata({
        organization: "Example Organization",
        preacher: "Jane Smith",
        sermonSeries: "The Kingdom",
        date: "2026-08-23",
        scripture: "Matthew 7:7–12",
      }),
    ).toEqual({
      artist: "Jane Smith",
      album: "The Kingdom",
      albumArtist: "Example Organization",
      genre: "Preaching",
      title: "Matthew 7:7–12",
      date: "2026",
      comment: "Example Organization. Sunday, August 23, 2026. Matthew 7:7–12.",
    });
  });

  it("derives the weekday from the supplied date", () => {
    expect(formatSermonDate("2026-08-24")).toBe("Monday, August 24, 2026");
  });
});
