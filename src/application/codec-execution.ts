import { performance } from 'node:perf_hooks';
import { SemWitnessError } from '../domain/errors.js';

export async function withCodecDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const startedAt = performance.now();
  const timeoutError = () =>
    new SemWitnessError('CODEC_TIMEOUT', 'Codec deadline exceeded');
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(timeoutError()), timeoutMs);
    });
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      if (performance.now() - startedAt > timeoutMs) {
        throw timeoutError();
      }
      throw error;
    }
    const value = await Promise.race([pending, deadline]);
    if (performance.now() - startedAt > timeoutMs) {
      throw timeoutError();
    }
    return value;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
