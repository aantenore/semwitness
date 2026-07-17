export const RESPONSE_REASON_CODES = [
  'CONTRACT_MALFORMED',
  'CANDIDATE_MALFORMED',
  'CANDIDATE_LIMIT_EXCEEDED',
  'CANDIDATE_SCHEMA_MISMATCH',
  'RENDERER_NOT_REGISTERED',
  'RENDERER_BINDING_MISMATCH',
  'RENDER_TIMEOUT',
  'RENDER_ERROR',
  'RENDER_OUTPUT_INVALID',
  'RENDER_OUTPUT_TOO_LARGE',
  'TOKENIZER_ERROR',
  'WITNESS_MALFORMED',
  'WITNESS_MISMATCH',
] as const;

export type ResponseReasonCode = (typeof RESPONSE_REASON_CODES)[number];

const RESPONSE_REASON_CODE_SET: ReadonlySet<string> = new Set(
  RESPONSE_REASON_CODES,
);

export function isResponseReasonCode(
  value: unknown,
): value is ResponseReasonCode {
  return typeof value === 'string' && RESPONSE_REASON_CODE_SET.has(value);
}
