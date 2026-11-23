import { z } from 'zod'
import type { SpeechStyle } from '../lib/voicePreferences'

/** Match Pydantic's character limits for strings containing supplementary Unicode characters. */
function textWithLimit(limit: number, nonEmpty = false) {
  const schema = nonEmpty ? z.string().trim().min(1) : z.string()
  return schema.refine((value) => Array.from(value).length <= limit, {
    message: `Use at most ${limit} characters.`,
  })
}

export const ErrorCategorySchema = z.enum(['math', 'physics', 'spelling', 'factual'])
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>

export const CornerPointSchema = z.tuple([
  z.number().finite().min(0).max(1000),
  z.number().finite().min(0).max(1000),
])
export type CornerPoint = z.infer<typeof CornerPointSchema>

export const CalibrationCornersSchema = z.tuple([
  CornerPointSchema,
  CornerPointSchema,
  CornerPointSchema,
  CornerPointSchema,
])
export type CalibrationCorners = z.infer<typeof CalibrationCornersSchema>

export const Box2DSchema = z
  .tuple([
    z.number().int().min(0).max(1000),
    z.number().int().min(0).max(1000),
    z.number().int().min(0).max(1000),
    z.number().int().min(0).max(1000),
  ])
  .refine(([ymin, xmin, ymax, xmax]) => ymin < ymax && xmin < xmax, {
    message: 'box_2d must satisfy ymin < ymax and xmin < xmax',
  })
export type Box2D = z.infer<typeof Box2DSchema>

export const SourceSpaceErrorSchema = z
  .object({
    category: ErrorCategorySchema,
    detected_text: textWithLimit(300, true),
    correction_text: textWithLimit(300, true),
    correction_latex: textWithLimit(300).nullable(),
    spoken_alert: textWithLimit(180, true),
    explanation: textWithLimit(300, true),
    box_2d: Box2DSchema,
    confidence: z.number().finite().min(0).max(1),
  })
  .strict()
export type SourceSpaceDetectedError = z.infer<typeof SourceSpaceErrorSchema>

export const AnalysisResponseSchema = z
  .object({
    request_id: z.string().uuid(),
    board_summary: textWithLimit(600),
    errors: z.array(SourceSpaceErrorSchema).max(20),
    image_width: z.number().int().positive(),
    image_height: z.number().int().positive(),
    latency_ms: z.number().int().nonnegative(),
  })
  .strict()
export type AnalysisResponse = z.infer<typeof AnalysisResponseSchema> & { incomplete?: boolean }

export const HealthResponseSchema = z
  .object({
    status: z.literal('ok'),
    analysis_configured: z.boolean(),
    speech_configured: z.boolean().default(false),
    credentials_verified: z.literal(false),
  })
  .strict()
export type HealthResponse = z.infer<typeof HealthResponseSchema>

export const SpeechVoiceOptionSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    label: textWithLimit(80, true),
  })
  .strict()
export type SpeechVoiceOption = z.infer<typeof SpeechVoiceOptionSchema>

export const VoicesResponseSchema = z
  .object({
    voices: z.array(SpeechVoiceOptionSchema).max(250),
  })
  .strict()
export type VoicesResponse = z.infer<typeof VoicesResponseSchema>

export const ErrorEnvelopeSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    request_id: z.string().nullable().optional(),
  })
  .strict()

export const BoardDetectionResponseSchema = z
  .object({
    detected: z.boolean(),
    corners: CalibrationCornersSchema.nullable(),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict()
export type BoardDetectionResponse = z.infer<typeof BoardDetectionResponseSchema>

export const AnswerFormatSchema = z.enum(['exact', 'fraction', 'decimal3'])
export type AnswerFormat = z.infer<typeof AnswerFormatSchema>

export interface AnalysisMetadataPayload {
  request_id: string
  answer_format: AnswerFormat
  speech_style?: SpeechStyle
  previous_board_summary: string
  corners: CalibrationCorners | null
}

const NoteIdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9_-]+$/)

export const NoteSectionUpdateSchema = z
  .object({
    id: NoteIdSchema,
    heading: textWithLimit(120, true),
    body_markdown: textWithLimit(3000, true),
    has_figure: z.boolean(),
    figure_box_2d: Box2DSchema.nullable(),
    after_section_id: NoteIdSchema.nullable(),
  })
  .strict()
export type NoteSectionUpdate = z.infer<typeof NoteSectionUpdateSchema>

export const NotesResponseSchema = z
  .object({
    request_id: z.string().uuid(),
    lecture_title: textWithLimit(160),
    updates: z.array(NoteSectionUpdateSchema).max(8),
    latency_ms: z.number().int().nonnegative(),
  })
  .strict()
export type NotesResponse = z.infer<typeof NotesResponseSchema>

export interface NotesContextSection {
  id: string
  heading: string
  body_markdown: string
}

export interface NotesMetadataPayload {
  request_id: string
  sections: NotesContextSection[]
  corners: CalibrationCorners | null
}
