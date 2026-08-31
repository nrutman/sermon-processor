import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFile, type IAudioMetadata } from "music-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../../process/run-command.js";
import { verifyMp3Metadata } from "../metadata.js";
import type { AudioRuntime } from "../runtime.js";

vi.mock("music-metadata", () => ({ parseFile: vi.fn<typeof parseFile>() }));

const temporaryDirectories: string[] = [];
const runtime: AudioRuntime = {
  ffmpegPath: "ffmpeg",
  ffmpegVersion: "test",
  ffprobePath: "ffprobe",
  ffprobeVersion: "test",
};

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("verifyMp3Metadata", () => {
  it("rejects mismatched tags, artwork, codec, channels, and bitrate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sermon-metadata-"));
    temporaryDirectories.push(directory);
    const artworkPath = join(directory, "artwork.png");
    await writeFile(artworkPath, "expected artwork");
    const parsed: IAudioMetadata = {
      common: {
        album: "Wrong Album",
        albumartist: "Wrong Organization",
        artist: "Wrong Artist",
        disk: { no: null, of: null },
        genre: ["Music"],
        movementIndex: { no: null, of: null },
        picture: [],
        title: "Wrong Title",
        track: { no: null, of: null },
        year: 2025,
      },
      format: { tagTypes: [], trackInfo: [] },
      native: {},
      quality: { warnings: [] },
    };
    vi.mocked(parseFile).mockResolvedValue(parsed);
    const runner: CommandRunner = {
      async run() {
        return {
          stderr: "",
          stdout: JSON.stringify({
            format: { bit_rate: "128000", duration: "60", tags: { comment: "Wrong" } },
            streams: [
              {
                bit_rate: "128000",
                channels: 2,
                codec_name: "aac",
                codec_type: "audio",
                sample_rate: "48000",
              },
            ],
          }),
        };
      },
    };

    await expect(
      verifyMp3Metadata(
        join(directory, "output.mp3"),
        {
          album: "Expected Album",
          albumArtist: "Expected Organization",
          artist: "Expected Artist",
          comment: "Expected comment",
          date: "2026",
          genre: "Preaching",
          title: "Expected Title",
        },
        artworkPath,
        runtime,
        runner,
      ),
    ).rejects.toThrow(
      /artwork: expected the supplied album artwork to be embedded[\s\S]*codec: expected "mp3"[\s\S]*channels: expected 1[\s\S]*bitrate: expected approximately 64000/,
    );
  });
});
