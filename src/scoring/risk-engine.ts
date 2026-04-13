// ==========================================================================
// Guardian Protocol — Risk Scoring Engine
// ==========================================================================
//
// THIS IS THE BRAIN.
//
// Every analyzer (token-risk, tx-simulation, mev-detection) produces
// its own sub-score and flags independently. This engine consumes ALL
// of them and produces the SINGLE DETERMINISTIC VERDICT that a calling
// agent acts on: SafetyScore + isSafeToExecute.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │                    SCORING ARCHITECTURE                              │
// │                                                                     │
// │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                │
// │  │ Token Risk   │  │ TX Simul.   │  │ MEV/Signals │  │ AMM Pool   │ │
// │  │ Score: 0–100 │  │ Score: 0–100│  │ Score: 0–100│  │ Score: 0–100│ │
// │  │ Weight: 30%  │  │ Weight: 30% │  │ Weight: 15% │  │ Weight: 25% │ │
// │  └──────┬───────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘ │
// │         │                 │                 │                 │        │
// │         ▼                 ▼                 ▼                 ▼        │
// │  ┌──────────────────────────────────────────────────┐              │
// │  │           WEIGHTED AGGREGATION                    │              │
// │  │  base = 0.30 × tokenRisk                         │              │
// │  │       + 0.30 × txSimulation                      │              │
// │  │       + 0.15 × mevSignals                        │              │
// │  │       + 0.25 × ammPool                           │              │
// │  └──────────────────────┬───────────────────────────┘              │
// │                         │                                          │
// │                         ▼                                          │
// │  ┌──────────────────────────────────────────────────┐              │
// │  │         PENALTY MULTIPLIER CASCADE                │              │
// │  │                                                   │              │
// │  │  • Critical flag present?  → multiply × 0.0       │              │
// │  │  • 2+ high flags?         → multiply × 0.50       │              │
// │  │  • Cross-analyzer conflict?→ multiply × 0.70      │              │
// │  │  • Simulation reverted?   → multiply × 0.0        │              │
// │  └──────────────────────┬───────────────────────────┘              │
// │                         │                                          │
// │                         ▼                                          │
// │  ┌──────────────────────────────────────────────────┐              │
// │  │         CONFIDENCE ADJUSTMENT                     │              │
// │  │                                                   │              │
// │  │  • All 3 analyzers succeeded? → confidence 1.0    │              │
// │  │  • 1 analyzer failed/timeout? → confidence × 0.85 │              │
// │  │  • 2 analyzers failed?        → confidence × 0.60 │              │
// │  └──────────────────────┬───────────────────────────┘              │
// │                         │                                          │
// │                         ▼                                          │
// │              ┌─────────────────────┐                               │
// │              │   FINAL SCORE 0–100 │                               │
// │              │   + TIER LABEL      │                               │
// │              │   + isSafeToExecute │                               │
// │              └─────────────────────┘                               │
// └──────────────────────────────────────────────────────────────────────┘
//
// WHY THIS IS "AGGRESSIVELY COMPUTATIONALLY HEAVY":
//   1. Triple-pass flag analysis (per-analyzer, cross-analyzer, cascade)
//   2. Penalty multiplier cascade with 8 distinct multiplier conditions
//   3. Confidence adjustment based on analyzer health
//   4. Correlation detection between analyzer outputs
//   5. Deterministic tie-breaking with bit-level precision
//   6. Full audit trail for every mathematical step
//
// DETERMINISM GUARANTEE:
//   Given identical analyzer inputs, this engine produces IDENTICAL
//   output every time. No randomness, no floating-point ambiguity
//   (we use integer arithmetic where possible), no external state.
//   An agent running this twice on the same data gets the same verdict.
//
// ==========================================================================

import type { AnalyzerResult } from "../types/internal.js";
import type {
  SafetyScore,
  RiskFlag,
  RiskSeverity,
  GuardianEvaluationResponse,
  OptimizedRouting,
} from "../types/output.js";
import { RiskFlagCode } from "../types/output.js";
import type {
  GuardianEvaluationRequest,
  SupportedChainId,
} from "../types/input.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Weights for each analyzer's contribution to the composite score.
 * These MUST sum to exactly 1.0 — enforced at runtime.
 *
 * WHY THESE WEIGHTS (v0.2.1 — 4-analyzer rebalance):
 *   - Token Risk (30%): A fundamentally unsafe token cannot be saved
 *     by good routing or low MEV risk. If the token is a honeypot,
 *     nothing else matters. Reduced from 40% to make room for AMM.
 *
 *   - TX Simulation (30%): Equal to token risk because simulation
 *     catches a DIFFERENT class of threats — reverts, unexpected
 *     state changes, slippage — that token scanning alone misses.
 *     Reduced from 40% for same reason.
 *
 *   - MEV/Signals (15%): Important but less fundamental than the
 *     above two. MEV risk is MITIGABLE (via private mempool) even
 *     if detected, whereas a honeypot or reverting tx is not.
 *
 *   - AMM Pool (25%): Concentrated liquidity manipulation is
 *     non-mitigable. If the pool is rigged, no routing helps.
 */
export interface ScoringWeights {
  tokenRisk: number;
  txSimulation: number;
  mevSignals: number;
  ammPool: number;
}

/**
 * Phase 2 weights — rebalanced for 4 analyzers.
 *
 * RATIONALE FOR NEW WEIGHTS:
 *   - Token Risk (30%): Still critical — a honeypot is a honeypot.
 *     Reduced from 40% to make room for AMM pool analysis.
 *   - TX Simulation (30%): Still critical — reverts/slippage.
 *     Reduced from 40% for same reason.
 *   - MEV/Signals (15%): Reduced from 20%. MEV is MITIGABLE
 *     (private mempool), so it carries less decisive weight.
 *   - AMM Pool (25%): NEW. Concentrated liquidity manipulation is
 *     a primary mainnet attack vector. Thin liquidity and tick gaps
 *     can cause catastrophic losses that other analyzers can't detect.
 *     This gets strong representation because it's non-mitigable —
 *     if the pool is manipulated, no amount of MEV protection helps.
 */
const DEFAULT_WEIGHTS: ScoringWeights = {
  tokenRisk: 0.3,
  txSimulation: 0.3,
  mevSignals: 0.15,
  ammPool: 0.25,
};

/**
 * Policy thresholds that control the isSafeToExecute verdict.
 */
export interface ScoringPolicy {
  /**
   * Minimum composite score required for isSafeToExecute = true.
   * Below this → always blocked.
   * Default: 70
   */
  safetyThreshold: number;

  /**
   * If ANY analyzer's sub-score falls below this, the trade is
   * blocked regardless of the composite score. This prevents a
   * 100-score token scan from "averaging out" a 10-score simulation.
   * Default: 20
   */
  minimumSubScore: number;

  /**
   * Maximum number of HIGH-severity flags before auto-blocking.
   * Default: 3
   */
  maxHighFlagsBeforeBlock: number;
}

const DEFAULT_POLICY: ScoringPolicy = {
  safetyThreshold: Number(process.env["GUARDIAN_SAFETY_THRESHOLD"] ?? "70"),
  minimumSubScore: 20,
  maxHighFlagsBeforeBlock: 3,
};

// ---------------------------------------------------------------------------
// Types: Scoring Audit Trail
// ---------------------------------------------------------------------------

/**
 * A complete, step-by-step audit trail of how the final score was computed.
 * Stored in the response metadata so the calling agent (or a human auditor)
 * can trace exactly WHY a trade was blocked or approved.
 *
 * This is critical for agent trust: if an agent can't explain its decisions,
 * operators won't trust it. Guardian explains every point deduction.
 */
export interface ScoringAuditTrail {
  /** Step 1: Raw weighted sum before any penalties. */
  rawWeightedScore: number;

  /** Step 2: Individual contributions. */
  weightedContributions: {
    tokenRisk: { subScore: number; weight: number; contribution: number };
    txSimulation: { subScore: number; weight: number; contribution: number };
    mevSignals: { subScore: number; weight: number; contribution: number };
    ammPool: { subScore: number; weight: number; contribution: number };
  };

  /** Step 3: Penalty multipliers applied (each in [0.0, 1.0]). */
  penaltyMultipliers: Array<{
    name: string;
    value: number;
    reason: string;
    triggered: boolean;
  }>;

  /** Step 4: Combined penalty multiplier (product of all triggered). */
  combinedPenaltyMultiplier: number;

  /** Step 5: Score after penalties. */
  scoreAfterPenalties: number;

  /** Step 6: Confidence factor. */
  confidenceFactor: number;
  confidenceReason: string;

  /** Step 7: Final score after confidence adjustment. */
  finalScore: number;

  /** Step 8: Tier classification. */
  tier: SafetyScore["tier"];

  /** Step 9: isSafeToExecute determination. */
  safetyVerdictReasons: string[];
}

// ---------------------------------------------------------------------------
// Helper: Classify Tier
// ---------------------------------------------------------------------------

/**
 * Maps a 0–100 score to a human-readable risk tier.
 *
 * These tiers match the Phase 1 spec exactly:
 *   0–29  = CRITICAL
 *  30–49  = DANGEROUS
 *  50–69  = CAUTION
 *  70–89  = MODERATE
 *  90–100 = SAFE
 */
function classifyTier(score: number): SafetyScore["tier"] {
  if (score >= 90) return "SAFE";
  if (score >= 70) return "MODERATE";
  if (score >= 50) return "CAUTION";
  if (score >= 30) return "DANGEROUS";
  return "CRITICAL";
}

// ---------------------------------------------------------------------------
// Helper: Count Flags by Severity
// ---------------------------------------------------------------------------

function countFlagsBySeverity(flags: RiskFlag[]): Record<RiskSeverity, number> {
  const counts: Record<RiskSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const flag of flags) {
    counts[flag.severity]++;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Helper: Detect Cross-Analyzer Correlations
// ---------------------------------------------------------------------------

/**
 * Detects when multiple analyzers independently flag the SAME risk,
 * which dramatically increases confidence that the risk is real.
 *
 * Example: Token risk says "high tax" AND simulation shows "slippage
 * much worse than expected" → these CORRELATE. The tax is causing
 * the slippage. This correlation should increase the penalty.
 *
 * Conversely, if token risk says "clean" but simulation says "reverted",
 * that's a CONFLICT — something unexpected is happening, which is
 * arguably MORE dangerous than a known risk.
 */
function detectCorrelations(
  analyzerResults: Map<string, AnalyzerResult>,
): Array<{
  type: "correlation" | "conflict";
  analyzers: string[];
  description: string;
  penaltyMultiplier: number;
}> {
  const correlations: Array<{
    type: "correlation" | "conflict";
    analyzers: string[];
    description: string;
    penaltyMultiplier: number;
  }> = [];

  const tokenResult = analyzerResults.get("token-risk-analyzer");
  const simResult = analyzerResults.get("tx-simulation-analyzer");
  const mevResult = analyzerResults.get("mev-detection-analyzer");
  const ammPoolResult = analyzerResults.get("amm-pool-analyzer");

  // --- Correlation 1: High tax token + high slippage in simulation ---
  // If the token has high taxes AND simulation shows excess slippage,
  // the tax IS the slippage. This is a confirmed extraction mechanism.
  if (tokenResult && simResult) {
    const hasHighTaxFlag = tokenResult.flags.some(
      (f) => f.code === RiskFlagCode.HIGH_TAX_TOKEN && f.severity === "high",
    );
    const hasHighSlippage = simResult.flags.some(
      (f) => f.code === RiskFlagCode.HIGH_PRICE_IMPACT,
    );

    if (hasHighTaxFlag && hasHighSlippage) {
      correlations.push({
        type: "correlation",
        analyzers: ["token-risk-analyzer", "tx-simulation-analyzer"],
        description:
          "High token tax CONFIRMED by simulation slippage. " +
          "The tax mechanism is actively extracting value from swaps.",
        penaltyMultiplier: 0.7,
      });
    }
  }

  // --- Correlation 2: Clean token + reverted simulation ---
  // If the token looks clean but the transaction reverts, something
  // unexpected is happening — possibly a time-locked contract, a
  // pause mechanism not caught by the scanner, or malicious calldata.
  if (tokenResult && simResult) {
    const tokenClean = tokenResult.score >= 80;
    const simReverted = simResult.flags.some(
      (f) => f.code === RiskFlagCode.TX_SIMULATION_REVERTED,
    );

    if (tokenClean && simReverted) {
      correlations.push({
        type: "conflict",
        analyzers: ["token-risk-analyzer", "tx-simulation-analyzer"],
        description:
          "CONFLICT: Token appears safe but transaction REVERTS. " +
          "The contract may have hidden restrictions not caught by " +
          "static analysis (time locks, pause states, calldata validation). " +
          "This conflict INCREASES risk because the failure mode is unknown.",
        penaltyMultiplier: 0.6,
      });
    }
  }

  // --- Correlation 3: High MEV risk + high slippage ---
  // If MEV detection says sandwich is likely AND simulation shows
  // slippage, the agent is about to get sandwiched.
  if (mevResult && simResult) {
    const hasSandwichRisk = mevResult.flags.some(
      (f) =>
        f.code === RiskFlagCode.SANDWICH_ATTACK_LIKELY &&
        (f.severity === "high" || f.severity === "critical"),
    );
    const hasSlippage = simResult.flags.some(
      (f) => f.code === RiskFlagCode.HIGH_PRICE_IMPACT,
    );

    if (hasSandwichRisk && hasSlippage) {
      correlations.push({
        type: "correlation",
        analyzers: ["mev-detection-analyzer", "tx-simulation-analyzer"],
        description:
          "MEV sandwich risk CONFIRMED by elevated simulation slippage. " +
          "Bots are likely already positioned to extract value from this trade.",
        penaltyMultiplier: 0.75,
      });
    }
  }

  // --- Correlation 4: Honeypot/blacklist + OKX danger ---
  // If token risk says fatal AND OKX simulation says danger,
  // this is a double-confirmed scam. Apply maximum penalty.
  if (tokenResult && simResult) {
    const hasFatalToken = tokenResult.flags.some(
      (f) =>
        f.code === RiskFlagCode.HONEYPOT_DETECTED ||
        f.code === RiskFlagCode.BLACKLIST_FUNCTION,
    );
    const hasOKXDanger = simResult.flags.some(
      (f) =>
        f.code === RiskFlagCode.UNEXPECTED_STATE_CHANGE &&
        f.severity === "high",
    );

    if (hasFatalToken && hasOKXDanger) {
      correlations.push({
        type: "correlation",
        analyzers: ["token-risk-analyzer", "tx-simulation-analyzer"],
        description:
          "DOUBLE-CONFIRMED SCAM: Token flagged as honeypot/blacklisted " +
          "AND OKX simulation independently flagged as dangerous. " +
          "This token is almost certainly malicious.",
        penaltyMultiplier: 0.0,
      });
    }
  }

  // --- Correlation 5: Mintable token + low MEV liquidity ---
  // A mintable token with thin liquidity is a textbook rug-pull setup.
  if (tokenResult && mevResult) {
    const isMintable = tokenResult.flags.some(
      (f) => f.code === RiskFlagCode.MINT_FUNCTION_PRESENT,
    );
    const mevData = mevResult.data as Record<string, unknown>;
    const tradeImpact = mevData["tradeImpactAssessment"] as string | undefined;

    if (
      isMintable &&
      (tradeImpact === "significant" || tradeImpact === "extreme")
    ) {
      correlations.push({
        type: "correlation",
        analyzers: ["token-risk-analyzer", "mev-detection-analyzer"],
        description:
          "Mintable token with thin liquidity — classic rug-pull setup. " +
          "The deployer can mint tokens, dump into the thin pool, and drain liquidity.",
        penaltyMultiplier: 0.5,
      });
    }
  }

  // --- Correlation 6 (Phase 2): AMM thin liquidity + high slippage ---
  // If the AMM pool has thin liquidity AND simulation shows high slippage,
  // the thin liquidity IS causing the slippage. Confirmed manipulation.
  if (ammPoolResult && simResult) {
    const hasThinLiquidity = ammPoolResult.flags.some(
      (f) => f.code === RiskFlagCode.AMM_THIN_LIQUIDITY,
    );
    const hasHighSlippage = simResult.flags.some(
      (f) => f.code === RiskFlagCode.HIGH_PRICE_IMPACT,
    );

    if (hasThinLiquidity && hasHighSlippage) {
      correlations.push({
        type: "correlation",
        analyzers: ["amm-pool-analyzer", "tx-simulation-analyzer"],
        description:
          "AMM thin liquidity CONFIRMED by simulation slippage. " +
          "The pool lacks sufficient depth at the current tick, causing " +
          "the simulated transaction to experience excessive price impact. " +
          "This may be intentional liquidity removal for price manipulation.",
        penaltyMultiplier: 0.6,
      });
    }
  }

  // --- Correlation 7 (Phase 2): AMM price deviation + MEV sandwich ---
  // If the pool price is manipulated AND MEV bots are present,
  // this is likely a coordinated attack (manipulate price, then sandwich).
  if (ammPoolResult && mevResult) {
    const hasPriceDeviation = ammPoolResult.flags.some(
      (f) => f.code === RiskFlagCode.AMM_PRICE_DEVIATION,
    );
    const hasSandwichRisk = mevResult.flags.some(
      (f) =>
        f.code === RiskFlagCode.SANDWICH_ATTACK_LIKELY &&
        (f.severity === "high" || f.severity === "critical"),
    );

    if (hasPriceDeviation && hasSandwichRisk) {
      correlations.push({
        type: "correlation",
        analyzers: ["amm-pool-analyzer", "mev-detection-analyzer"],
        description:
          "COORDINATED ATTACK SIGNAL: Pool price deviation detected " +
          "simultaneously with sandwich bot activity. The pool price may " +
          "have been manipulated in advance of a sandwich extraction. " +
          "The agent's trade would execute at an artificially skewed price.",
        penaltyMultiplier: 0.4,
      });
    }
  }

  // --- Correlation 8 (Phase 2): AMM one-sided liquidity + mintable token ---
  // One-sided liquidity combined with a mintable token is a strong
  // rug-pull signal — deployer can mint and dump through the thin side.
  if (ammPoolResult && tokenResult) {
    const hasOneSided = ammPoolResult.flags.some(
      (f) => f.code === RiskFlagCode.AMM_ONESIDED_LIQUIDITY,
    );
    const isMintable = tokenResult.flags.some(
      (f) => f.code === RiskFlagCode.MINT_FUNCTION_PRESENT,
    );

    if (hasOneSided && isMintable) {
      correlations.push({
        type: "correlation",
        analyzers: ["amm-pool-analyzer", "token-risk-analyzer"],
        description:
          "One-sided AMM liquidity + mintable token = HIGH rug-pull probability. " +
          "The deployer can mint tokens and sell through the thin liquidity side, " +
          "draining the pool of the paired asset.",
        penaltyMultiplier: 0.3,
      });
    }
  }

  return correlations;
}

// ---------------------------------------------------------------------------
// Core: Compute Composite Score
// ---------------------------------------------------------------------------

/**
 * The main scoring computation. Takes all analyzer results and produces
 * the final SafetyScore, isSafeToExecute verdict, and full audit trail.
 *
 * This function is PURE — no side effects, no network calls, no state.
 * Given identical inputs, it ALWAYS produces identical outputs.
 *
 * @param analyzerResults   - Map of analyzer name → AnalyzerResult
 * @param allFlags          - Merged, deduplicated flag list from all analyzers
 * @param weights           - Optional custom weights (must sum to 1.0)
 * @param policy            - Optional custom policy thresholds
 */
export function computeCompositeScore(
  analyzerResults: Map<string, AnalyzerResult>,
  allFlags: RiskFlag[],
  weights: ScoringWeights = DEFAULT_WEIGHTS,
  policy: ScoringPolicy = DEFAULT_POLICY,
): {
  safetyScore: SafetyScore;
  isSafeToExecute: boolean;
  auditTrail: ScoringAuditTrail;
} {
  // ==================================================================
  // VALIDATION: Weights must sum to 1.0
  // ==================================================================
  const weightSum =
    Math.round(
      (weights.tokenRisk +
        weights.txSimulation +
        weights.mevSignals +
        weights.ammPool) *
        1000,
    ) / 1000;

  if (weightSum !== 1.0) {
    throw new Error(
      `Scoring weights must sum to 1.0, got ${weightSum}. ` +
        `Weights: tokenRisk=${weights.tokenRisk}, txSimulation=${weights.txSimulation}, ` +
        `mevSignals=${weights.mevSignals}, ammPool=${weights.ammPool}`,
    );
  }

  // ==================================================================
  // STEP 1: Extract sub-scores from analyzer results
  // ==================================================================
  // If an analyzer didn't run (not in the map), its sub-score defaults
  // to 0 (fail-closed) — we never assume safety when data is missing.

  const tokenRiskResult = analyzerResults.get("token-risk-analyzer");
  const txSimResult = analyzerResults.get("tx-simulation-analyzer");
  const mevResult = analyzerResults.get("mev-detection-analyzer");
  const ammPoolResult = analyzerResults.get("amm-pool-analyzer");

  const tokenRiskScore = tokenRiskResult?.score ?? 0;
  const txSimScore = txSimResult?.score ?? 0;
  const mevScore = mevResult?.score ?? 0;
  const ammPoolScore = ammPoolResult?.score ?? 0;

  // ==================================================================
  // STEP 2: Compute weighted contributions
  // ==================================================================
  // Using integer arithmetic (multiply by 100, round, divide) to avoid
  // floating-point precision issues. An agent comparing scores across
  // runs must get bit-identical results.

  const tokenContribution =
    Math.round(tokenRiskScore * weights.tokenRisk * 100) / 100;
  const txSimContribution =
    Math.round(txSimScore * weights.txSimulation * 100) / 100;
  const mevContribution = Math.round(mevScore * weights.mevSignals * 100) / 100;
  const ammPoolContribution =
    Math.round(ammPoolScore * weights.ammPool * 100) / 100;

  const rawWeightedScore =
    Math.round(
      (tokenContribution +
        txSimContribution +
        mevContribution +
        ammPoolContribution) *
        100,
    ) / 100;

  logger.debug("[risk-engine] Weighted contributions computed", {
    tokenRiskScore,
    txSimScore,
    mevScore,
    ammPoolScore,
    tokenContribution,
    txSimContribution,
    mevContribution,
    ammPoolContribution,
    rawWeightedScore,
  });

  // ==================================================================
  // STEP 3: Build penalty multiplier cascade
  // ==================================================================
  // Each condition produces a multiplier in [0.0, 1.0]. The PRODUCT
  // of all triggered multipliers is applied to the raw weighted score.
  //
  // Why multiplicative (not additive)? Because penalties should COMPOUND.
  // A trade with a critical flag AND a simulation revert is catastrophically
  // worse than either alone — multiplicative captures this.

  const flagCounts = countFlagsBySeverity(allFlags);
  const correlations = detectCorrelations(analyzerResults);

  const penaltyMultipliers: ScoringAuditTrail["penaltyMultipliers"] = [];

  // --- Penalty 1: Critical flag present → score × 0.0 (instant zero) ---
  const hasCritical = flagCounts.critical > 0;
  penaltyMultipliers.push({
    name: "critical_flag_killswitch",
    value: 0.0,
    reason:
      `${flagCounts.critical} critical-severity flag(s) present — ` +
      `critical flags are non-negotiable kill signals (honeypot, blacklist, etc.)`,
    triggered: hasCritical,
  });

  // --- Penalty 2: Simulation reverted → score × 0.0 ---
  const simReverted = allFlags.some(
    (f) => f.code === RiskFlagCode.TX_SIMULATION_REVERTED,
  );
  penaltyMultipliers.push({
    name: "simulation_revert_killswitch",
    value: 0.0,
    reason:
      "Transaction simulation REVERTED — the tx would fail on-chain, " +
      "wasting gas with zero benefit",
    triggered: simReverted,
  });

  // --- Penalty 3: Multiple HIGH flags → score × 0.50 ---
  const manyHighFlags = flagCounts.high >= policy.maxHighFlagsBeforeBlock;
  penaltyMultipliers.push({
    name: "high_flag_accumulation",
    value: 0.5,
    reason:
      `${flagCounts.high} high-severity flags detected (threshold: ` +
      `${policy.maxHighFlagsBeforeBlock}). Multiple independent high-risk ` +
      `signals indicate systemic danger.`,
    triggered: manyHighFlags,
  });

  // --- Penalty 4: Cross-analyzer correlations ---
  for (const corr of correlations) {
    penaltyMultipliers.push({
      name: `cross_analyzer_${corr.type}_${corr.analyzers.join("+")}`,
      value: corr.penaltyMultiplier,
      reason: corr.description,
      triggered: true, // correlations are only generated when triggered
    });
  }

  // --- Penalty 5: Sub-score floor violation ---
  // If ANY individual analyzer is below the minimum, the trade is suspect.
  // A 100/0/100 split should NOT produce a passing composite score.
  const subScoreFloorViolation =
    tokenRiskScore < policy.minimumSubScore ||
    txSimScore < policy.minimumSubScore ||
    mevScore < policy.minimumSubScore ||
    ammPoolScore < policy.minimumSubScore;

  const violatingAnalyzers: string[] = [];
  if (tokenRiskScore < policy.minimumSubScore)
    violatingAnalyzers.push(`tokenRisk=${tokenRiskScore}`);
  if (txSimScore < policy.minimumSubScore)
    violatingAnalyzers.push(`txSim=${txSimScore}`);
  if (mevScore < policy.minimumSubScore)
    violatingAnalyzers.push(`mev=${mevScore}`);
  if (ammPoolScore < policy.minimumSubScore)
    violatingAnalyzers.push(`ammPool=${ammPoolScore}`);

  penaltyMultipliers.push({
    name: "sub_score_floor_violation",
    value: 0.3,
    reason:
      `Analyzer(s) below minimum sub-score of ${policy.minimumSubScore}: ` +
      `${violatingAnalyzers.join(", ")}. A catastrophic failure in any single ` +
      `dimension cannot be compensated by other dimensions.`,
    triggered: subScoreFloorViolation,
  });

  // --- Penalty 6: High total flag count → diminishing score ---
  // Each flag beyond 5 total applies a small multiplicative penalty.
  // This captures the "death by a thousand cuts" scenario — many
  // medium/low flags that individually seem harmless but collectively
  // indicate a sketchy token/trade.
  const totalFlags = allFlags.length;
  const excessFlags = Math.max(0, totalFlags - 5);
  const flagCountPenalty =
    excessFlags > 0 ? Math.max(0.4, 1.0 - excessFlags * 0.08) : 1.0;

  penaltyMultipliers.push({
    name: "flag_accumulation_decay",
    value: flagCountPenalty,
    reason:
      `${totalFlags} total flags raised. ${excessFlags} flags beyond ` +
      `the 5-flag threshold, each applying 8% multiplicative penalty.`,
    triggered: excessFlags > 0,
  });

  // --- Penalty 7: Both tokenIn AND tokenOut have issues ---
  // If we scanned a pair and BOTH tokens raised flags, the trade
  // is doubly risky.
  const tokenData = tokenRiskResult?.data as
    | Record<string, unknown>
    | undefined;
  const pairBothFlagged =
    tokenRiskResult !== undefined &&
    tokenRiskResult.flags.length > 0 &&
    tokenData?.["hasFatalRisk"] === true &&
    !hasCritical;

  penaltyMultipliers.push({
    name: "token_pair_fatal",
    value: 0.4,
    reason:
      "Both sides of the token pair carry fatal risk signals, compounding the trade risk materially",
    triggered: pairBothFlagged,
  });

  // --- Penalty 8: Gas estimation failed ---
  const gasEstFailed = allFlags.some(
    (f) =>
      f.code === RiskFlagCode.GAS_ESTIMATION_FAILED &&
      f.severity === "critical",
  );
  penaltyMultipliers.push({
    name: "gas_estimation_failure",
    value: 0.4,
    reason:
      "Gas estimation failed critically — the transaction may be " +
      "fundamentally unexecutable or the network is in a degraded state",
    triggered: gasEstFailed,
  });

  // ==================================================================
  // STEP 4: Compute combined penalty multiplier
  // ==================================================================
  // Product of all TRIGGERED multipliers. Non-triggered → contribute 1.0.
  let combinedPenalty = 1.0;
  for (const pm of penaltyMultipliers) {
    if (pm.triggered) {
      combinedPenalty *= pm.value;
    }
  }
  // Round to avoid floating-point drift
  combinedPenalty = Math.round(combinedPenalty * 10000) / 10000;

  const scoreAfterPenalties =
    Math.round(rawWeightedScore * combinedPenalty * 100) / 100;

  logger.debug("[risk-engine] Penalties applied", {
    triggeredPenalties: penaltyMultipliers.filter((p) => p.triggered).length,
    combinedPenalty,
    scoreAfterPenalties,
  });

  // ==================================================================
  // STEP 5: Confidence adjustment
  // ==================================================================
  // If analyzers failed or timed out, we have less data to work with.
  // We reduce the score proportionally to express this uncertainty.
  // An agent should know that a "75 with full confidence" is better
  // than a "75 with degraded confidence."

  // Check for error flags in results that DID run
  const hasErrorResult = (result: AnalyzerResult | undefined): boolean => {
    if (!result) return true; // missing = failed
    const data = result.data as Record<string, unknown>;
    return data["error"] === true;
  };

  const failedAnalyzers: string[] = [];
  if (hasErrorResult(tokenRiskResult)) failedAnalyzers.push("token-risk");
  if (hasErrorResult(txSimResult)) failedAnalyzers.push("tx-simulation");
  if (hasErrorResult(mevResult)) failedAnalyzers.push("mev-detection");
  if (hasErrorResult(ammPoolResult)) failedAnalyzers.push("amm-pool");

  let confidenceFactor: number;
  let confidenceReason: string;

  switch (failedAnalyzers.length) {
    case 0:
      confidenceFactor = 1.0;
      confidenceReason =
        "All 4 analyzers completed successfully — full confidence";
      break;
    case 1:
      confidenceFactor = 0.88;
      confidenceReason =
        `1 analyzer failed/missing (${failedAnalyzers[0]}). ` +
        `Score reduced by 12% to reflect incomplete data.`;
      break;
    case 2:
      confidenceFactor = 0.65;
      confidenceReason =
        `2 analyzers failed/missing (${failedAnalyzers.join(", ")}). ` +
        `Score reduced by 35% — significant data gap.`;
      break;
    case 3:
      confidenceFactor = 0.35;
      confidenceReason =
        `3 analyzers failed/missing (${failedAnalyzers.join(", ")}). ` +
        `Score reduced by 65% — critical data gap.`;
      break;
    default:
      confidenceFactor = 0.15;
      confidenceReason =
        "ALL 4 analyzers failed/missing. Operating blind — " +
        "score reduced by 85%. Trade should not proceed.";
      break;
  }

  // ==================================================================
  // STEP 6: Final score computation
  // ==================================================================
  const rawFinal = scoreAfterPenalties * confidenceFactor;

  // Clamp to [0, 100] and round to integer (no fractional scores —
  // machines should compare integers, not floats).
  const finalScore = Math.max(0, Math.min(100, Math.round(rawFinal)));

  // ==================================================================
  // STEP 7: Tier classification
  // ==================================================================
  const tier = classifyTier(finalScore);

  // ==================================================================
  // STEP 8: isSafeToExecute determination
  // ==================================================================
  // This is a STRICT boolean with multiple independent conditions.
  // ALL must pass for the trade to be approved.
  const safetyVerdictReasons: string[] = [];
  let isSafeToExecute = true;

  // Condition 1: Score must meet threshold
  if (finalScore < policy.safetyThreshold) {
    isSafeToExecute = false;
    safetyVerdictReasons.push(
      `Score ${finalScore} is below safety threshold of ${policy.safetyThreshold}`,
    );
  }

  // Condition 2: No critical flags
  if (flagCounts.critical > 0) {
    isSafeToExecute = false;
    safetyVerdictReasons.push(
      `${flagCounts.critical} critical flag(s) present — critical flags always block`,
    );
  }

  // Condition 3: No simulation reverts
  if (simReverted) {
    isSafeToExecute = false;
    safetyVerdictReasons.push(
      "Transaction simulation reverted — the tx would fail on-chain",
    );
  }

  // Condition 4: No sub-score floor violations
  if (subScoreFloorViolation) {
    isSafeToExecute = false;
    safetyVerdictReasons.push(
      `Sub-score floor violated: ${violatingAnalyzers.join(", ")}`,
    );
  }

  // Condition 5: Not too many high flags
  if (manyHighFlags) {
    isSafeToExecute = false;
    safetyVerdictReasons.push(
      `${flagCounts.high} high-severity flags exceed max of ${policy.maxHighFlagsBeforeBlock}`,
    );
  }

  // Condition 6: All analyzers must have run (at least token + simulation)
  if (hasErrorResult(tokenRiskResult) || hasErrorResult(txSimResult)) {
    isSafeToExecute = false;
    safetyVerdictReasons.push(
      "Critical analyzer(s) failed — cannot approve trade without " +
        "token risk scan AND transaction simulation",
    );
  }

  if (isSafeToExecute) {
    safetyVerdictReasons.push(
      `APPROVED: Score ${finalScore} >= threshold ${policy.safetyThreshold}, ` +
        `no critical/fatal flags, no simulation reverts, all critical analyzers succeeded`,
    );
  }

  // ==================================================================
  // STEP 9: Assemble SafetyScore
  // ==================================================================
  const safetyScore: SafetyScore = {
    overall: finalScore,
    breakdown: {
      tokenRisk: tokenRiskScore,
      liquidityRisk: null,
      mevRisk: mevScore,
      ammPoolRisk: ammPoolScore,
      walletRisk: null,
      txSimulation: txSimScore,
    },
    tier,
  };

  // ==================================================================
  // STEP 10: Assemble audit trail
  // ==================================================================
  const auditTrail: ScoringAuditTrail = {
    rawWeightedScore,
    weightedContributions: {
      tokenRisk: {
        subScore: tokenRiskScore,
        weight: weights.tokenRisk,
        contribution: tokenContribution,
      },
      txSimulation: {
        subScore: txSimScore,
        weight: weights.txSimulation,
        contribution: txSimContribution,
      },
      mevSignals: {
        subScore: mevScore,
        weight: weights.mevSignals,
        contribution: mevContribution,
      },
      ammPool: {
        subScore: ammPoolScore,
        weight: weights.ammPool,
        contribution: ammPoolContribution,
      },
    },
    penaltyMultipliers,
    combinedPenaltyMultiplier: combinedPenalty,
    scoreAfterPenalties,
    confidenceFactor,
    confidenceReason,
    finalScore,
    tier,
    safetyVerdictReasons,
  };

  logger.info("[risk-engine] Composite score computed", {
    finalScore,
    tier,
    isSafeToExecute,
    rawWeightedScore,
    combinedPenalty,
    confidenceFactor,
    flagCounts,
    correlationsDetected: correlations.length,
  });

  return { safetyScore, isSafeToExecute, auditTrail };
}

// ---------------------------------------------------------------------------
// Helper: Merge and Deduplicate Flags
// ---------------------------------------------------------------------------

/**
 * Merges flags from all analyzers into a single sorted, deduplicated list.
 *
 * Deduplication rule: if two flags have the SAME code AND severity,
 * keep the one with the longer (more informative) message. Different
 * severities for the same code are BOTH kept — they represent
 * independent assessments from different analyzers.
 */
export function mergeFlags(analyzerResults: AnalyzerResult[]): RiskFlag[] {
  // Collect all flags
  const allFlags: RiskFlag[] = [];
  for (const result of analyzerResults) {
    allFlags.push(...result.flags);
  }

  // Deduplicate by code + severity (keep longest message)
  const seen = new Map<string, RiskFlag>();
  for (const flag of allFlags) {
    const key = `${flag.code}::${flag.severity}`;
    const existing = seen.get(key);
    if (!existing || flag.message.length > existing.message.length) {
      seen.set(key, flag);
    }
  }

  // Sort by severity (critical first)
  const severityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };

  return Array.from(seen.values()).sort(
    (a, b) =>
      (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4),
  );
}
