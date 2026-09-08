# Sermon Processor

[![CI](https://github.com/nrutman/sermon-processor/actions/workflows/ci.yml/badge.svg)](https://github.com/nrutman/sermon-processor/actions/workflows/ci.yml)

A TypeScript CLI that turns AIFF sermon recordings into cleaned, leveled,
speech-optimized 64 kbps MP3 files. FFmpeg performs the audio processing; the
TypeScript application analyzes recordings, builds a reproducible filter plan,
verifies output, and writes a QC report.

## Status

The initial implementation targets conservative automatic processing. Suspected
microphone-handling bursts are removed only when the detector has high
confidence that no speech is present; ambiguous regions are included in the QC
report for review.

## Requirements

- Node.js 22 or newer
- pnpm 11
- FFmpeg and FFprobe with the filters and LAME encoder checked at startup

The microphone-handling speech guard uses the pretrained Silero VAD model
bundled by the MIT-licensed `avr-vad` package and runs locally.

On macOS, install FFmpeg with `brew install ffmpeg`.

## Development

```sh
pnpm install
pnpm check
pnpm process sermon.aiff \
  --preacher "John Smith" \
  --series "Sermon on the Mount" \
  --date 2026-08-23 \
  --scripture "Matthew 7:7–12" \
  --artwork "sermon-on-the-mount.png"
```

## Planning Center metadata

The read-only Planning Center lookup can infer the date, preacher, sermon
series, scripture, title, and Series artwork from a Services plan:

```sh
pnpm plan-metadata --date 2026-08-30
pnpm plan-metadata --date 2026-08-30 --json
```

Configure the Personal Access Token credentials documented in `.env`. A
default Services Service Type is optional.

Pass `--service-type <id>` to override the configured Service Type. If more
than one plan exists on a date, pass `--plan-id <id>`. The command only makes
Planning Center `GET` requests. Its JSON output includes the original Series
artwork URL and image metadata when the linked Services Series has artwork.

Review the inferred fields before processing. Download Series artwork with
`curl -fL`, confirm that `file` identifies it as JPEG or PNG, and then pass its
local path to `process` with `--artwork`.

## Output configuration

`.env` is the checked-in configuration template and documents every supported
variable. Copy it to the gitignored `.env.local`, then fill in local values:

```sh
cp .env .env.local
```

Runtime environment variables override `.env.local`, which overrides `.env`.

The format must contain `YYYY`, `MM`, `DD`, and `LAST`. Given preacher
`Alex Parker` and date `2026-08-23`, the configured output is:

```text
~/Downloads/SERMON-2026-08-23-Parker.mp3
```

Use `--output <path>` to override environment configuration for one run. The
output directory is created when it does not already exist.

QC reports are written to the gitignored `.sermon-qc/` directory in the project
root, using the MP3 filename with a `.qc.json` suffix.

## WordPress publishing

Configure the active WordPress theme or plugin to expose the `ct_sermon`,
`sermon_speaker`, and `sermon_series` resources through the standard REST API.
Then add an Application Password and the site's offloaded media host to
`.env.local`:

```dotenv
WORDPRESS_URL=https://church.example.org
WORDPRESS_USERNAME=
WORDPRESS_APPLICATION_PASSWORD=
WORDPRESS_MEDIA_HOST=media.example.org
```

Upload a verified MP3 and create a draft sermon with:

```sh
pnpm publish-sermon ~/Downloads/SERMON-2026-08-23-Parker.mp3 \
  --qc .sermon-qc/SERMON-2026-08-23-Parker.mp3.qc.json \
  --preacher "Alex Parker" \
  --series "Example Series" \
  --date 2026-08-23 \
  --scripture "Matthew 5:1–12" \
  --title "Sample Sermon"
```

The publisher refuses duplicate sermon dates, sets the post time to noon,
matches close speaker and Series names, reuses the featured image from the
matched Series, and reads the post back for verification. It deletes the
uploaded media and refuses to create a sermon unless WordPress returns an HTTPS
URL on `WORDPRESS_MEDIA_HOST`. Keep all real site URLs, hostnames, usernames,
and organization values only in the gitignored `.env.local`. Add `--publish`
only when the sermon should be made public immediately.

Dependencies must be at least three days old. This is enforced by
`minimumReleaseAge: 4320` in `pnpm-workspace.yaml`.

CI runs `oxfmt`, typechecking, type-aware `oxlint`, Vitest coverage (including
FFmpeg and Silero integration tests), and the production build on Node.js 24.
