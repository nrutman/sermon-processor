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
pnpm dev process sermon.aiff \
  --preacher "John Smith" \
  --series "Sermon on the Mount" \
  --date 2026-08-23 \
  --scripture "Matthew 7:7–12"
```

## Output configuration

`.env` is the committed configuration template:

```dotenv
SERMON_ORGANIZATION=
SERMON_OUTPUT_DIRECTORY=
SERMON_FILENAME_FORMAT=
```

Copy those variables into the gitignored `.env.local` and fill in the values
for your environment:

```dotenv
SERMON_ORGANIZATION=Example Organization
SERMON_OUTPUT_DIRECTORY=~/Downloads
SERMON_FILENAME_FORMAT=SERMON-YYYY-MM-DD-LAST
```

Runtime environment variables override `.env.local`, which overrides `.env`.

The format must contain `YYYY`, `MM`, `DD`, and `LAST`. Given preacher
`Rob Ivy` and date `2026-08-23`, the configured output is:

```text
~/Downloads/SERMON-2026-08-23-Ivy.mp3
```

Use `--output <path>` to override environment configuration for one run. The
output directory is created when it does not already exist.

Dependencies must be at least three days old. This is enforced by
`minimumReleaseAge: 4320` in `pnpm-workspace.yaml`.

CI runs `oxfmt`, typechecking, type-aware `oxlint`, Vitest coverage (including
FFmpeg and Silero integration tests), and the production build on Node.js 24.
