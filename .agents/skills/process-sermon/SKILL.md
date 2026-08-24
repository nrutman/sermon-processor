---
name: process-sermon
description: Processes an AIFF sermon recording into a cleaned, leveled, 64 kbps MP3 and reviews its QC report. Use when preparing sermon audio for publication.
compatibility: Requires Node.js 22+, pnpm 11, FFmpeg, and FFprobe.
---

# Process a sermon recording

## Gather metadata

Obtain the AIFF path, preacher, sermon series, ISO sermon date, and main
scripture reference. Also obtain JPEG or PNG album artwork as a local path or
URL. Ask for a title only when it should differ from the scripture reference.

When artwork is supplied as a URL, download it with `curl -fL`, confirm that
`file` identifies it as JPEG or PNG, and pass the local file to the CLI. Do not
infer or reuse artwork from another series without confirmation.

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
  --scripture "<reference>" \
  --artwork "<artwork.jpg-or-png>"
```

Never add `--overwrite` without confirming that replacing the existing MP3 is
intended. Never modify the AIFF source.

Unless `--output` is supplied, use the output variables from `.env.local`.
Never commit `.env.local`; `.env` documents the required variable names.

The pipeline normalizes a lossless PCM master before encoding. It reserves 2.5
dB of codec headroom below the configured final true-peak ceiling, verifies the
PCM master, encodes the MP3 without additional DSP, and then verifies the MP3.
Before level-changing processing, it selects a speech-free room-tone interval,
captures a 15-band FFmpeg noise profile, and applies that profile across the
recording. It then re-measures the denoised noise floor and derives a separate,
more permissive threshold for shortening long non-speech pauses.

## Handle failures

The CLI preserves its work directory automatically when any processing or QC
step fails. Report that directory and inspect the numbered stage files before
retrying. In particular, compare `04-premaster.wav`, `05-normalized.wav`, and
`06-output.mp3` to identify whether a failure came from normalization,
resampling, or lossy encoding. Do not rerun the complete source pipeline merely
to experiment with the final encode.

Never bypass a failed loudness or true-peak check. Do not change the delivery
target until the preserved normalized PCM and encoded MP3 have been measured
separately.

## Review

Read `.sermon-qc/<output-filename>.qc.json` and report:

- Output path and duration
- Measured output loudness and true peak
- Measured normalized-PCM loudness and true peak, plus its codec-headroom target
- Actual file size compared with the size implied by 64 kbps and the duration
- Embedded album artwork presence, MIME type, and byte size
- Pre- and post-denoise noise floors, the sampled room-tone interval, and both
  the conservative analysis threshold and pause-shortening threshold
- Every removed microphone-handling event with timestamp and confidence
- Every report-only event that may need listening review
- Any warnings

When an event is ambiguous, do not suggest lowering the global confidence
threshold until the recording has been reviewed around that timestamp.

At 64 kbps, expected payload size is approximately `durationSeconds × 8,000`
bytes, plus small metadata/container overhead. Treat a material discrepancy as
an encoding-verification failure rather than accepting the file based only on
its extension.

QC reports remain in the gitignored `.sermon-qc/` project directory so they can
be analyzed across past processing runs without cluttering the MP3 destination.
