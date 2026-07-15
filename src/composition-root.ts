import { join } from 'node:path';
import { IdentityCodec } from './adapters/codecs/identity.js';
import { JsonJcsCodec } from './adapters/codecs/json-jcs.js';
import { LogRepeatCodec } from './adapters/codecs/log-repeat.js';
import { WhitespaceRleCodec } from './adapters/codecs/whitespace-rle.js';
import { FilesystemCas } from './adapters/filesystem-cas.js';
import { HeuristicTokenizer } from './adapters/heuristic-tokenizer.js';
import { analyzeSegment, type AnalysisReport } from './application/analyze.js';
import { CodecRegistry } from './application/codec-registry.js';
import {
  simulateSegment,
  type SimulationResult,
} from './application/simulate.js';
import {
  verifyProofEnvelope,
  type VerificationResult,
} from './application/verify.js';
import {
  DEFAULT_POLICY,
  validatePolicy,
  type CodecPolicy,
} from './domain/policy.js';
import type { ProofEnvelope } from './domain/proof.js';
import type { Segment, Sha256Digest } from './domain/types.js';
import type { Codec, EncodedCandidate } from './ports/codec.js';
import type { TokenizerAdapter } from './ports/tokenizer.js';

export interface SemWitnessOptions {
  readonly storeRoot: string;
  readonly policy?: CodecPolicy;
  readonly tokenizer?: TokenizerAdapter;
  readonly codecs?: readonly Codec[];
}

export interface SemWitnessCore {
  readonly policy: CodecPolicy;
  readonly registry: CodecRegistry;
  readonly tokenizer: TokenizerAdapter;
  analyze(segment: Segment, policy?: CodecPolicy): Promise<AnalysisReport>;
  simulate(segment: Segment, policy?: CodecPolicy): Promise<SimulationResult>;
  verify(
    proof: ProofEnvelope,
    segment: Segment,
    encoded: EncodedCandidate,
    policy?: CodecPolicy,
  ): Promise<VerificationResult>;
  retrieve(reference: Sha256Digest, policy?: CodecPolicy): Promise<Uint8Array>;
}

export function createDefaultRegistry(
  additionalCodecs: readonly Codec[] = [],
): CodecRegistry {
  const registry = new CodecRegistry()
    .register(new IdentityCodec())
    .register(new WhitespaceRleCodec())
    .register(new LogRepeatCodec())
    .register(new JsonJcsCodec());
  for (const codec of additionalCodecs) {
    registry.register(codec);
  }
  return registry;
}

export function createSemWitness(options: SemWitnessOptions): SemWitnessCore {
  if (options.storeRoot.trim().length === 0) {
    throw new TypeError('storeRoot must be a non-empty explicit path');
  }
  const defaultPolicy = validatePolicy(options.policy ?? DEFAULT_POLICY);
  const tokenizer = options.tokenizer ?? new HeuristicTokenizer();
  const registry = createDefaultRegistry(options.codecs);

  const resolve = (candidate?: CodecPolicy) => {
    const policy = validatePolicy(candidate ?? defaultPolicy);
    const store = new FilesystemCas(
      join(options.storeRoot, policy.store.namespace),
      {
        maxObjectBytes: Math.max(
          policy.limits.maxInputBytes,
          policy.limits.maxEncodedBytes,
        ),
      },
    );
    return { policy, store };
  };

  return Object.freeze({
    policy: defaultPolicy,
    registry,
    tokenizer,
    async analyze(segment: Segment, candidate?: CodecPolicy) {
      const { policy, store } = resolve(candidate);
      return analyzeSegment({ registry, tokenizer, store }, segment, policy);
    },
    async simulate(segment: Segment, candidate?: CodecPolicy) {
      const { policy, store } = resolve(candidate);
      return simulateSegment({ registry, tokenizer, store }, segment, policy);
    },
    async verify(
      proof: ProofEnvelope,
      segment: Segment,
      encoded: EncodedCandidate,
      candidate?: CodecPolicy,
    ) {
      const { policy, store } = resolve(candidate);
      return verifyProofEnvelope({
        proof,
        segment,
        encoded,
        policy,
        registry,
        tokenizer,
        store,
      });
    },
    async retrieve(reference: Sha256Digest, candidate?: CodecPolicy) {
      const { store } = resolve(candidate);
      return store.get(reference);
    },
  });
}
