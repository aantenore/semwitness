import { appendFile, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FilesystemCas } from '../src/adapters/filesystem-cas.js';
import {
  BoundedReadExceededError,
  readFileHandleBounded,
} from '../src/adapters/bounded-file-read.js';
import { sha256 } from '../src/domain/hash.js';
import type { Sha256Digest } from '../src/domain/types.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'semwitness-cas-test-'));
  temporaryRoots.push(root);
  return root;
}

function objectPath(root: string, reference: Sha256Digest): string {
  const digest = reference.slice('sha256:'.length);
  return join(root, digest.slice(0, 2), digest.slice(2, 4), digest);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('filesystem content-addressed store', () => {
  it('bounds allocation when an already-open file grows', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'growing-input');
    await writeFile(path, '1234');
    const handle = await open(path, 'r');
    try {
      await appendFile(path, '56789');
      await expect(readFileHandleBounded(handle, 8)).rejects.toBeInstanceOf(
        BoundedReadExceededError,
      );
    } finally {
      await handle.close();
    }
  });

  it('writes, reads, checks and deduplicates exact bytes', async () => {
    const store = new FilesystemCas(await temporaryRoot());
    const bytes = new TextEncoder().encode('content-addressed-original');
    const expected = sha256(bytes);

    expect(await store.has(expected)).toBe(false);
    expect(await store.put(bytes)).toBe(expected);
    expect(await store.put(bytes)).toBe(expected);
    expect(await store.has(expected)).toBe(true);
    expect(await store.get(expected)).toEqual(bytes);
  });

  it('handles concurrent idempotent writers', async () => {
    const store = new FilesystemCas(await temporaryRoot());
    const bytes = new TextEncoder().encode('same immutable object');
    const references = await Promise.all(
      Array.from({ length: 12 }, () => store.put(bytes)),
    );
    expect(new Set(references)).toEqual(new Set([sha256(bytes)]));
    expect(await store.get(references[0]!)).toEqual(bytes);
  });

  it('detects an object modified after its write', async () => {
    const root = await temporaryRoot();
    const store = new FilesystemCas(root);
    const reference = await store.put(
      new TextEncoder().encode('trusted bytes'),
    );
    await writeFile(objectPath(root, reference), 'corrupted bytes', {
      mode: 0o600,
    });

    await expect(store.get(reference)).rejects.toMatchObject({
      code: 'CAS_CORRUPT',
    });
    await expect(store.has(reference)).rejects.toMatchObject({
      code: 'CAS_CORRUPT',
    });
  });

  it('rejects malformed digests instead of interpreting them as paths', async () => {
    const store = new FilesystemCas(await temporaryRoot());
    const malformed = 'sha256:../../outside' as Sha256Digest;
    await expect(store.get(malformed)).rejects.toMatchObject({
      code: 'MALFORMED_ENVELOPE',
    });
    await expect(store.put(new Uint8Array(0))).resolves.toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
  });

  it('distinguishes a valid missing digest from corruption', async () => {
    const store = new FilesystemCas(await temporaryRoot());
    const missing = sha256('not stored');
    expect(await store.has(missing)).toBe(false);
    await expect(store.get(missing)).rejects.toMatchObject({
      code: 'CAS_MISS',
    });
  });

  it('enforces the configured object size on write and read', async () => {
    const root = await temporaryRoot();
    const store = new FilesystemCas(root, { maxObjectBytes: 8 });
    await expect(store.put(new Uint8Array(9))).rejects.toMatchObject({
      code: 'INPUT_TOO_LARGE',
    });

    const reference = sha256('12345678');
    await store.put(new TextEncoder().encode('12345678'));
    await writeFile(objectPath(root, reference), '123456789', { mode: 0o600 });
    await expect(store.get(reference)).rejects.toMatchObject({
      code: 'CAS_CORRUPT',
    });
  });
});
