# Sermon Processor

[![CI](https://github.com/nrutman/sermon-processor/actions/workflows/ci.yml/badge.svg)](https://github.com/nrutman/sermon-processor/actions/workflows/ci.yml)

Clean and master AIFF or PCM WAV sermons into mono **64 kbps MP3** files. FFmpeg
performs DSP; TypeScript coordinates analysis, safe edits, metadata, and QC.

**Safety first:** source recordings stay unchanged. Ambiguous noise and possible
speech remain in the audio and appear in the QC report.

## Guides

| Guide                                                      | Purpose                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| [Processing pipeline](docs/processing-pipeline.md)         | Stages, delivery targets, recovery, detector limits           |
| [Process a sermon](.agents/skills/process-sermon/SKILL.md) | Agent workflow: source, metadata confirmation, processing, QC |
| [Publish a sermon](.agents/skills/publish-sermon/SKILL.md) | Agent workflow: plan, draft, verify, approve, clean up        |
| [Agent guidance](AGENTS.md)                                | Repository rules; canonical source for `CLAUDE.md` symlink    |

## Setup

| Requirement        | Version / purpose                                    |
| ------------------ | ---------------------------------------------------- |
| Node.js            | 22.12+ on 22.x, 24.x, or 26+                         |
| pnpm               | 12                                                   |
| FFmpeg and FFprobe | Required filters and LAME encoder checked at startup |
| whisper.cpp        | Optional transcription-assisted gap shortening       |

```sh
# macOS audio tools; omit whisper.cpp if transcription is not needed.
brew install ffmpeg whisper.cpp
pnpm install
cp .env .env.local
```

Fill in `.env.local` before processing. Keep credentials and deployment-specific
values out of tracked files.

### Configuration

[`.env`](.env) documents every supported variable. Precedence:
**runtime environment → `.env.local` → `.env`**.

| Variables                                                                                       | Purpose                                               |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `SERMON_ORGANIZATION`                                                                           | MP3 album artist and comment                          |
| `SERMON_OUTPUT_DIRECTORY`                                                                       | Destination directory; supports `~`                   |
| `SERMON_FILENAME_FORMAT`                                                                        | Template containing `YYYY`, `MM`, `DD`, and `LAST`    |
| `WHISPER_CLI_PATH`, `WHISPER_MODEL_PATH`, `WHISPER_VAD_MODEL_PATH`                              | Optional local transcription                          |
| `PLANNING_CENTER_CLIENT_ID`, `PLANNING_CENTER_SECRET`, `PLANNING_CENTER_USER_AGENT`             | Read-only Services metadata lookup                    |
| `PLANNING_CENTER_DEFAULT_SERVICE_TYPE_ID`                                                       | Default Service Type; otherwise pass `--service-type` |
| `WORDPRESS_URL`, `WORDPRESS_USERNAME`, `WORDPRESS_APPLICATION_PASSWORD`, `WORDPRESS_MEDIA_HOST` | Receipt-based publication                             |

Example output configuration:

```dotenv
SERMON_ORGANIZATION=Example Church
SERMON_OUTPUT_DIRECTORY=~/Downloads
SERMON_FILENAME_FORMAT=SERMON-YYYY-MM-DD-LAST.mp3
```

Preacher `Alex Parker` and date `2026-08-23` produce
`~/Downloads/SERMON-2026-08-23-Parker.mp3`. Use `--output <path>` for a one-run
override. Missing output directories are created automatically.

### Optional transcription models

1. Download a local GGML model from the [whisper.cpp model repository](https://huggingface.co/ggerganov/whisper.cpp/tree/main).
2. Download Silero VAD from the [whisper-vad repository](https://huggingface.co/ggml-org/whisper-vad).
3. Set both model paths in `.env.local`.

- Neither path set: transcription stays disabled.
- Only one path set: configuration fails rather than weakening the speech guard.
- Models are never downloaded or substituted during processing.
- Handling-noise speech protection separately uses local Silero VAD bundled with MIT-licensed `avr-vad`.

## Process audio

Default source folder: `~/Library/CloudStorage/Dropbox/Sermons`
(`~/Dropbox/Sermons` on legacy installations). The CLI takes an explicit input
path; agents search this folder for the requested date.

```sh
pnpm check
pnpm process sermon.wav \
  --preacher "Alex Parker" \
  --series "Example Series" \
  --date 2026-08-23 \
  --scripture "Matthew 5:1–12" \
  --artwork "example-series.png"
```

- Add `--title "Sample Sermon"` if the title differs from the scripture reference.
- Do not use `--overwrite` without confirming replacement is intended.
- Use `--keep-work-files` to retain successful-run intermediate WAV files.
- Read `.sermon-qc/<output-filename>.qc.json` before publication.

### Planning Center metadata

```sh
pnpm plan-metadata --date 2026-08-23 --json
```

- Lookup makes only `GET` requests; infers preacher, Series, scripture, title, and artwork.
- Pass `--service-type <id>` to select a Service Type; use `--plan-id <id>` for ambiguous dates.
- Confirm inferred metadata and artwork before processing.
- Download artwork URLs with `curl -fL`; verify JPEG/PNG with `file`, then pass a local path.

### QC and encoding recovery

| Check                | Expected result                                                                      |
| -------------------- | ------------------------------------------------------------------------------------ |
| Technical output     | Mono 64 kbps MP3, verified metadata and embedded artwork                             |
| Loudness / true peak | Independently measured PCM and MP3 pass unchanged delivery targets                   |
| File size            | Approximately `durationSeconds × 8,000` bytes plus metadata/container overhead       |
| Edit audit           | Every handling decision, transcript gap, disagreement, and warning recorded          |
| Reproducibility      | Tool versions, model details, thresholds, output SHA-256, and stage timings recorded |

Failed processing preserves its work directory. After preparation, recover with:

```sh
pnpm resume <work-directory>/encoding-checkpoint.json
```

- Resume verifies source, artwork, and premaster SHA-256; retains edit audit and preparation timings.
- Resume never repeats decoding, denoising, VAD, or transcription, and never overwrites an MP3.
- PCM undershoot uses bounded gain or measured dynamic normalization; codec overshoot can trigger fresh normalization with more headroom.
- Every recovered PCM and MP3 must still pass QC. Never bypass failed loudness/peak checks.
- Older failed runs without checkpoints are not automatically resumable.

See [pipeline details](docs/processing-pipeline.md) for recovery behavior and limits.

## Publish to WordPress

Configure the theme/plugin to expose `ct_sermon`, `sermon_speaker`, and
`sermon_series` through the standard REST API. Set Application Password credentials
and exact offloaded media hostname in `.env.local`.

### Weekly workflow

```sh
pnpm publication plan ~/Downloads/SERMON-2026-08-23-Parker.mp3 \
  --qc .sermon-qc/SERMON-2026-08-23-Parker.mp3.qc.json \
  --receipt .sermon-qc/SERMON-2026-08-23-Parker.publication.json \
  --preacher "Alex Parker" --series "Example Series" --date 2026-08-23 \
  --scripture "Matthew 5:1–12" --title "Sample Sermon"
pnpm publication draft .sermon-qc/SERMON-2026-08-23-Parker.publication.json
pnpm publication verify .sermon-qc/SERMON-2026-08-23-Parker.publication.json
# Only after explicit publication approval:
pnpm publication publish .sermon-qc/SERMON-2026-08-23-Parker.publication.json --approve
pnpm publication cleanup .sermon-qc/SERMON-2026-08-23-Parker.publication.json
```

| Step                | Safety contract                                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan`              | Read-only remotely; creates a new local receipt. Checks QC fingerprint, existing speaker/Series, duplicate dates including trash, orphan media, and `America/New_York` timezone. Present before mutation. |
| `draft`             | Journals mutations; uploads audio and creates a draft. Supply `--artwork` to `plan` if the Series has no reusable image.                                                                                  |
| `verify`            | Checks metadata, artwork, audio association, HTTPS media host, full remote SHA-256, and HTTP 404 for equivalent local upload path.                                                                        |
| `publish --approve` | Publishes same verified draft at noon Eastern; verifies public page/title and remote audio. Never uploads another MP3.                                                                                    |
| `cleanup`           | Freshly verifies publication and matching bytes; removes only matching local MP3. Keeps sources, artwork, QC, receipts, and diagnostics.                                                                  |

- Receipts pin file hashes and site configuration, never credentials. Never overwrite them.
- Legacy QC without an output fingerprint needs supported re-verification; never insert a hash manually.
- Verification and repeated cleanup still work after local MP3 removal.

### Uncertain publication state

```sh
pnpm publication reconcile <receipt.json>
# Only after inspection and explicit post selection:
pnpm publication reconcile <receipt.json> --post-id <id>
pnpm publication verify <receipt.json>
```

- Reconciliation makes remote `GET` requests only; adoption requires full verification.
- Never reupload blindly, delete a receipt, or create another plan to bypass failure.
- Orphan attachments need operator review; keep local audio until publication is verified.
- Remove stale locks only after confirming no owning process is running.

## Development checks

| Command              | Purpose                                |
| -------------------- | -------------------------------------- |
| `pnpm check`         | Formatting, typecheck, lint, and tests |
| `pnpm test:coverage` | Find untested behavior                 |
| `pnpm build`         | Compile production CLI                 |

CI runs formatting, typechecking, type-aware lint, Vitest coverage (including
FFmpeg/Silero integration tests), and production build on Node.js 24.

Dependencies must be at least three days old. Keep `minimumReleaseAge: 4320`
and `minimumReleaseAgeStrict: true` in `pnpm-workspace.yaml`.
