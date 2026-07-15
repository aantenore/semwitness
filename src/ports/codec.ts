import type { CodecPolicy } from '../domain/policy.js';
import type {
  EquivalenceLevel,
  Segment,
  SegmentKind,
} from '../domain/types.js';

export interface CodecDescriptor {
  readonly id: string;
  readonly version: string;
  readonly deterministic: true;
  readonly acceptedKinds: readonly SegmentKind[] | '*';
  readonly equivalence: EquivalenceLevel;
  readonly decoderLegend?: Uint8Array;
}

export interface EncodedCandidate {
  readonly bytes: Uint8Array;
}

export interface CodecContext {
  readonly policy: CodecPolicy;
}

export interface DecodeContext {
  readonly maxOutputBytes: number;
  readonly maxDepth: number;
  readonly maxItems: number;
}

export interface Codec {
  readonly descriptor: CodecDescriptor;
  encode(segment: Segment, context: CodecContext): Promise<EncodedCandidate>;
  decode(
    candidate: EncodedCandidate,
    context: DecodeContext,
  ): Promise<Uint8Array>;
}

export function codecAccepts(codec: Codec, segment: Segment): boolean {
  return (
    codec.descriptor.acceptedKinds === '*' ||
    codec.descriptor.acceptedKinds.includes(segment.kind)
  );
}
