import { copyFile, link, readFile, rm } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import type { ProcessingOptions } from "../config/schema.js";
import type { CommandRunner } from "../process/run-command.js";
import type { SpeechSegment } from "./handling-noise.js";
import type { AudioRuntime } from "./runtime.js";

const whisperJsonSchema = z.object({
  result: z.object({ language: z.string().optional() }).optional(),
  transcription: z
    .array(
      z.object({
        offsets: z.object({ from: z.number(), to: z.number() }).optional(),
        tokens: z
          .array(
            z.object({
              offsets: z.object({ from: z.number(), to: z.number() }).optional(),
              p: z.number().optional(),
              text: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

export interface TranscriptWord {
  confidence: number;
  endSeconds: number;
  startSeconds: number;
  text: string;
}

export interface TranscriptGap {
  action: "reported" | "shortened";
  durationSeconds: number;
  endSeconds: number;
  reason?: string;
  startSeconds: number;
}

export interface TranscriptionAnalysis {
  gaps: TranscriptGap[];
  language: string;
  model: string;
  toolVersion: string;
  vadModel: string;
  words: TranscriptWord[];
}

function isWordToken(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text) && !text.startsWith("[");
}

export function parseWhisperWords(output: string): TranscriptWord[] {
  const parsed = whisperJsonSchema.parse(JSON.parse(output));
  return (parsed.transcription ?? [])
    .flatMap((segment) => {
      const tokens = segment.tokens ?? [];
      const firstLexicalToken = tokens.find(
        (token) => token.text !== undefined && isWordToken(token.text),
      );
      const offsetShiftMilliseconds =
        segment.offsets?.from !== undefined && firstLexicalToken?.offsets?.from !== undefined
          ? segment.offsets.from - firstLexicalToken.offsets.from
          : 0;
      return tokens.map((token) => ({ token, offsetShiftMilliseconds }));
    })
    .flatMap(({ token, offsetShiftMilliseconds }) => {
      const text = token.text?.trim();
      const startMilliseconds = token.offsets?.from;
      const endMilliseconds = token.offsets?.to;
      const confidence = token.p;
      if (
        text === undefined ||
        !isWordToken(text) ||
        confidence === undefined ||
        startMilliseconds === undefined ||
        endMilliseconds === undefined ||
        endMilliseconds < startMilliseconds
      ) {
        return [];
      }
      return [
        {
          text,
          confidence,
          startSeconds: (startMilliseconds + offsetShiftMilliseconds) / 1_000,
          endSeconds: (endMilliseconds + offsetShiftMilliseconds) / 1_000,
        },
      ];
    })
    .toSorted((left, right) => left.startSeconds - right.startSeconds);
}

export function classifyTranscriptGaps(
  words: TranscriptWord[],
  speechSegments: SpeechSegment[],
  options: ProcessingOptions["transcription"],
): TranscriptGap[] {
  const confidentWords = words.filter((word) => word.confidence >= options.minimumWordConfidence);
  return confidentWords.slice(1).flatMap((word, index) => {
    const previous = confidentWords[index];
    if (previous === undefined) return [];
    const startSeconds = previous.endSeconds;
    const endSeconds = word.startSeconds;
    const durationSeconds = endSeconds - startSeconds;
    if (durationSeconds < options.minimumGapSeconds) return [];

    const uncertainWord = words.find(
      (candidate) =>
        candidate.confidence < options.minimumWordConfidence &&
        candidate.endSeconds > startSeconds &&
        candidate.startSeconds < endSeconds,
    );

    const overlappingSpeech = speechSegments.find((segment) => {
      const overlapSeconds =
        Math.min(segment.endSeconds, endSeconds) - Math.max(segment.startSeconds, startSeconds);
      return overlapSeconds >= 0.1;
    });
    const isBoundedDuration = durationSeconds <= options.maximumGapSeconds;
    const shouldShorten =
      overlappingSpeech === undefined && uncertainWord === undefined && isBoundedDuration;
    return [
      {
        action: shouldShorten ? "shortened" : "reported",
        durationSeconds,
        endSeconds,
        ...(!shouldShorten
          ? {
              reason:
                uncertainWord !== undefined
                  ? `Whisper produced a low-confidence word (${JSON.stringify(uncertainWord.text)}, confidence ${uncertainWord.confidence.toFixed(3)})`
                  : overlappingSpeech !== undefined
                    ? `Silero VAD detected possible speech overlap (${overlappingSpeech.startSeconds.toFixed(3)}–${overlappingSpeech.endSeconds.toFixed(3)}s)`
                    : `Transcript gap exceeds the ${options.maximumGapSeconds.toFixed(1)} second automatic limit`,
            }
          : {}),
        startSeconds,
      },
    ];
  });
}

function buildGapShorteningFilter(
  durationSeconds: number,
  gaps: TranscriptGap[],
  retainedGapSeconds: number,
  crossfadeSeconds: number,
): string | undefined {
  const cuts = gaps
    .filter((gap) => gap.action === "shortened")
    .map((gap) => ({
      start: gap.startSeconds + retainedGapSeconds / 2,
      end: gap.endSeconds - retainedGapSeconds / 2,
    }))
    .filter(
      (cut) =>
        cut.end - cut.start > crossfadeSeconds && cut.start > 0.05 && cut.end < durationSeconds,
    );
  if (cuts.length === 0) return undefined;

  const segments: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor) segments.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < durationSeconds) segments.push({ start: cursor, end: durationSeconds });
  if (segments.length < 2) return undefined;

  const trims = segments.map(
    (segment, index) =>
      `[0:a]atrim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},asetpts=PTS-STARTPTS[s${index}]`,
  );
  let previous = "s0";
  const joins: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const output = index === segments.length - 1 ? "out" : `x${index}`;
    joins.push(
      `[${previous}][s${index}]acrossfade=d=${crossfadeSeconds.toFixed(3)}:c1=tri:c2=tri[${output}]`,
    );
    previous = output;
  }
  return [...trims, ...joins].join(";");
}

async function reuseLosslessStage(input: string, output: string): Promise<void> {
  try {
    await link(input, output);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP") throw error;
    await copyFile(input, output);
  }
}

function parseVersion(output: string): string {
  return output.match(/whisper\.cpp version:\s*([^\s]+)/)?.[1] ?? "unknown";
}

export async function transcribeAndShortenGaps(
  analysisInput: string,
  renderInput: string,
  output: string,
  outputPrefix: string,
  durationSeconds: number,
  speechSegments: SpeechSegment[],
  options: ProcessingOptions["transcription"],
  runtime: AudioRuntime,
  runner: CommandRunner,
): Promise<TranscriptionAnalysis | undefined> {
  if (!options.enabled || options.modelPath === undefined) {
    await reuseLosslessStage(renderInput, output);
    return undefined;
  }
  if (options.vadModelPath === undefined) {
    throw new Error("A Whisper VAD model path is required when transcription is enabled");
  }

  const command = options.command ?? "whisper-cli";
  const versionResult = await runner.run(command, ["--version"]);
  await runner.run(command, [
    "-m",
    options.modelPath,
    "-f",
    analysisInput,
    "-l",
    options.language,
    "-ojf",
    "-of",
    outputPrefix,
    "-np",
    "-sns",
    "--vad",
    "-vm",
    options.vadModelPath,
    "-vsd",
    "500",
    "-vp",
    "100",
  ]);
  const transcriptPath = `${outputPrefix}.json`;
  try {
    const transcriptJson = await readFile(transcriptPath, "utf8");
    const parsed = whisperJsonSchema.parse(JSON.parse(transcriptJson));
    const words = parseWhisperWords(transcriptJson);
    const gaps = classifyTranscriptGaps(words, speechSegments, options);
    const filter = buildGapShorteningFilter(
      durationSeconds,
      gaps,
      options.retainedGapSeconds,
      options.crossfadeSeconds,
    );
    if (filter === undefined) {
      await reuseLosslessStage(renderInput, output);
    } else {
      await runner.run(runtime.ffmpegPath, [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i",
        renderInput,
        "-filter_complex",
        filter,
        "-map",
        "[out]",
        "-c:a",
        "pcm_s24le",
        output,
      ]);
    }
    return {
      gaps,
      language: parsed.result?.language ?? options.language,
      model: basename(options.modelPath),
      toolVersion: parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`),
      vadModel: basename(options.vadModelPath),
      words,
    };
  } finally {
    await rm(transcriptPath, { force: true });
  }
}

export const transcriptionInternals = { buildGapShorteningFilter };
