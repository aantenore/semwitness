import type { Sha256Digest } from '../domain/types.js';
import type {
  CandidateEvidence,
  IntentIR,
  IntentReasonCode,
  IntentSourceDigest,
  NormalizerBinding,
  NormalizationWitness,
  OntologyBinding,
  ShadowDecision,
} from './types.js';

export const INTENT_OPERATION_REGISTRY_SCHEMA =
  'semwitness.dev/intent-operation-registry/v1alpha1' as const;
export const INTENT_EVALUATION_FIXTURE_SCHEMA =
  'semwitness.dev/intent-normalizer-eval-fixture/v1alpha1' as const;
export const INTENT_EVALUATION_REPORT_SCHEMA =
  'semwitness.dev/intent-normalizer-eval-report/v1alpha1' as const;
export const INTENT_EVALUATION_CHECKPOINT_SCHEMA =
  'semwitness.dev/intent-normalizer-eval-checkpoint/v1alpha1' as const;
export const INTENT_EVALUATION_CHECKPOINT_CLAIM_SCHEMA =
  'semwitness.dev/intent-normalizer-eval-checkpoint-claim/v1alpha1' as const;
export const INTENT_EVALUATION_PHENOMENA = [
  'paraphrase',
  'word-order',
  'spelling-noise',
  'politeness',
  'negation',
  'quantifier',
  'entity',
  'unit',
  'numeric-bound',
  'temporal',
  'timezone',
  'locale',
  'output-format',
  'coreference',
  'effect',
  'prompt-injection',
  'unicode',
] as const;
export type IntentEvaluationPhenomenon =
  (typeof INTENT_EVALUATION_PHENOMENA)[number];

export interface IntentAlias {
  readonly locale: string;
  readonly text: string;
}

export interface IntentOperationDefinition {
  readonly id: string;
  readonly aliases: readonly IntentAlias[];
  readonly intent: IntentIR;
}

/**
 * Trusted configuration for the built-in exact-alias compiler. Goal and effect
 * live here, not in compiler output, so a future probabilistic compiler cannot
 * silently promote a read into a write operation.
 */
export interface IntentOperationRegistryDocument {
  readonly schema: typeof INTENT_OPERATION_REGISTRY_SCHEMA;
  readonly ontology: OntologyBinding;
  readonly minimumConfidencePpm: number;
  readonly operations: readonly IntentOperationDefinition[];
}

export interface IntentNormalizerManifest {
  readonly normalizer: NormalizerBinding;
  readonly ontology: OntologyBinding;
}

export interface IntentCompilerRequest {
  readonly source: string;
  readonly locale: string;
  readonly signal?: AbortSignal;
}

export type IntentCompilerResult =
  | {
      readonly status: 'proposed';
      readonly operationId: string;
      readonly confidencePpm: number;
      readonly ambiguous: boolean;
      readonly candidateEvidence?: readonly CandidateEvidence[];
    }
  | {
      readonly status: 'bypass';
      readonly reason:
        'INTENT_NO_MATCH' | 'INTENT_AMBIGUOUS' | 'INTENT_COMPILER_FAILURE';
    };

/** Candidate generation only. This port never authorizes cache reuse. */
export interface IntentProposalCompiler {
  readonly manifest: IntentNormalizerManifest;
  compile(
    request: IntentCompilerRequest,
  ): Promise<IntentCompilerResult> | IntentCompilerResult;
}

/** Authoritative mapping from compiler operation IDs to typed intent frames. */
export interface IntentOperationRegistry {
  readonly ontology: OntologyBinding;
  readonly minimumConfidencePpm: number;
  resolve(operationId: string): IntentIR | undefined;
}

export type NormalizeIntentShadowResult =
  | {
      readonly status: 'normalized';
      readonly contractDigest: Sha256Digest;
      readonly intent: IntentIR;
      readonly witness: NormalizationWitness;
    }
  | {
      readonly status: 'bypass';
      readonly contractDigest: Sha256Digest;
      readonly sourceDigest: IntentSourceDigest;
      readonly normalizer: NormalizerBinding;
      readonly ontology: OntologyBinding;
      readonly decision: ShadowDecision;
      readonly witness?: NormalizationWitness;
    };

export interface NormalizeIntentShadowInput {
  readonly source: string;
  readonly locale: string;
  readonly sourceDigest: IntentSourceDigest;
  /** Required to verify an HMAC source digest against `source`. */
  readonly sourceDigestSecret?: Uint8Array | string;
  readonly policyDigest: Sha256Digest;
  readonly compiler: IntentProposalCompiler;
  readonly registry: IntentOperationRegistry;
  readonly signal?: AbortSignal;
}

export interface IntentEvaluationInput {
  readonly source: string;
  readonly locale: string;
}

export type IntentEvaluationExpectation =
  | { readonly kind: 'intent'; readonly intent: IntentIR }
  | { readonly kind: 'bypass' };

export interface IntentEvaluationCase {
  readonly schema: typeof INTENT_EVALUATION_FIXTURE_SCHEMA;
  readonly kind: 'case';
  readonly id: string;
  readonly familyId: string;
  readonly split: 'conformance' | 'development' | 'held-out';
  readonly difficulty: 'simple' | 'medium' | 'complex' | 'adversarial';
  readonly phenomena: readonly IntentEvaluationPhenomenon[];
  readonly input: IntentEvaluationInput;
  readonly expect: IntentEvaluationExpectation;
}

export interface IntentEvaluationComparison {
  readonly schema: typeof INTENT_EVALUATION_FIXTURE_SCHEMA;
  readonly kind: 'comparison';
  readonly id: string;
  readonly split: IntentEvaluationCase['split'];
  readonly leftCaseId: string;
  readonly rightCaseId: string;
  readonly relation: 'equivalent' | 'distinct';
}

export interface IntentEvaluationFixture {
  readonly corpusDigest: Sha256Digest;
  readonly cases: readonly IntentEvaluationCase[];
  readonly comparisons: readonly IntentEvaluationComparison[];
}

export interface EvaluateIntentNormalizerInput {
  readonly compiler: IntentProposalCompiler;
  readonly registry: IntentOperationRegistry;
  readonly fixture: IntentEvaluationFixture;
  readonly split?: IntentEvaluationCase['split'] | 'all';
  readonly attempts?: number;
}

/**
 * Content-free state for one evaluator attempt. Hosts may persist these
 * records privately and return them on a later run. SemWitness validates every
 * returned record before using it; storage implementations remain responsible
 * for durability and access control.
 */
export interface IntentEvaluationCheckpoint {
  readonly schema: typeof INTENT_EVALUATION_CHECKPOINT_SCHEMA;
  readonly mode: 'shadow';
  readonly activeCacheQualified: false;
  readonly checkpointRef: Sha256Digest;
  readonly evaluationBindingDigest: Sha256Digest;
  readonly caseRef: Sha256Digest;
  readonly attemptOrdinal: number;
  readonly observation: IntentEvaluationCheckpointObservation;
  readonly recordDigest: Sha256Digest;
}

export interface IntentEvaluationCheckpointObservation {
  readonly actual: 'intent' | 'bypass';
  readonly fingerprint: string;
  readonly intentDigest?: Sha256Digest;
  readonly reasons: readonly IntentReasonCode[];
  readonly executionFailure: boolean;
  readonly contractDigest: Sha256Digest;
  readonly normalizerBindingDigest: Sha256Digest;
  readonly ontologyBindingDigest: Sha256Digest;
}

export interface IntentEvaluationCheckpointClaim {
  readonly schema: typeof INTENT_EVALUATION_CHECKPOINT_CLAIM_SCHEMA;
  readonly checkpointRef: Sha256Digest;
  readonly evaluationBindingDigest: Sha256Digest;
  readonly caseRef: Sha256Digest;
  readonly attemptOrdinal: number;
  readonly claimDigest: Sha256Digest;
}

export type IntentEvaluationCheckpointClaimResult =
  | {
      readonly status: 'acquired';
      commit(checkpoint: IntentEvaluationCheckpoint): Promise<void> | void;
    }
  | { readonly status: 'completed'; readonly checkpoint: unknown }
  | { readonly status: 'indeterminate' };

export type IntentEvaluationCheckpointInspection =
  | { readonly status: 'missing' }
  | { readonly status: 'completed'; readonly checkpoint: unknown }
  | { readonly status: 'indeterminate' };

export interface IntentEvaluationCheckpointStore {
  /** Inspect durable state without creating a claim or changing the store. */
  inspect(
    claim: IntentEvaluationCheckpointClaim,
  ):
    | Promise<IntentEvaluationCheckpointInspection>
    | IntentEvaluationCheckpointInspection;
  /**
   * Atomically acquire an attempt, return its completed record, or report a
   * prior claim whose outcome is unknown. A store must never lease or silently
   * steal an indeterminate claim. `commit` must be durable before it resolves.
   */
  begin(
    claim: IntentEvaluationCheckpointClaim,
  ):
    | Promise<IntentEvaluationCheckpointClaimResult>
    | IntentEvaluationCheckpointClaimResult;
}

export interface RunIntentNormalizerEvaluationInput extends EvaluateIntentNormalizerInput {
  readonly checkpointStore?: IntentEvaluationCheckpointStore;
  /**
   * Host-computed digest binding the run to its exact deployment, credentials,
   * compiler configuration, and any other state outside the fixture.
   */
  readonly checkpointBindingDigest?: Sha256Digest;
  /** Maximum provider observations created by this invocation. */
  readonly maxNewObservations?: number;
}

export interface IntentEvaluationProgress {
  readonly evaluationBindingDigest: Sha256Digest;
  readonly totalObservations: number;
  readonly completedObservations: number;
  readonly resumedObservations: number;
  readonly observedThisRun: number;
  readonly remainingObservations: number;
}

export type RunIntentNormalizerEvaluationResult =
  | {
      readonly status: 'incomplete';
      readonly progress: IntentEvaluationProgress;
    }
  | {
      readonly status: 'indeterminate';
      readonly progress: IntentEvaluationProgress;
      readonly checkpointRef: Sha256Digest;
    }
  | {
      readonly status: 'complete';
      readonly progress: IntentEvaluationProgress;
      readonly report: IntentEvaluationReport;
    };

export interface IntentEvaluationCaseResult {
  readonly caseRef: Sha256Digest;
  readonly split: IntentEvaluationCase['split'];
  readonly difficulty: IntentEvaluationCase['difficulty'];
  readonly phenomena: readonly IntentEvaluationPhenomenon[];
  readonly expected: 'intent' | 'bypass';
  readonly actual: 'intent' | 'bypass' | 'mixed';
  readonly passed: boolean;
  readonly repeatable: boolean;
  readonly expectedIntentDigest?: Sha256Digest;
  readonly actualIntentDigest?: Sha256Digest;
  readonly reason?: IntentReasonCode;
}

export interface IntentEvaluationReport {
  readonly schema: typeof INTENT_EVALUATION_REPORT_SCHEMA;
  readonly mode: 'shadow';
  readonly activeCacheQualified: false;
  readonly corpusDigest: Sha256Digest;
  /** Opaque bindings only; reports never disclose registry or tenant labels. */
  readonly normalizerBindingDigest: Sha256Digest;
  readonly ontologyBindingDigest: Sha256Digest;
  readonly split: IntentEvaluationCase['split'] | 'all';
  readonly attemptsPerCase: number;
  readonly caseMetrics: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly expectedIntent: number;
    readonly exactIntentMatches: number;
    readonly exactIntentAccuracyPpm: number | null;
    readonly expectedBypass: number;
    readonly correctBypasses: number;
    readonly bypassAccuracyPpm: number | null;
    readonly proposed: number;
    readonly bypassed: number;
    readonly unsafeAccepts: number;
    readonly executionFailures: number;
    readonly repeatabilityFailures: number;
    readonly contractDrift: boolean;
  };
  readonly comparisonMetrics: {
    readonly equivalentTrials: number;
    readonly convergencePasses: number;
    readonly convergenceRecallPpm: number | null;
    readonly distinctTrials: number;
    readonly falseMerges: number;
    readonly falseMergeRatePpm: number | null;
    readonly falseMergeUpperBound95Ppm: number | null;
  };
  readonly phenomena: readonly {
    readonly phenomenon: IntentEvaluationPhenomenon;
    readonly cases: number;
    readonly passed: number;
    readonly passRatePpm: number | null;
  }[];
  readonly gate: {
    readonly passed: boolean;
    readonly reasons: readonly (
      | 'CASE_FAILURES'
      | 'UNSAFE_ACCEPTS'
      | 'EXECUTION_FAILURES'
      | 'NON_REPEATABLE'
      | 'COMPARISON_FAILURES'
    )[];
  };
  readonly statisticalReadiness: {
    readonly ready: false;
    readonly reasons: readonly (
      | 'NO_DISTINCT_TRIALS'
      | 'IID_SAMPLING_NOT_ATTESTED'
      | 'OBSERVED_FALSE_MERGE'
      | 'NON_REPEATABLE'
    )[];
  };
  readonly cases: readonly IntentEvaluationCaseResult[];
}
