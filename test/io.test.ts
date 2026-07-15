import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectCasStats, writeNewPrivateFile } from '../src/entrypoints/io.js';

const temporaryRoots = new Set<string>();

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'semwitness-io-test-'));
  temporaryRoots.add(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  temporaryRoots.clear();
});

describe('private output files', () => {
  it('creates a new private file and refuses to overwrite it', async () => {
    const root = await temporaryRoot();
    const destination = join(root, 'retrieved.bin');
    const original = new TextEncoder().encode(
      'PRIVATE_RETRIEVAL_SENTINEL_17bce9d3',
    );

    const writtenPath = await writeNewPrivateFile(destination, original);

    expect(writtenPath).toBe(await realpath(destination));
    expect(new Uint8Array(await readFile(destination))).toEqual(original);
    const stat = await lstat(destination);
    expect(stat.isFile()).toBe(true);
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }

    await expect(
      writeNewPrivateFile(
        destination,
        new TextEncoder().encode('ATTACKER_REPLACEMENT'),
      ),
    ).rejects.toMatchObject({ code: 'CAS_WRITE_FAILED' });
    expect(new Uint8Array(await readFile(destination))).toEqual(original);
  });

  it('refuses a symbolic-link destination without modifying its target', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const root = await temporaryRoot();
    const target = join(root, 'target.bin');
    const destination = join(root, 'retrieved.bin');
    await writeFile(target, 'UNCHANGED_TARGET');
    await symlink(target, destination);

    await expect(
      writeNewPrivateFile(
        destination,
        new TextEncoder().encode('ATTACKER_REPLACEMENT'),
      ),
    ).rejects.toMatchObject({ code: 'CAS_WRITE_FAILED' });
    expect(await readFile(target, 'utf8')).toBe('UNCHANGED_TARGET');
  });
});

describe('content-free CAS statistics', () => {
  it('returns zero statistics for a missing store', async () => {
    const root = await temporaryRoot();
    expect(await collectCasStats(join(root, 'missing'))).toEqual({
      schema: 'semwitness.dev/cas-stats/v1alpha1',
      objectCount: 0,
      totalBytes: 0,
      ignoredEntries: 0,
    });
  });

  it('counts only valid regular CAS paths and ignores symlinks and malformed entries', async () => {
    const root = await temporaryRoot();
    const namespace = join(root, 'default');
    const digest = `aabb${'c'.repeat(60)}`;
    const digestDirectory = join(namespace, 'aa', 'bb');
    const content = 'CAS_STATS_CONTENT_SENTINEL_42e1a7c9';
    await mkdir(digestDirectory, { recursive: true });
    await writeFile(join(digestDirectory, digest), content);

    await mkdir(join(root, 'INVALID!'), { recursive: true });
    await writeFile(join(root, 'not-a-namespace'), 'ignored');
    await mkdir(join(namespace, 'zz'), { recursive: true });
    await writeFile(join(namespace, 'aa', 'not-a-directory'), 'ignored');
    await writeFile(join(digestDirectory, 'not-a-digest'), 'ignored');
    await writeFile(
      join(digestDirectory, `ccdd${'e'.repeat(60)}`),
      'wrong-prefix',
    );

    if (process.platform !== 'win32') {
      const outsideFile = join(root, 'outside-secret');
      const outsideDirectory = join(root, 'outside-directory');
      await writeFile(outsideFile, 'SYMLINK_CONTENT_MUST_NOT_BE_COUNTED');
      await mkdir(outsideDirectory);
      await symlink(
        outsideFile,
        join(digestDirectory, `aabb${'d'.repeat(60)}`),
      );
      await symlink(outsideDirectory, join(namespace, 'cc'));
      await symlink(namespace, join(root, 'linked-namespace'));
    }

    const stats = await collectCasStats(root);

    expect(stats.objectCount).toBe(1);
    expect(stats.totalBytes).toBe(Buffer.byteLength(content));
    expect(stats.ignoredEntries).toBeGreaterThanOrEqual(
      process.platform === 'win32' ? 6 : 10,
    );
    const serialized = JSON.stringify(stats);
    expect(serialized).not.toContain(content);
    expect(serialized).not.toContain(Buffer.from(content).toString('base64'));
    expect(serialized).not.toContain('SYMLINK_CONTENT_MUST_NOT_BE_COUNTED');
  });
});
