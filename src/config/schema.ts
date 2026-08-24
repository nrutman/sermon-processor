import { extname, resolve } from "node:path";
import { z } from "zod";

const isoDate = z
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
  date: isoDate,
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

export function assertAiffPath(path: string): void {
  const extension = extname(path).toLowerCase();
  if (extension !== ".aiff" && extension !== ".aif") {
    throw new Error(`Input must be an AIFF file; received ${extension || "no extension"}`);
  }
}

export function assertArtworkPath(path: string): void {
  const extension = extname(path).toLowerCase();
  if (![".jpg", ".jpeg", ".png"].includes(extension)) {
    throw new Error(`Artwork must be a JPEG or PNG file; received ${extension || "no extension"}`);
  }
}
