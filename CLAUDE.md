# Sermon Processor agent guidance

## Purpose

This repository contains a TypeScript CLI that cleans and masters AIFF sermon
recordings. TypeScript orchestrates established audio tools; FFmpeg performs the
DSP. Do not reimplement codecs, filters, FFTs, resampling, or loudness algorithms
in application code when a maintained third-party tool already provides them.

## Commands

```sh
pnpm install
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm check
```

Dependencies must be at least three days old. Keep `minimumReleaseAge: 4320`
and `minimumReleaseAgeStrict: true` in `pnpm-workspace.yaml`.

## Audio safety rules

- Preserve the source file; never edit it in place.
- Keep processing stages lossless until the final MP3 encode.
- Run loudness normalization after every duration- or level-changing edit.
- Only delete handling-noise events with quiet boundaries and confidence at or
  above the configured threshold. Report ambiguous events instead.
- Prefer shortening long silence to a natural pause over joining speech with no
  pause.
- Verify the final codec, bitrate, channels, loudness, and metadata rather than
  trusting the render command.
- Record derived thresholds, tool versions, edits, and warnings in the QC report.

## Architecture

- `src/config/`: validated user input and processing defaults
- `src/audio/`: FFmpeg analysis, filtering, encoding, and verification
- `src/process/`: pipeline orchestration and subprocess boundary
- `src/report/`: stable machine-readable QC report contracts
- `src/metadata/`: sermon-specific metadata formatting
- `test/`: unit tests plus generated integration fixtures

Pass subprocess arguments as arrays. Do not interpolate shell command strings.
Inject `CommandRunner` in tests instead of adding test-only dependencies to
production interfaces.

Keep output naming configurable through `sermon.config.json`; do not hardcode
paths or filename formats in the CLI.

## Testing

Assert observable behavior and audio metrics rather than exact encoded bytes.
Generated fixtures must cover clean speech, differing levels, room tone,
silences around the one-second boundary, handling noise, plosives, and Unicode
metadata. Any detector change must show that it removes the known handling-noise
fixture without removing the speech-like negative fixture.
