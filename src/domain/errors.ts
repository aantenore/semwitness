import type { ReasonCode } from './reason-codes.js';

export class SemWitnessError extends Error {
  readonly code: ReasonCode;
  override readonly cause?: unknown;

  constructor(code: ReasonCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'SemWitnessError';
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export function reasonFromError(
  error: unknown,
  fallback: ReasonCode = 'CODEC_ERROR',
): ReasonCode {
  return error instanceof SemWitnessError ? error.code : fallback;
}
