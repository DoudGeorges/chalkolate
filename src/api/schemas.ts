import { z } from 'zod'

export const ErrorCategorySchema = z.enum(['math', 'physics', 'spelling'])
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
    detected_text: z.string().trim().min(1).max(300),
    correction_text: z.string().trim().min(1).max(300),
    correction_latex: z.string().max(300).nullable(),
    spoken_alert: z.string().trim().min(1).max(180),
    explanation: z.string().trim().min(1).max(300),
    box_2d: Box2DSchema,
    confidence: z.number().finite().min(0).max(1),
  })
  .strict()
export type SourceSpaceDetectedError = z.infer<typeof SourceSpaceErrorSchema>

export const AnalysisResponseSchema = z
  .object({
    request_id: z.string().uuid(),
    board_summary: z.string().max(600),
    errors: z.array(SourceSpaceErrorSchema).max(20),
    image_width: z.number().int().positive(),
    image_height: z.number().int().positive(),
    latency_ms: z.number().int().nonnegative(),
  })
  .strict()
export type AnalysisResponse = z.infer<typeof AnalysisResponseSchema>

export const HealthResponseSchema = z
  .object({
    status: z.literal('ok'),
    analysis_configured: z.boolean(),
    speech_configured: z.boolean().default(false),
    credentials_verified: z.literal(false),
  })
  .strict()
export type HealthResponse = z.infer<typeof HealthResponseSchema>

export const ErrorEnvelopeSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    request_id: z.string().nullable().optional(),
  })
  .strict()
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>

export const BoardDetectionResponseSchema = z
  .object({
    detected: z.boolean(),
    corners: CalibrationCornersSchema.nullable(),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict()
export type BoardDetectionResponse = z.infer<typeof BoardDetectionResponseSchema>

export interface AnalysisMetadataPayload {
  request_id: string
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
    heading: z.string().trim().min(1).max(120),
    body_markdown: z.string().trim().min(1).max(3000),
    has_figure: z.boolean(),
    figure_box_2d: Box2DSchema.nullable(),
    after_section_id: NoteIdSchema.nullable(),
  })
  .strict()
export type NoteSectionUpdate = z.infer<typeof NoteSectionUpdateSchema>

export const NotesResponseSchema = z
  .object({
    request_id: z.string().uuid(),
    lecture_title: z.string().max(160),
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
