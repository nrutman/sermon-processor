# Sermon Processor agent guidance

## Purpose and documentation

- Clean and master AIFF or PCM WAV recordings with a TypeScript CLI.
- Use FFmpeg for DSP. Do not reimplement codecs, filters, FFTs, resampling, or loudness algorithms.
- Keep this file canonical; `CLAUDE.md` must be a relative symlink to `AGENTS.md`.
- Use [process-sermon](.agents/skills/process-sermon/SKILL.md) and [publish-sermon](.agents/skills/publish-sermon/SKILL.md) for routine operations.
- See [README](README.md) for setup and [pipeline guide](docs/processing-pipeline.md) for audio behavior.

## Source recordings

- Default: `~/Library/CloudStorage/Dropbox/Sermons`.
- Legacy Dropbox: `~/Dropbox/Sermons`.
- Search for the requested sermon date before asking for a path.
- If missing or ambiguous, ask; never substitute another date's recording.

## Commands

| Command                                                            | Purpose                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| `pnpm install`                                                     | Install dependencies                                     |
| `pnpm check`                                                       | Formatting, typecheck, lint, and tests                   |
| `pnpm format:check` / `pnpm typecheck` / `pnpm lint` / `pnpm test` | Targeted checks                                          |
| `pnpm build`                                                       | Compile production CLI                                   |
| `pnpm resume <encoding-checkpoint.json>`                           | Recover normalization/encoding without repeating cleanup |

Dependencies must be at least three days old. Keep both settings in `pnpm-workspace.yaml`:

```yaml
minimumReleaseAge: 4320
minimumReleaseAgeStrict: true
```

## Audio safety

- Preserve source recordings; never edit in place.
- Keep stages lossless until final MP3 encoding.
- Normalize loudness after all duration- or level-changing edits.
- Delete handling noise only with quiet boundaries, no detected speech, and confidence at or above configured threshold. Report ambiguous events.
- Shorten long silence to a natural pause; do not join speech without a pause.
- Verify final codec, bitrate, channels, loudness, true peak, artwork, and metadata.
- Record derived thresholds, tool versions, edits, recovery actions, and warnings in QC.
- Recover encoding failures through the checkpoint; never rerun cleanup solely to experiment with encoding.
- Never bypass failed loudness/peak checks or silently relax delivery targets.

## Publication safety

1. Use committed `pnpm publication` commands and a gitignored receipt; no ad-hoc publishing scripts.
2. Present read-only `plan` before remote mutation.
3. Create `draft`, then `verify` metadata and remote audio.
4. Require explicit publication approval before `publish --approve`.
5. Reconcile uncertain remote state before retrying; never blindly upload again.
6. After verified publication, run `cleanup <receipt>` for the matching local processed MP3. Routine post-publication cleanup is permitted.

**Never remove source recordings, artwork, QC reports, receipts, or diagnostic stages.**

## Architecture and configuration

| Path                   | Responsibility                                             |
| ---------------------- | ---------------------------------------------------------- |
| `src/config/`          | Validated input, environment settings, processing defaults |
| `src/audio/`           | FFmpeg analysis, filtering, encoding, verification         |
| `src/process/`         | Orchestration, checkpoints, subprocess boundary            |
| `src/report/`          | Stable machine-readable QC contracts                       |
| `src/metadata/`        | Sermon metadata formatting                                 |
| `src/planning-center/` | Read-only Services metadata lookup                         |
| `src/wordpress/`       | WordPress publication and receipt lifecycle                |
| `src/**/__tests__/`    | Colocated unit and integration tests                       |

- Pass subprocess arguments as arrays; never interpolate shell command strings.
- Inject `CommandRunner` in tests; do not add test-only production dependencies.
- Keep output paths and filename formats configurable; do not hardcode CLI destinations.
- Keep `.env` as committed template; `.env.local` contains gitignored runtime values.
- Never commit credentials or generated/runtime artifacts.

## Testing

- Assert observable behavior and audio metrics, not exact encoded bytes.
- Cover clean speech, differing levels, room tone, silence around one second, handling noise, plosives, and Unicode metadata.
- Detector changes must remove known handling-noise fixtures without removing speech-like negative fixtures.
- Use coverage to find untested behavior, not to justify trivial callback/wrapper tests or unreachable post-validation guards.
- Prioritize audio integrity, publication safety, rollback behavior, and stable external-service contracts.

Whenever tests change, review the whole affected test surface and **present findings and recommendations**:

| Question                   | Look for                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| High-value cases missing?  | Safety guards, boundaries, errors, observable fallback behavior                                    |
| Consolidation possible?    | Shared setup or parameterized cases without conditional test bodies or lost descriptive names      |
| Low-value cases removable? | Tautological, implementation-coupled, or redundant assertions; retain unique regression protection |
