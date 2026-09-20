import { extname, resolve } from "node:path";
import { z } from "zod";

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date such as 2026-08-23")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
  }, "Date is not valid");

export const sermonMetadataSchema = z.object({
  organization: z.string().trim().min(1),
  preacher: z.string().trim().min(1),
  sermonSeries: z.string().trim().min(1),
  date: isoDateSchema,
  scripture: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
});

const defaultHandlingNoise = {
  enabled: true,
  minimumDurationSeconds: 0.4,
  maximumDurationSeconds: 1.5,
  minimumConfidence: 0.86,
  crossfadeSeconds: 0.03,
} as const;

const defaultTranscription = {
  enabled: false,
  language: "en",
  maximumGapSeconds: 30,
  minimumGapSeconds: 2,
  minimumWordConfidence: 0.5,
  retainedGapSeconds: 0.4,
  crossfadeSeconds: 0.03,
} as const;

export const processingOptionsSchema = z.object({
  highpassHz: z.number().int().min(20).max(200).default(75),
  noiseReductionDb: z.number().min(0).max(24).default(10),
  leadingSpeechConfirmationSeconds: z.number().min(0.05).max(0.5).default(0.1),
  silenceMinimumSeconds: z.number().min(0.5).max(10).default(1),
  retainedSilenceSeconds: z.number().min(0.1).max(1).default(0.4),
  targetLufs: z.number().min(-24).max(-12).default(-16),
  truePeakDbtp: z.number().min(-6).max(-0.1).default(-1.5),
  targetLra: z.number().min(1).max(20).default(7),
  handlingNoise: z
    .object({
      enabled: z.boolean().default(true),
      minimumDurationSeconds: z.number().min(0.2).max(2).default(0.4),
      maximumDurationSeconds: z.number().min(0.5).max(3).default(1.5),
      minimumConfidence: z.number().min(0).max(1).default(0.86),
      crossfadeSeconds: z.number().min(0.005).max(0.1).default(0.03),
    })
    .default(defaultHandlingNoise),
  transcription: z
    .object({
      enabled: z.boolean().default(false),
      command: z.string().trim().min(1).optional(),
      modelPath: z.string().trim().min(1).optional(),
      vadModelPath: z.string().trim().min(1).optional(),
      language: z.string().trim().min(2).default("en"),
      maximumGapSeconds: z.number().min(2).max(300).default(30),
      minimumGapSeconds: z.number().min(1).max(30).default(2),
      minimumWordConfidence: z.number().min(0).max(1).default(0.5),
      retainedGapSeconds: z.number().min(0.1).max(1).default(0.4),
      crossfadeSeconds: z.number().min(0.005).max(0.1).default(0.03),
    })
    .default(defaultTranscription)
    .superRefine((value, context) => {
      if (value.enabled && value.modelPath === undefined) {
        context.addIssue({
          code: "custom",
          message: "A Whisper model path is required when transcription is enabled",
          path: ["modelPath"],
        });
      }
      if (value.enabled && value.vadModelPath === undefined) {
        context.addIssue({
          code: "custom",
          message: "A Whisper VAD model path is required when transcription is enabled",
          path: ["vadModelPath"],
        });
      }
      if (value.maximumGapSeconds < value.minimumGapSeconds) {
        context.addIssue({
          code: "custom",
          message: "Maximum transcription gap must be at least the minimum gap",
          path: ["maximumGapSeconds"],
        });
      }
    }),
});

const defaultProcessingOptions = {
  highpassHz: 75,
  noiseReductionDb: 10,
  leadingSpeechConfirmationSeconds: 0.1,
  silenceMinimumSeconds: 1,
  retainedSilenceSeconds: 0.4,
  targetLufs: -16,
  truePeakDbtp: -1.5,
  targetLra: 7,
  handlingNoise: defaultHandlingNoise,
  transcription: defaultTranscription,
} as const;

export const processRequestSchema = z.object({
  artwork: z
    .string()
    .min(1)
    .transform((value) => resolve(value)),
  input: z
    .string()
    .min(1)
    .transform((value) => resolve(value)),
  output: z
    .string()
    .min(1)
    .transform((value) => resolve(value)),
  qcDirectory: z
    .string()
    .min(1)
    .default(".sermon-qc")
    .transform((value) => resolve(value)),
  metadata: sermonMetadataSchema,
  processing: processingOptionsSchema.default(defaultProcessingOptions),
  overwrite: z.boolean().default(false),
  keepWorkFiles: z.boolean().default(false),
});

export type ProcessRequest = z.infer<typeof processRequestSchema>;
export type ProcessingOptions = z.infer<typeof processingOptionsSchema>;
export type SermonMetadata = z.infer<typeof sermonMetadataSchema>;

export function assertAudioInputPath(path: string): void {
  const extension = extname(path).toLowerCase();
  if (![".aiff", ".aif", ".wav"].includes(extension)) {
    throw new Error(`Input must be an AIFF or WAV file; received ${extension || "no extension"}`);
  }
}

export function assertArtworkPath(path: string): void {
  const extension = extname(path).toLowerCase();
  if (![".jpg", ".jpeg", ".png"].includes(extension)) {
    throw new Error(`Artwork must be a JPEG or PNG file; received ${extension || "no extension"}`);
  }
}
