import type { CodecPolicy } from '../domain/policy.js';
import type { ProofEnvelope } from '../domain/proof.js';
import type { Segment } from '../domain/types.js';
import {
  simulateSegment,
  type CandidateReport,
  type SimulationDependencies,
} from './simulate.js';

export interface AnalysisReport {
  readonly segmentId: string;
  readonly applied: boolean;
  readonly selectedCodec: string;
  readonly originalSha256: string;
  readonly encodedSha256: string;
  readonly proof: ProofEnvelope;
  readonly candidates: readonly CandidateReport[];
}

export async function analyzeSegment(
  dependencies: SimulationDependencies,
  segment: Segment,
  policy: CodecPolicy,
): Promise<AnalysisReport> {
  const simulation = await simulateSegment(dependencies, segment, policy);
  return {
    segmentId: simulation.segmentId,
    applied: simulation.applied,
    selectedCodec: simulation.selectedCodec,
    originalSha256: simulation.proof.original.sha256,
    encodedSha256: simulation.proof.encoded.sha256,
    proof: simulation.proof,
    candidates: simulation.candidates,
  };
}
