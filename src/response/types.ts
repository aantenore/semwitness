import type { JsonValue } from '../domain/canonical-json.js';
import type { Sha256Digest } from '../domain/types.js';

export const COMPACT_RESPONSE_CONTRACT_SCHEMA =
  'semwitness.dev/compact-response-contract/v1alpha1' as const;

export const BOUNDED_JSON_SCHEMA_DIALECT =
  'semwitness.dev/bounded-json-schema/v1alpha1' as const;

export type BoundedJsonScalar = null | boolean | number | string;

export interface BoundedNullSchema {
  readonly type: 'null';
  readonly enum?: readonly null[];
}

export interface BoundedBooleanSchema {
  readonly type: 'boolean';
  readonly enum?: readonly boolean[];
}

export interface BoundedNumberSchema {
  readonly type: 'number';
  readonly enum?: readonly number[];
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface BoundedIntegerSchema {
  readonly type: 'integer';
  readonly enum?: readonly number[];
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface BoundedStringSchema {
  readonly type: 'string';
  readonly enum?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
}

export interface BoundedHomogeneousArraySchema {
  readonly type: 'array';
  readonly items: BoundedJsonSchema;
  readonly minItems?: number;
  readonly maxItems: number;
}

export interface BoundedTupleSchema {
  readonly type: 'array';
  readonly prefixItems: readonly BoundedJsonSchema[];
  readonly items: false;
  readonly minItems: number;
  readonly maxItems: number;
}

export interface BoundedObjectSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, BoundedJsonSchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export type BoundedJsonSchema =
  | BoundedNullSchema
  | BoundedBooleanSchema
  | BoundedNumberSchema
  | BoundedIntegerSchema
  | BoundedStringSchema
  | BoundedHomogeneousArraySchema
  | BoundedTupleSchema
  | BoundedObjectSchema;

export interface CompactResponseLimits {
  readonly maxCandidateBytes: number;
  readonly maxRenderedBytes: number;
  readonly maxDepth: number;
  readonly maxItems: number;
  readonly maxStringCodeUnits: number;
  readonly maxRenderMs: number;
}

export interface CompactResponseCandidateContract {
  readonly mediaType: 'application/json';
  readonly schemaDialect: typeof BOUNDED_JSON_SCHEMA_DIALECT;
  readonly schema: BoundedJsonSchema;
}

export interface CompactResponseRendererBinding {
  readonly id: string;
  readonly version: string;
  readonly artifactDigest: Sha256Digest;
  readonly outputMediaType: string;
  readonly locale: string;
}

export interface CompactResponseContract {
  readonly schema: typeof COMPACT_RESPONSE_CONTRACT_SCHEMA;
  readonly id: string;
  readonly version: string;
  readonly candidate: CompactResponseCandidateContract;
  readonly renderer: CompactResponseRendererBinding;
  readonly limits: CompactResponseLimits;
}

export interface ParsedCompactResponseCandidate {
  /** Deep-frozen, null-prototype JSON snapshot validated by the contract. */
  readonly value: JsonValue;
  /** An owned copy of the exact UTF-8 bytes received at the boundary. */
  readonly bytes: Uint8Array;
  /** Canonical JSON UTF-8 bytes for semantic payload binding. */
  readonly canonicalBytes: Uint8Array;
}
