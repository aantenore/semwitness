import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { withCodecDeadline } from '../src/application/codec-execution.js';

describe('codec cooperative deadline', () => {
  it('times out a pending asynchronous codec operation', async () => {
    await expect(
      withCodecDeadline(() => new Promise<never>(() => undefined), 5),
    ).rejects.toMatchObject({ code: 'CODEC_TIMEOUT' });
  });

  it('rejects synchronous work that exceeded the budget after it yields', async () => {
    await expect(
      withCodecDeadline(async () => {
        const until = performance.now() + 20;
        while (performance.now() < until) {
          // Deliberately emulate a non-cooperative trusted codec.
        }
        return 'late';
      }, 2),
    ).rejects.toMatchObject({ code: 'CODEC_TIMEOUT' });
  });
});
