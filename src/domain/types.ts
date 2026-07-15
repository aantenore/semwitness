import { SemWitnessError } from './errors.js';
import { sha256 } from './hash.js';
import type { ReasonCode } from './reason-codes.js';

export const SEGMENT_ROLES = [
  'system',
  'developer',
  'user',
  'assistant',
  'tool',
] as const;

export type SegmentRole = (typeof SEGMENT_ROLES)[number];

export const SEGMENT_KINDS = [
  'instruction',
  'prose',
  'code',
  'diff',
  'json-data',
  'tool-schema',
  'tool-call',
  'tool-result',
  'log',
] as const;

export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export const TRUST_LEVELS = [
  'host-trusted',
  'workspace-trusted',
  'untrusted-external',
] as const;

export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const EQUIVALENCE_LEVELS = [
  'byte-exact',
  'roundtrip-exact',
  'typed-semantic',
  'shadow-lossy',
] as const;

export type EquivalenceLevel = (typeof EQUIVALENCE_LEVELS)[number];

export type Sha256Digest = `sha256:${string}`;

export const SAFE_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
export const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
export const SAFE_MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}(?:; ?[a-z0-9][a-z0-9._-]{0,31}=[a-z0-9][a-z0-9._-]{0,63}){0,8}$/u;
export const MAX_PROTECTED_ANCHORS = 10_000;

export interface ProtectedAnchor {
  readonly id: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly sha256: Sha256Digest;
  readonly ordinal: number;
}

export interface Segment {
  readonly schema: 'semwitness.dev/segment/v1alpha1';
  readonly id: string;
  readonly role: SegmentRole;
  readonly roleOrigin: 'host';
  readonly kind: SegmentKind;
  readonly trust: TrustLevel;
  readonly mediaType: string;
  readonly content: Uint8Array;
  readonly equivalence: EquivalenceLevel;
  readonly anchors: readonly ProtectedAnchor[];
}

export interface SegmentInput {
  readonly id?: string;
  readonly role: SegmentRole;
  readonly kind: SegmentKind;
  readonly trust?: TrustLevel;
  readonly mediaType?: string;
  readonly content: Uint8Array | string;
  readonly equivalence?: EquivalenceLevel;
  readonly anchors?: readonly ProtectedAnchor[];
}

export interface SegmentValidation {
  readonly valid: boolean;
  readonly reasons: readonly ReasonCode[];
}

const roleSet: ReadonlySet<string> = new Set(SEGMENT_ROLES);
const kindSet: ReadonlySet<string> = new Set(SEGMENT_KINDS);
const trustSet: ReadonlySet<string> = new Set(TRUST_LEVELS);
const equivalenceSet: ReadonlySet<string> = new Set(EQUIVALENCE_LEVELS);

export function isSegmentRole(value: unknown): value is SegmentRole {
  return typeof value === 'string' && roleSet.has(value);
}

export function isSegmentKind(value: unknown): value is SegmentKind {
  return typeof value === 'string' && kindSet.has(value);
}

export function isTrustLevel(value: unknown): value is TrustLevel {
  return typeof value === 'string' && trustSet.has(value);
}

export function isEquivalenceLevel(value: unknown): value is EquivalenceLevel {
  return typeof value === 'string' && equivalenceSet.has(value);
}

export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && SAFE_IDENTIFIER_PATTERN.test(value);
}

export function isSafeMediaType(value: unknown): value is string {
  return typeof value === 'string' && SAFE_MEDIA_TYPE_PATTERN.test(value);
}

const equivalenceStrength: Readonly<Record<EquivalenceLevel, number>> = {
  'byte-exact': 0,
  'roundtrip-exact': 1,
  'typed-semantic': 2,
  'shadow-lossy': 3,
};

export function equivalenceSatisfies(
  candidate: EquivalenceLevel,
  required: EquivalenceLevel,
): boolean {
  return equivalenceStrength[candidate] <= equivalenceStrength[required];
}

export function createSegment(input: SegmentInput): Segment {
  const anchors = input.anchors ?? [];
  if (!Array.isArray(anchors) || anchors.length > MAX_PROTECTED_ANCHORS) {
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      'Segment anchor manifest exceeds its limit',
    );
  }
  const content =
    typeof input.content === 'string'
      ? new TextEncoder().encode(input.content)
      : new Uint8Array(input.content);
  const contentDigest = sha256(content).slice(
    'sha256:'.length,
    'sha256:'.length + 16,
  );

  return {
    schema: 'semwitness.dev/segment/v1alpha1',
    id: input.id ?? `segment-${contentDigest}`,
    role: input.role,
    roleOrigin: 'host',
    kind: input.kind,
    trust: input.trust ?? 'untrusted-external',
    mediaType: input.mediaType ?? defaultMediaType(input.kind),
    content,
    equivalence:
      input.equivalence ?? defaultEquivalence(input.role, input.kind),
    anchors: [...anchors],
  };
}

export function validateSegment(segment: Segment): SegmentValidation {
  const reasons: ReasonCode[] = [];
  if (segment.schema !== 'semwitness.dev/segment/v1alpha1') {
    reasons.push('MALFORMED_ENVELOPE');
  }
  if (segment.roleOrigin !== 'host') {
    reasons.push('ROLE_PROVENANCE_INVALID');
  }
  if (!isSegmentRole(segment.role) || !isSegmentKind(segment.kind)) {
    reasons.push('MALFORMED_ENVELOPE');
  }
  if (
    !isTrustLevel(segment.trust) ||
    !isEquivalenceLevel(segment.equivalence)
  ) {
    reasons.push('MALFORMED_ENVELOPE');
  }
  if (
    !(segment.content instanceof Uint8Array) ||
    !isSafeIdentifier(segment.id) ||
    !isSafeMediaType(segment.mediaType) ||
    !Array.isArray(segment.anchors) ||
    segment.anchors.length > MAX_PROTECTED_ANCHORS
  ) {
    reasons.push('MALFORMED_ENVELOPE');
  }

  if (
    !(segment.content instanceof Uint8Array) ||
    !Array.isArray(segment.anchors) ||
    segment.anchors.length > MAX_PROTECTED_ANCHORS
  ) {
    return { valid: false, reasons: [...new Set(reasons)] };
  }

  let previousEnd = -1;
  const anchorIds = new Set<string>();
  const anchorOrdinals = new Set<number>();
  for (const anchor of [...segment.anchors].sort(
    (left, right) => left.startByte - right.startByte,
  )) {
    const inBounds =
      isSafeIdentifier(anchor.id) &&
      Number.isSafeInteger(anchor.ordinal) &&
      anchor.ordinal >= 0 &&
      !anchorIds.has(anchor.id) &&
      !anchorOrdinals.has(anchor.ordinal) &&
      Number.isSafeInteger(anchor.startByte) &&
      Number.isSafeInteger(anchor.endByte) &&
      anchor.startByte >= 0 &&
      anchor.endByte > anchor.startByte &&
      anchor.endByte <= segment.content.byteLength;
    if (!inBounds || anchor.startByte < previousEnd) {
      reasons.push(
        anchor.startByte < previousEnd ? 'ANCHOR_OVERLAP' : 'ANCHOR_INVALID',
      );
      continue;
    }
    anchorIds.add(anchor.id);
    anchorOrdinals.add(anchor.ordinal);
    previousEnd = anchor.endByte;
    const bytes = segment.content.subarray(anchor.startByte, anchor.endByte);
    if (sha256(bytes) !== anchor.sha256) {
      reasons.push('ANCHOR_MUTATED');
    }
  }

  return { valid: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function isHardProtected(segment: Segment): boolean {
  return (
    segment.role === 'system' ||
    segment.role === 'developer' ||
    segment.kind === 'code' ||
    segment.kind === 'diff' ||
    segment.kind === 'tool-schema' ||
    segment.kind === 'tool-call'
  );
}

function defaultEquivalence(
  role: SegmentRole,
  kind: SegmentKind,
): EquivalenceLevel {
  if (
    role === 'system' ||
    role === 'developer' ||
    kind === 'code' ||
    kind === 'diff' ||
    kind === 'tool-schema' ||
    kind === 'tool-call'
  ) {
    return 'byte-exact';
  }
  return kind === 'json-data' ? 'typed-semantic' : 'roundtrip-exact';
}

function defaultMediaType(kind: SegmentKind): string {
  if (kind === 'json-data' || kind === 'tool-schema' || kind === 'tool-call') {
    return 'application/json';
  }
  return 'text/plain; charset=utf-8';
}
