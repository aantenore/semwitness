import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SemWitnessError } from '../domain/errors.js';
import { isSha256Digest, sha256 } from '../domain/hash.js';
import type { Sha256Digest } from '../domain/types.js';
import type { ContentStore } from '../ports/content-store.js';
import {
  BoundedReadExceededError,
  readFileHandleBounded,
} from './bounded-file-read.js';

export interface FilesystemCasOptions {
  readonly maxObjectBytes?: number;
}

export class FilesystemCas implements ContentStore {
  readonly #root: string;
  readonly #maxObjectBytes: number;

  constructor(root: string, options: FilesystemCasOptions = {}) {
    this.#root = resolve(root);
    this.#maxObjectBytes = options.maxObjectBytes ?? 16 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.#maxObjectBytes) ||
      this.#maxObjectBytes < 1
    ) {
      throw new SemWitnessError(
        'MALFORMED_ENVELOPE',
        'Invalid CAS object size limit',
      );
    }
  }

  async put(bytes: Uint8Array): Promise<Sha256Digest> {
    if (bytes.byteLength > this.#maxObjectBytes) {
      throw new SemWitnessError(
        'INPUT_TOO_LARGE',
        'CAS object exceeds configured limit',
      );
    }
    const reference = sha256(bytes);
    const target = await this.#target(reference, true);

    try {
      const current = await this.get(reference);
      if (sha256(current) === reference) {
        return reference;
      }
    } catch (error) {
      if (!(error instanceof SemWitnessError) || error.code !== 'CAS_MISS') {
        throw error;
      }
    }

    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await rename(temporary, target);
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) {
          throw error;
        }
        await rm(temporary, { force: true });
      }
      await chmod(target, 0o600);
      const stored = await this.get(reference);
      if (sha256(stored) !== reference) {
        throw new SemWitnessError(
          'CAS_CORRUPT',
          'CAS verification failed after write',
        );
      }
      return reference;
    } catch (error) {
      if (error instanceof SemWitnessError) {
        throw error;
      }
      throw new SemWitnessError(
        'CAS_WRITE_FAILED',
        'Unable to persist CAS object',
        error,
      );
    } finally {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async get(reference: Sha256Digest): Promise<Uint8Array> {
    const target = await this.#target(reference, false);
    let stat;
    try {
      stat = await lstat(target);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) {
        throw new SemWitnessError(
          'CAS_MISS',
          `CAS object ${reference} does not exist`,
        );
      }
      throw error;
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > this.#maxObjectBytes
    ) {
      throw new SemWitnessError(
        'CAS_CORRUPT',
        'CAS path is not a bounded regular file',
      );
    }

    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    const handle = await open(target, constants.O_RDONLY | noFollow);
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || openedStat.size > this.#maxObjectBytes) {
        throw new SemWitnessError(
          'CAS_CORRUPT',
          'CAS object changed during read',
        );
      }
      let bytes: Uint8Array;
      try {
        bytes = await readFileHandleBounded(handle, this.#maxObjectBytes);
      } catch (error) {
        if (error instanceof BoundedReadExceededError) {
          throw new SemWitnessError(
            'CAS_CORRUPT',
            'CAS object grew beyond its configured limit',
          );
        }
        throw error;
      }
      if (sha256(bytes) !== reference) {
        throw new SemWitnessError('CAS_CORRUPT', 'CAS object hash mismatch');
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async has(reference: Sha256Digest): Promise<boolean> {
    try {
      await this.get(reference);
      return true;
    } catch (error) {
      if (error instanceof SemWitnessError && error.code === 'CAS_MISS') {
        return false;
      }
      throw error;
    }
  }

  async #target(
    reference: Sha256Digest,
    createParent: boolean,
  ): Promise<string> {
    if (!isSha256Digest(reference)) {
      throw new SemWitnessError('MALFORMED_ENVELOPE', 'Invalid CAS digest');
    }
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(this.#root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new SemWitnessError(
        'CAS_CORRUPT',
        'CAS root must be a real directory',
      );
    }
    await chmod(this.#root, 0o700);
    const rootReal = await realpath(this.#root);
    const digest = reference.slice('sha256:'.length);
    const firstParent = join(rootReal, digest.slice(0, 2));
    const parent = join(firstParent, digest.slice(2, 4));
    await ensureRealContainedDirectory(
      rootReal,
      firstParent,
      createParent,
      reference,
    );
    await ensureRealContainedDirectory(
      rootReal,
      parent,
      createParent,
      reference,
    );
    const target = join(parent, digest);
    const pathRelative = relative(rootReal, target);
    if (
      pathRelative.length === 0 ||
      pathRelative.startsWith(`..${sep}`) ||
      pathRelative === '..' ||
      isAbsolute(pathRelative)
    ) {
      throw new SemWitnessError('CAS_CORRUPT', 'CAS path escaped its root');
    }
    return target;
  }
}

async function ensureRealContainedDirectory(
  rootReal: string,
  directory: string,
  create: boolean,
  reference: Sha256Digest,
): Promise<void> {
  if (create) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) {
        throw error;
      }
    }
  }

  let stat;
  try {
    stat = await lstat(directory);
  } catch (error) {
    if (!create && hasCode(error, 'ENOENT')) {
      throw new SemWitnessError(
        'CAS_MISS',
        `CAS object ${reference} does not exist`,
      );
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SemWitnessError(
      'CAS_CORRUPT',
      'CAS digest parent must be a real directory',
    );
  }
  const directoryReal = await realpath(directory);
  const contained = relative(rootReal, directoryReal);
  if (
    contained.length === 0 ||
    contained.startsWith(`..${sep}`) ||
    contained === '..' ||
    isAbsolute(contained)
  ) {
    throw new SemWitnessError(
      'CAS_CORRUPT',
      'CAS digest parent escaped its root',
    );
  }
  if (create) {
    await chmod(directoryReal, 0o700);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
