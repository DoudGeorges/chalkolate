import { z } from 'zod'
import { Box2DSchema, CalibrationCornersSchema, ErrorCategorySchema } from '../api/schemas'

export const MAX_PREV_SUMMARY_LENGTH = 2000
export const MAX_BOARD_SUMMARY_LENGTH = 600
export const MAX_FINDINGS = 20
export const MAX_SPEECH_TEXT_LENGTH = 240

const text = (max: number) => z.string().trim().min(1).max(max)

/** Strip one pair of outer LaTeX math delimiters ($…$, $$…$$, \(…\), \[…\]). */
export function stripOuterLatexDelimiters(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  const pairs: Array<[string, string]> = [
    ['$$', '$$'],
    ['$', '$'],
    ['\\(', '\\)'],
    ['\\[', '\\]'],
  ]
  for (const [left, right] of pairs) {
    if (value.startsWith(left) && value.endsWith(right) && value.length > left.length + right.length) {
      const inner = value.slice(left.length, value.length - right.length).trim()
      return inner || null
    }
  }
  return value
}

/** Model-space finding; box_2d refers to the exact image sent to Gemini. */
export const ModelFindingSchema = z
  .object({
    category: ErrorCategorySchema,
    detected_text: text(300),
    correction_text: text(300),
    correction_latex: z
      .string()
      .max(300)
      .nullish()
      .transform((value) => (value == null ? null : stripOuterLatexDelimiters(value))),
    spoken_alert: text(180),
    explanation: text(300),
    box_2d: Box2DSchema,
    confidence: z.number().finite().min(0).max(1),
  })
  .strict()
export type ModelFinding = z.infer<typeof ModelFindingSchema>

export const BoardAnalysisResultSchema = z
  .object({
    board_summary: z.string().trim().max(MAX_BOARD_SUMMARY_LENGTH).default(''),
    errors: z.array(ModelFindingSchema).max(MAX_FINDINGS).default([]),
  })
  .strict()
export type BoardAnalysisResult = z.infer<typeof BoardAnalysisResultSchema>

export const AnalysisMetadataSchema = z
  .object({
    request_id: z.string().uuid(),
    previous_board_summary: z.string().trim().max(MAX_PREV_SUMMARY_LENGTH).default(''),
    corners: CalibrationCornersSchema.nullable().optional(),
  })
  .strict()
export type AnalysisMetadata = z.infer<typeof AnalysisMetadataSchema>

export const SpeechRequestSchema = z.object({ text: text(MAX_SPEECH_TEXT_LENGTH) }).strict()
