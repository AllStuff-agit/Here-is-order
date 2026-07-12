import { z } from 'zod';

export type RuntimeSchema<T> = z.ZodType<T>;

export const apiErrorPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
}).strict();

export const apiErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: apiErrorPayloadSchema,
}).strict();

export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;
export type ApiSuccessEnvelope<T> = { ok: true; data: T };
export type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope;

export function apiEnvelopeSchema<T>(dataSchema: RuntimeSchema<T>): RuntimeSchema<ApiEnvelope<T>> {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: dataSchema }).strict(),
    apiErrorEnvelopeSchema,
  ]);
}

export function decodeApiEnvelope<T>(
  dataSchema: RuntimeSchema<T>,
  input: unknown,
): ApiEnvelope<T> {
  return apiEnvelopeSchema(dataSchema).parse(input);
}
