import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { SemWitnessError } from '../domain/errors.js';
import {
  BoundedReadExceededError,
  readFileHandleBounded,
} from '../adapters/bounded-file-read.js';
import {
  DEFAULT_POLICY,
  validatePolicy,
  type CodecPolicy,
} from '../domain/policy.js';
import { writePrivateFileNoClobber } from './private-file-write.js';

export const DEFAULT_STORE_DIRECTORY = '.semwitness';
export const MAX_POLICY_BYTES = 1024 * 1024;
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
export const MAX_FIXTURE_BYTES = 96 * 1024 * 1024;

export async function loadPolicyFile(path?: string): Promise<CodecPolicy> {
  if (path === undefined) {
    return DEFAULT_POLICY;
  }
  const source = decodeUtf8(
    await readBoundedRegularFile(path, MAX_POLICY_BYTES),
    'Policy must be UTF-8',
  );
  const document = parseDocument(source, {
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      'Policy YAML is invalid or uses unsupported features',
    );
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      'Policy YAML aliases are not supported',
    );
  }
  return validatePolicy(value);
}

export function assertShadowPolicy(policy: CodecPolicy): void {
  if (policy.mode !== 'shadow') {
    throw new SemWitnessError(
      'SHADOW_ONLY',
      'The SemWitness CLI accepts shadow-mode policies only',
    );
  }
}

export async function readInputBytes(
  input: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (input === '-') {
    return readBoundedStdin(maximumBytes);
  }
  return readBoundedRegularFile(input, maximumBytes);
}

export async function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  assertMaximum(maximumBytes);
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      'Input file is unavailable',
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      'Input path must be a regular non-symbolic-link file',
    );
  }
  if (stat.size > maximumBytes) {
    throw new SemWitnessError(
      'INPUT_TOO_LARGE',
      'Input exceeds the byte limit',
    );
  }

  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maximumBytes) {
      throw new SemWitnessError(
        opened.size > maximumBytes ? 'INPUT_TOO_LARGE' : 'MALFORMED_ENVELOPE',
        'Input changed or exceeded the byte limit while opening',
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await readFileHandleBounded(handle, maximumBytes);
    } catch (error) {
      if (!(error instanceof BoundedReadExceededError)) {
        throw error;
      }
      throw new SemWitnessError(
        'INPUT_TOO_LARGE',
        'Input exceeds the byte limit',
      );
    }
    return bytes;
  } catch (error) {
    if (error instanceof SemWitnessError) {
      throw error;
    }
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      'Unable to read the input file safely',
      error,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeNewPrivateFile(
  destination: string,
  bytes: Uint8Array,
): Promise<string> {
  if (destination.length === 0 || destination === '-') {
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      'An explicit file destination is required',
    );
  }
  const target = await normalizeTrustedRootAlias(resolve(destination));
  const parent = dirname(target);
  await assertNoExistingSymbolicLinkComponents(target);
  let parentStat;
  try {
    parentStat = await lstat(parent);
  } catch {
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      'Output parent directory does not exist',
    );
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      'Output parent must be a real directory',
    );
  }
  try {
    await writePrivateFileNoClobber(target, bytes);
    return target;
  } catch (error) {
    throw new SemWitnessError(
      'CAS_WRITE_FAILED',
      'Refusing to overwrite or follow an unsafe output path',
      error,
    );
  }
}

async function assertNoExistingSymbolicLinkComponents(
  target: string,
): Promise<void> {
  for (const candidate of outputPathComponents(target)) {
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) {
        throw unsafeOutputPath();
      }
    } catch (error) {
      if (hasCode(error, 'ENOENT')) {
        break;
      }
      if (error instanceof SemWitnessError) {
        throw error;
      }
      throw unsafeOutputPath(error);
    }
  }
}

async function normalizeTrustedRootAlias(target: string): Promise<string> {
  if (process.platform === 'win32') {
    return target;
  }

  // macOS exposes root-owned aliases such as /var -> /private/var. Resolve only
  // that privileged boundary; every component below it remains no-follow.
  const rootAlias = outputPathComponents(target)[1];
  if (rootAlias === undefined) {
    return target;
  }
  let rootAliasStat;
  try {
    rootAliasStat = await lstat(rootAlias);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return target;
    }
    throw unsafeOutputPath(error);
  }
  if (!rootAliasStat.isSymbolicLink()) {
    return target;
  }
  if (rootAliasStat.uid !== 0) {
    throw unsafeOutputPath();
  }

  try {
    const realRoot = await realpath(rootAlias);
    const realRootStat = await lstat(realRoot);
    if (!realRootStat.isDirectory() || realRootStat.isSymbolicLink()) {
      throw unsafeOutputPath();
    }
    return resolve(realRoot, relative(rootAlias, target));
  } catch (error) {
    if (error instanceof SemWitnessError) {
      throw error;
    }
    throw unsafeOutputPath(error);
  }
}

function outputPathComponents(target: string): readonly string[] {
  const components: string[] = [];
  let component = target;
  while (true) {
    components.push(component);
    const parent = dirname(component);
    if (parent === component) {
      break;
    }
    component = parent;
  }
  return components.reverse();
}

function unsafeOutputPath(cause?: unknown): SemWitnessError {
  return new SemWitnessError(
    'CAS_WRITE_FAILED',
    'Refusing to overwrite or follow an unsafe output path',
    cause,
  );
}

export interface CasStats {
  readonly schema: 'semwitness.dev/cas-stats/v1alpha1';
  readonly objectCount: number;
  readonly totalBytes: number;
  readonly ignoredEntries: number;
}

export async function collectCasStats(root: string): Promise<CasStats> {
  const absolute = resolve(root);
  try {
    const stat = await lstat(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new SemWitnessError(
        'CAS_CORRUPT',
        'CAS root must be a real directory',
      );
    }
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return zeroStats();
    }
    if (error instanceof SemWitnessError) {
      throw error;
    }
    throw new SemWitnessError('CAS_CORRUPT', 'Unable to inspect the CAS root');
  }

  const rootReal = await realpath(absolute);
  const totals = { objectCount: 0, totalBytes: 0, ignoredEntries: 0 };
  for await (const namespace of await opendir(rootReal)) {
    if (
      !namespace.isDirectory() ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(namespace.name)
    ) {
      totals.ignoredEntries += 1;
      continue;
    }
    const namespaceReal = await realChildDirectory(rootReal, namespace.name);
    if (namespaceReal === undefined) {
      totals.ignoredEntries += 1;
      continue;
    }
    await scanDigestRoot(namespaceReal, totals);
  }
  return {
    schema: 'semwitness.dev/cas-stats/v1alpha1',
    ...totals,
  };
}

async function scanDigestRoot(
  rootReal: string,
  totals: { objectCount: number; totalBytes: number; ignoredEntries: number },
): Promise<void> {
  for await (const first of await opendir(rootReal)) {
    if (!first.isDirectory() || !/^[a-f0-9]{2}$/u.test(first.name)) {
      totals.ignoredEntries += 1;
      continue;
    }
    const firstReal = await realChildDirectory(rootReal, first.name);
    if (firstReal === undefined) {
      totals.ignoredEntries += 1;
      continue;
    }
    for await (const second of await opendir(firstReal)) {
      if (!second.isDirectory() || !/^[a-f0-9]{2}$/u.test(second.name)) {
        totals.ignoredEntries += 1;
        continue;
      }
      const secondReal = await realChildDirectory(firstReal, second.name);
      if (secondReal === undefined) {
        totals.ignoredEntries += 1;
        continue;
      }
      for await (const entry of await opendir(secondReal)) {
        if (
          !entry.isFile() ||
          !/^[a-f0-9]{64}$/u.test(entry.name) ||
          !entry.name.startsWith(`${first.name}${second.name}`)
        ) {
          totals.ignoredEntries += 1;
          continue;
        }
        const stat = await lstat(resolve(secondReal, entry.name));
        if (!stat.isFile() || stat.isSymbolicLink()) {
          totals.ignoredEntries += 1;
          continue;
        }
        totals.objectCount = safeAdd(totals.objectCount, 1);
        totals.totalBytes = safeAdd(totals.totalBytes, stat.size);
      }
    }
  }
}

async function realChildDirectory(
  parentReal: string,
  childName: string,
): Promise<string | undefined> {
  const child = resolve(parentReal, childName);
  try {
    const stat = await lstat(child);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return undefined;
    }
    const childReal = await realpath(child);
    return dirname(childReal) === parentReal ? childReal : undefined;
  } catch {
    return undefined;
  }
}

export function decodeUtf8(bytes: Uint8Array, message: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SemWitnessError('FORMAT_UNSUPPORTED', message, error);
  }
}

async function readBoundedStdin(maximumBytes: number): Promise<Uint8Array> {
  assertMaximum(maximumBytes);
  if (process.stdin.isTTY) {
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      'Standard input is a terminal; pipe content or use --input <file>',
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maximumBytes) {
      throw new SemWitnessError(
        'INPUT_TOO_LARGE',
        'Input exceeds the byte limit',
      );
    }
    chunks.push(bytes);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

function assertMaximum(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SemWitnessError('MALFORMED_ENVELOPE', 'Invalid byte limit');
  }
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new SemWitnessError(
      'CAS_CORRUPT',
      'CAS statistics exceed safe integer range',
    );
  }
  return result;
}

function zeroStats(): CasStats {
  return {
    schema: 'semwitness.dev/cas-stats/v1alpha1',
    objectCount: 0,
    totalBytes: 0,
    ignoredEntries: 0,
  };
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
