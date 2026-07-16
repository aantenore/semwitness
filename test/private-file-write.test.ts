import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  writePrivateFileNoClobber,
  type PrivateFileWriteOperations,
  type PrivateTemporaryFileHandle,
} from '../src/entrypoints/private-file-write.js';

const temporaryRoots = new Set<string>();
const fixedSuffix = 'a'.repeat(32);

type FailureStage = 'write' | 'chmod' | 'sync' | 'close' | 'link';

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'semwitness-private-write-test-'));
  temporaryRoots.add(root);
  return root;
}

function faultingOperations(stage: FailureStage): PrivateFileWriteOperations {
  return {
    randomSuffix: () => fixedSuffix,
    open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      let remainingCloseFailures = stage === 'close' ? 1 : 0;
      const wrapped: PrivateTemporaryFileHandle = {
        writeFile: async (bytes) => {
          if (stage === 'write') throw injectedFailure(stage);
          await handle.writeFile(bytes);
        },
        chmod: async (mode) => {
          if (stage === 'chmod') throw injectedFailure(stage);
          await handle.chmod(mode);
        },
        sync: async () => {
          if (stage === 'sync') throw injectedFailure(stage);
          await handle.sync();
        },
        close: async () => {
          if (remainingCloseFailures > 0) {
            remainingCloseFailures -= 1;
            throw injectedFailure(stage);
          }
          await handle.close();
        },
      };
      return wrapped;
    },
    link: async (existingPath, newPath) => {
      if (stage === 'link') throw injectedFailure(stage);
      await link(existingPath, newPath);
    },
    unlink,
  };
}

function injectedFailure(stage: FailureStage): Error {
  return new Error(`injected_${stage}_failure`);
}

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  temporaryRoots.clear();
});

describe('transactional private-file publication', () => {
  for (const stage of ['write', 'chmod', 'sync', 'close', 'link'] as const) {
    it(`leaves no final or temporary file after an injected ${stage} failure`, async () => {
      const root = await temporaryRoot();
      const target = join(root, 'manifest.json');

      await expect(
        writePrivateFileNoClobber(
          target,
          new TextEncoder().encode('COMPLETE_MANIFEST'),
          faultingOperations(stage),
        ),
      ).rejects.toThrow(`injected_${stage}_failure`);

      await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(root)).toEqual([]);
    });
  }

  it('loses an atomic publish race without clobbering the winner', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'manifest.json');
    const operations: PrivateFileWriteOperations = {
      ...faultingOperations('link'),
      link: async (existingPath, newPath) => {
        await writeFile(newPath, 'RACING_WRITER', {
          flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          mode: 0o600,
        });
        await link(existingPath, newPath);
      },
    };

    await expect(
      writePrivateFileNoClobber(
        target,
        new TextEncoder().encode('MUST_NOT_CLOBBER'),
        operations,
      ),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    expect(await readFile(target, 'utf8')).toBe('RACING_WRITER');
    expect(await readdir(root)).toEqual(['manifest.json']);
  });

  it('treats temporary cleanup after publication as best-effort', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'manifest.json');
    const operations: PrivateFileWriteOperations = {
      ...faultingOperations('link'),
      link,
      unlink: async () => {
        throw new Error('injected_cleanup_failure');
      },
    };
    const bytes = new TextEncoder().encode('COMPLETE_MANIFEST');

    await expect(
      writePrivateFileNoClobber(target, bytes, operations),
    ).resolves.toBeUndefined();

    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
    const stat = await lstat(target);
    expect(stat.isFile()).toBe(true);
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });
});
