import { z } from 'zod';

export interface RuntimeSchema<T> {
  parse(input: unknown): T;
}

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

const rawApiEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  apiErrorEnvelopeSchema,
]);

export function apiEnvelopeSchema<T>(dataSchema: RuntimeSchema<T>): RuntimeSchema<ApiEnvelope<T>> {
  return {
    parse(input: unknown): ApiEnvelope<T> {
      const envelope = rawApiEnvelopeSchema.parse(input);
      if (!envelope.ok) {
        return envelope;
      }
      return { ok: true, data: dataSchema.parse(envelope.data) };
    },
  };
}

export function decodeApiEnvelope<T>(
  dataSchema: RuntimeSchema<T>,
  input: unknown,
): ApiEnvelope<T> {
  return apiEnvelopeSchema(dataSchema).parse(input);
}
