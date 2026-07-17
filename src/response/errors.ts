import type { ResponseReasonCode } from './reason-codes.js';

export class CompactResponseError extends Error {
  readonly code: ResponseReasonCode;
  override readonly cause?: unknown;

  constructor(code: ResponseReasonCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'CompactResponseError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export function responseReasonFromError(
  error: unknown,
  fallback: ResponseReasonCode,
): ResponseReasonCode {
  return error instanceof CompactResponseError ? error.code : fallback;
}
