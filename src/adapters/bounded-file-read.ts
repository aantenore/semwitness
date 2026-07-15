import { Buffer } from 'node:buffer';
import type { FileHandle } from 'node:fs/promises';

const CHUNK_BYTES = 64 * 1024;

export class BoundedReadExceededError extends Error {
  constructor() {
    super('File exceeded the bounded-read limit');
    this.name = 'BoundedReadExceededError';
  }
}

export async function readFileHandleBounded(
  handle: FileHandle,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new TypeError('maximumBytes must be a non-negative safe integer');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maximumBytes) {
    const remainingThroughOverflow = maximumBytes + 1 - total;
    const buffer = Buffer.allocUnsafe(
      Math.min(CHUNK_BYTES, remainingThroughOverflow),
    );
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) {
      return new Uint8Array(Buffer.concat(chunks, total));
    }
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
    if (total > maximumBytes) {
      throw new BoundedReadExceededError();
    }
  }
  throw new BoundedReadExceededError();
}
