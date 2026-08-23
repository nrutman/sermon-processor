---
name: process-sermon
description: Processes a Providence Church AIFF sermon recording into a cleaned, leveled, 64 kbps MP3 and reviews its QC report. Use when preparing Sunday sermon audio for publication.
compatibility: Requires Node.js 22+, pnpm 11, FFmpeg, and FFprobe.
---

# Process a sermon recording

## Gather metadata

Obtain the AIFF path, preacher, sermon series, ISO sermon date, and main
scripture reference. Ask for a title only when it should differ from the
scripture reference.

## Verify the project

From the repository root, run:

```sh
pnpm install
pnpm check
```

If FFmpeg is unavailable on macOS, ask before running `brew install ffmpeg`.

## Process

```sh
pnpm dev process <input.aiff> \
  --preacher "<preacher>" \
  --series "<series>" \
  --date <yyyy-mm-dd> \
  --scripture "<reference>"
```

Never add `--overwrite` without confirming that replacing the existing MP3 is
intended. Never modify the AIFF source.

## Review

Read `<output.mp3>.qc.json` and report:

- Output path and duration
- Measured output loudness and true peak
- Derived noise floor and silence threshold
- Every removed microphone-handling event with timestamp and confidence
- Every report-only event that may need listening review
- Any warnings

When an event is ambiguous, do not suggest lowering the global confidence
threshold until the recording has been reviewed around that timestamp.
