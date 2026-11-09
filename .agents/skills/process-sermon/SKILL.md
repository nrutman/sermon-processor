---
name: process-sermon
description: Processes an AIFF or WAV sermon recording into a cleaned, leveled, 64 kbps MP3 and reviews its QC report. Use when preparing sermon audio for publication.
compatibility: Requires Node.js 22.12+, 24.x, or 26+, pnpm 12, FFmpeg, and FFprobe.
---

# Process a sermon recording

## 1. Find source and confirm metadata

- Search `~/Library/CloudStorage/Dropbox/Sermons` for the requested sermon date.
- Use `~/Dropbox/Sermons` on legacy Dropbox installations.
- Obtain an AIFF/PCM WAV path and ISO date; ask if missing or ambiguous.
- Never substitute another date's recording.

When Planning Center is configured:

```sh
pnpm plan-metadata --date <yyyy-mm-dd> --json
```

| Field                                       | Confirmation rule                                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Preacher, Series, scripture, title, artwork | Present inferred values and obtain user confirmation before processing. Services metadata is not approval.                                     |
| Missing metadata                            | Ask for preacher, Series, main scripture, and JPEG/PNG artwork. Ask for a title only if it should differ from scripture.                       |
| Artwork URL                                 | Download with `curl -fL`, verify JPEG/PNG with `file`, then pass a local path. Never infer/reuse another Series' artwork without confirmation. |

## 2. Verify project

Run from repository root:

```sh
pnpm install
pnpm check
```

Ask before installing missing FFmpeg with `brew install ffmpeg` on macOS.

## 3. Process

```sh
pnpm process <input.aiff-or-wav> \
  --preacher "<preacher>" \
  --series "<series>" \
  --date <yyyy-mm-dd> \
  --scripture "<reference>" \
  --artwork "<artwork.jpg-or-png>"
```

- Add `--title "<title>"` when confirmed title differs from scripture.
- Never modify source or add `--overwrite` without confirming replacement.
- Use `.env.local` output settings unless `--output` is supplied.
- Never commit `.env.local`; `.env` documents supported variables.

### Processing guarantees

| Area           | Behavior                                                                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Denoising      | Sample speech-free room tone before level changes; apply 15-band FFmpeg profile; remeasure noise and derive separate analysis/pause thresholds.                                                                                  |
| PCM mastering  | Normalize lossless PCM with initial 2.8 dB codec headroom; independently verify before MP3 encoding.                                                                                                                             |
| PCM undershoot | Apply bounded gain if measured peak margin permits; otherwise use measured dynamic normalization. Verify recovered PCM and record warnings.                                                                                      |
| MP3 encoding   | Encode without additional DSP; independently verify MP3 loudness, peak, technical properties, and metadata.                                                                                                                      |
| Codec recovery | Correct codec loudness loss only within both measured peak margins. Retry normalization/encoding from premaster for eligible peak overshoot. Gain-corrected encodes may retry despite insufficient predicted attenuation margin. |
| Delivery       | All output must pass unchanged loudness and true-peak checks.                                                                                                                                                                    |

See [pipeline guide](../../../docs/processing-pipeline.md) for defaults and stage details.

## 4. Handle failures

1. Report preserved work directory and exact failed check.
2. Inspect available stage files below; distinguish edits, normalization, resampling, and codec loss.
3. Measure normalized PCM and MP3 separately before considering any delivery-target change.
4. Resume through the checkpoint; never rerun cleanup solely to experiment with encoding.

| File                                       | Inspect for                           |
| ------------------------------------------ | ------------------------------------- |
| `04-transcript-clean.wav`                  | Semantic gap shortening               |
| `05-premaster.wav`                         | Pacing, leveling, compression         |
| `06-normalized.wav`                        | PCM normalization/resampling          |
| `06-corrected.wav` / `06-renormalized.wav` | PCM recovery, if not already promoted |
| `08-corrected.wav`                         | Codec-loss PCM gain, when present     |
| `07-output.mp3`                            | Lossy encoding effects, when present  |

After preparation, work directory contains `encoding-checkpoint.json`:

```sh
pnpm resume <preserved-work-directory>/encoding-checkpoint.json
```

- Resume verifies source, artwork, and premaster SHA-256; retains original edit audit.
- It never repeats decoding, denoising, VAD, or transcription.
- It refuses existing MP3s even if original request used `--overwrite`.
- Both recovered PCM and MP3 are remeasured against unchanged delivery targets.
- Never bypass failed QC or write ad-hoc recovery scripts.
- Older failed runs without checkpoints are not automatically resumable.

## 5. Review QC

Read `.sermon-qc/<output-filename>.qc.json`. Report:

| Category       | Required details                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| Delivery       | Output path, duration, measured loudness and true peak                                                 |
| PCM            | Measured normalized-PCM loudness/peak and codec-headroom target                                        |
| Size           | Actual bytes versus `durationSeconds × 8,000` bytes plus small metadata/container overhead             |
| Artwork        | Embedded presence, MIME type, byte size                                                                |
| Denoising      | Pre/post noise floors, room-tone interval, conservative analysis threshold, pause-shortening threshold |
| Handling noise | Every removed event with timestamp/confidence; every report-only event needing listening review        |
| Transcription  | Every shortened/reported gap, including Whisper/VAD disagreements                                      |
| Warnings       | All warnings and recovery actions                                                                      |

- For large event lists, give a concise summary and linked, readable audit containing **every** event; do not omit entries.
- Listen around ambiguous events before suggesting a lower global confidence threshold.
- Treat material size mismatch as encoding-verification failure, not a valid MP3 based on extension.
- Keep QC in gitignored `.sermon-qc/`, separate from MP3 destination.
- Do not claim listening review from automated QC alone.
