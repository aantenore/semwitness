export interface CostEstimate {
  readonly amountMicros: bigint;
  readonly currency: string;
  readonly confidence: 'exact' | 'configured' | 'estimated';
}

export interface CostAdapter {
  readonly id: string;
  estimate(input: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens?: number;
  }): Promise<CostEstimate>;
}
