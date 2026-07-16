import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MAX_TEMPORARY_FILE_ATTEMPTS = 16;
const TEMPORARY_SUFFIX_PATTERN = /^[a-f0-9]{32}$/u;

export interface PrivateTemporaryFileHandle {
  writeFile(bytes: Uint8Array): Promise<void>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface PrivateFileWriteOperations {
  open(
    path: string,
    flags: number,
    mode: number,
  ): Promise<PrivateTemporaryFileHandle>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  randomSuffix(): string;
}

const NODE_PRIVATE_FILE_WRITE_OPERATIONS: PrivateFileWriteOperations =
  Object.freeze({
    open,
    link,
    unlink,
    randomSuffix: () => randomBytes(16).toString('hex'),
  });

/**
 * Writes a complete private sibling and publishes it with an atomic hard link.
 * The hard-link commit is no-clobber on every supported platform because source
 * and destination share one directory and therefore one filesystem.
 *
 * This module is internal to the CLI entrypoint. The injectable operations are
 * intentionally exposed only so post-open failures can be covered without
 * relying on timing races or filesystem exhaustion.
 */
export async function writePrivateFileNoClobber(
  target: string,
  bytes: Uint8Array,
  operations: PrivateFileWriteOperations = NODE_PRIVATE_FILE_WRITE_OPERATIONS,
): Promise<void> {
  let temporaryPath: string | undefined;
  let handle: PrivateTemporaryFileHandle | undefined;

  try {
    const temporary = await openPrivateTemporaryFile(
      dirname(target),
      operations,
    );
    temporaryPath = temporary.path;
    handle = temporary.handle;

    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;

    // link(2)/CreateHardLink publishes the fully synced inode atomically and
    // fails with EEXIST instead of replacing an existing destination.
    await operations.link(temporaryPath, target);
  } finally {
    await ignoreFailure(() => handle?.close());
    await ignoreFailure(() =>
      temporaryPath === undefined
        ? Promise.resolve()
        : operations.unlink(temporaryPath),
    );
  }
}

async function openPrivateTemporaryFile(
  parent: string,
  operations: PrivateFileWriteOperations,
): Promise<{
  readonly path: string;
  readonly handle: PrivateTemporaryFileHandle;
}> {
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  for (let attempt = 0; attempt < MAX_TEMPORARY_FILE_ATTEMPTS; attempt += 1) {
    const suffix = operations.randomSuffix();
    if (!TEMPORARY_SUFFIX_PATTERN.test(suffix)) {
      throw new Error('Private temporary-file suffix is invalid');
    }
    const path = join(parent, `.semwitness-private-${suffix}.tmp`);
    try {
      return {
        path,
        handle: await operations.open(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
          0o600,
        ),
      };
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
  }
  throw new Error('Unable to reserve a private temporary file');
}

async function ignoreFailure(task: () => Promise<unknown> | undefined) {
  try {
    await task();
  } catch {
    // Cleanup is deliberately best-effort. The final path is either absent or
    // already points atomically at a complete, synced private file.
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
