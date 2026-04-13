// ============================================================
// Guardian Protocol — Internal Types
// Used between analyzer modules; NOT exposed to calling agents.
// ============================================================

import type { RiskFlag, OptimizedRouting } from "./output.js";
import type { Address, HexString, SupportedChainId } from "./input.js";

/**
 * Context object passed through the analysis pipeline.
 * Accumulated by each analyzer in sequence.
 */
export interface AnalysisContext {
  chainId: SupportedChainId;
  tokenIn: Address;
  tokenOut: Address;
  amountRaw: string;
  userAddress: Address;
  proposedTxHex?: HexString;
}

/**
 * Canonical trade context after Guardian resolves quote/routing and
 * token metadata inputs.
 */
export interface ResolvedTradeContext extends AnalysisContext {
  amountRawBigInt: bigint;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  amountInDecimal: string;
  expectedOutputRaw: bigint | null;
  estimatedTradeUsd: number;
  targetAddress: Address | null;
  poolAddress: Address | null;
  optimizedRouting: OptimizedRouting | null;
  contextSource: "caller" | "okx-dex" | "fallback";
  hasQuoteData: boolean;
}

/**
 * Result returned by each individual analyzer module.
 */
export interface AnalyzerResult {
  /** Which analyzer produced this result. */
  analyzerName: string;

  /** Flags raised by this analyzer. */
  flags: RiskFlag[];

  /** Raw sub-score contributed by this analyzer (0–100). */
  score: number;

  /** Execution duration in ms. */
  durationMs: number;

  /** Analyzer-specific structured data for downstream use. */
  data: Record<string, unknown>;
}
