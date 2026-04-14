// ============================================================
// Guardian Protocol — Output Types
// The structured JSON verdict returned to the calling agent.
// ============================================================

import type { Address } from "./input.js";

// ---------------------- Risk Flags ----------------------

/**
 * Every discrete risk signal Guardian can flag.
 * Each analyzer contributes its own flag types.
 */
export enum RiskFlagCode {
  // Token-level risks
  HONEYPOT_DETECTED = "HONEYPOT_DETECTED",
  PROXY_CONTRACT_UPGRADEABLE = "PROXY_CONTRACT_UPGRADEABLE",
  OWNERSHIP_NOT_RENOUNCED = "OWNERSHIP_NOT_RENOUNCED",
  MINT_FUNCTION_PRESENT = "MINT_FUNCTION_PRESENT",
  LOW_HOLDER_COUNT = "LOW_HOLDER_COUNT",
  HIGH_TAX_TOKEN = "HIGH_TAX_TOKEN",
  BLACKLIST_FUNCTION = "BLACKLIST_FUNCTION",
  UNVERIFIED_CONTRACT = "UNVERIFIED_CONTRACT",
  API_UNAVAILABLE = "API_UNAVAILABLE",
  TOKEN_NOT_FOUND = "TOKEN_NOT_FOUND",
  ANALYZER_ERROR = "ANALYZER_ERROR",
  ROUTE_UNAVAILABLE = "ROUTE_UNAVAILABLE",

  // Liquidity risks
  LOW_LIQUIDITY_DEPTH = "LOW_LIQUIDITY_DEPTH",
  SINGLE_POOL_DEPENDENCY = "SINGLE_POOL_DEPENDENCY",
  LIQUIDITY_LOCKED_EXPIRED = "LIQUIDITY_LOCKED_EXPIRED",
  HIGH_PRICE_IMPACT = "HIGH_PRICE_IMPACT",

  // Transaction / MEV risks
  SANDWICH_ATTACK_LIKELY = "SANDWICH_ATTACK_LIKELY",
  FRONTRUN_RISK_HIGH = "FRONTRUN_RISK_HIGH",
  TX_SIMULATION_REVERTED = "TX_SIMULATION_REVERTED",
  UNEXPECTED_STATE_CHANGE = "UNEXPECTED_STATE_CHANGE",
  GAS_ESTIMATION_FAILED = "GAS_ESTIMATION_FAILED",
  FUZZING_INVARIANT_VIOLATION = "FUZZING_INVARIANT_VIOLATION",

  // AMM Pool / Concentrated Liquidity risks
  AMM_THIN_LIQUIDITY = "AMM_THIN_LIQUIDITY",
  AMM_TICK_GAP_MANIPULATION = "AMM_TICK_GAP_MANIPULATION",
  AMM_PRICE_DEVIATION = "AMM_PRICE_DEVIATION",
  AMM_ONESIDED_LIQUIDITY = "AMM_ONESIDED_LIQUIDITY",
  AMM_READ_FAILED = "AMM_READ_FAILED",

  // Private MEV flow
  PRIVATE_MEV_FLOW_HIGH = "PRIVATE_MEV_FLOW_HIGH",

  // Wallet / Approval risks
  EXCESSIVE_TOKEN_APPROVALS = "EXCESSIVE_TOKEN_APPROVALS",
  APPROVAL_TO_KNOWN_PHISHER = "APPROVAL_TO_KNOWN_PHISHER",
  WALLET_RECENTLY_DRAINED = "WALLET_RECENTLY_DRAINED",
}

/**
 * Severity tiers for risk flags.
 */
export type RiskSeverity = "critical" | "high" | "medium" | "low" | "info";

/**
 * A single risk flag with human-readable context.
 */
export interface RiskFlag {
  /** Machine-readable flag code. */
  code: RiskFlagCode;

  /** Severity level. */
  severity: RiskSeverity;

  /** Human-readable explanation for agent or end-user. */
  message: string;

  /** The analyzer module that raised this flag. */
  source: string;
}

// -------------------- Safety Score ----------------------

/**
 * The composite safety score for the proposed trade.
 *
 * Range: 0–100 where:
 *   0–29  = CRITICAL — do not execute
 *  30–49  = DANGEROUS — strongly advise against
 *  50–69  = CAUTION — proceed with additional safeguards
 *  70–89  = MODERATE — generally safe, minor concerns
 *  90–100 = SAFE — no significant risks detected
 */
export interface SafetyScore {
  /** Aggregate score (0–100). */
  overall: number;

  /** Per-category breakdown for transparency. */
  breakdown: {
    /** Token contract risk sub-score (0–100). */
    tokenRisk: number;

    /** Liquidity and price impact sub-score (0–100). */
    liquidityRisk: number | null;

    /** MEV / sandwich attack exposure sub-score (0–100). */
    mevRisk: number;

    /** AMM concentrated liquidity pool risk sub-score (0–100). */
    ammPoolRisk: number;

    /** Wallet approval hygiene sub-score (0–100). */
    walletRisk: number | null;

    /** Transaction simulation sub-score (0–100). */
    txSimulation: number;
  };

  /** Human-readable risk tier. */
  tier: "CRITICAL" | "DANGEROUS" | "CAUTION" | "MODERATE" | "SAFE";
}

// ----------------- Optimized Routing --------------------

/**
 * An optimized swap route returned by Guardian when it
 * constructs its own transaction (i.e. no proposedTxHex).
 */
export interface OptimizedRouting {
  /** DEX aggregator used to find the route. */
  aggregator: string;

  /** Ordered list of pool hops. */
  path: Array<{
    poolAddress: Address | null;
    protocol: string;
    tokenIn: Address;
    tokenOut: Address;
    fee: number | null;
    percent?: number;
  }>;

  /** Expected output amount (human-readable decimal). */
  expectedOutputAmount: string;

  /** Expected output amount in raw units when quote data is available. */
  expectedOutputAmountRaw?: string;

  /** Slippage tolerance used (basis points). */
  slippageBps: number;

  /** Estimated gas units for this route. */
  estimatedGas: string | null;

  /** Quote-only routes may not include a pre-built transaction payload yet. */
  txHex: string | null;

  /** Best-effort router target when exposed by the quote source. */
  routerAddress?: Address | null;

  /** Indicates whether this is quote-only route metadata. */
  quoteOnly?: boolean;
}

// -------------- Guardian Evaluation Response ------------

/**
 * The complete response from Guardian Protocol's evaluate endpoint.
 * This is what the calling agent receives and acts on.
 */
export interface GuardianEvaluationResponse {
  /** Unique ID for this evaluation run (UUID). */
  evaluationId: string;

  /** ISO 8601 timestamp when the evaluation completed. */
  timestamp: string;

  /** Chain ID the evaluation was performed on. */
  chainId: number;

  /** The composite safety score and tier. */
  safetyScore: SafetyScore;

  /**
   * THE PRIMARY VERDICT.
   * true  = Guardian approves execution.
   * false = Guardian blocks execution (check flags for reasons).
   *
   * Agents MUST check this field before submitting the transaction.
   */
  isSafeToExecute: boolean;

  /**
   * All risk flags raised, sorted by severity (critical first).
   * Empty array = no issues detected.
   */
  flags: RiskFlag[];

  /**
   * An optimized route if Guardian built one; null if the agent
   * provided its own proposedTxHex.
   */
  optimizedRouting: OptimizedRouting | null;

  /** Pipeline metadata for observability and debugging. */
  meta: {
    /** Guardian Protocol version string. */
    guardianVersion: string;

    /** Total wall-clock time for the evaluation (ms). */
    evaluationDurationMs: number;

    /** Per-analyzer timing and status. */
    analyzersRun: Array<{
      name: string;
      durationMs: number;
      status: "success" | "error" | "skipped";
    }>;

    /** Canonical trade context Guardian resolved before analysis. */
    tradeContext?: {
      amountRaw: string;
      tokenInDecimals: number;
      tokenOutDecimals: number;
      estimatedTradeUsd: number;
      poolAddress: Address | null;
      contextSource: "caller" | "okx-dex" | "fallback";
      hasQuoteData: boolean;
    };
  };
}

// ------------- Convenience Response Types ---------------

export interface TokenScanResponse {
  evaluationId: string;
  timestamp: string;
  chainId: number;
  tokenAddress: Address;
  safetyScore: {
    overall: number;
    tier: SafetyScore["tier"];
    tokenRisk: number;
  };
  flags: RiskFlag[];
  isSafe: boolean;
}

export interface TxSimulationResponse {
  evaluationId: string;
  timestamp: string;
  chainId: number;
  safetyScore: {
    overall: number;
  };
  simulationSuccess: boolean;
  gasUsed: string;
  stateChanges: Array<{
    address: Address;
    tokenAddress: Address;
    delta: string;
  }>;
  flags: RiskFlag[];
}
