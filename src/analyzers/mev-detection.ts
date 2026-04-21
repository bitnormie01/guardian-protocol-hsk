// ==========================================================================
// Guardian Protocol — Trade Impact & MEV Vulnerability Analyzer
// ==========================================================================
//
// This module analyzes a trade's vulnerability to MEV (Maximal Extractable
// Value) extraction by calculating dynamic slippage caps based on the
// trade's PRICE IMPACT against active pool liquidity, rather than relying
// on static USD thresholds.
//
// PHASE 2 UPGRADE — INSTITUTIONAL-GRADE LOGIC:
//   - Price Impact = tradeAmount / activeLiquidity (replaces USD thresholds)
//   - Dynamic Slippage Cap = 1.2 × priceImpact
//   - MEV_SANDWICH_RISK flagging when user slippage > 2× recommended
//   - Volatility Buffer (+0.5%) for thin-liquidity pools
//   - Hard BLOCK when priceImpact > 5%
//
// NOTE: This analyzer operates deterministically on available quote data
// and does NOT perform live mempool WebSocket scanning (which is unreliable
// for private flow detection). Instead, it focuses on hardening the tx
// execution parameters (slippage) to make extraction mathematically
// unprofitable for sandwich bots.
//
// ==========================================================================

import type { Address, HexString, SupportedChainId } from "../types/input.js";
import type { AnalyzerResult } from "../types/internal.js";
import type { RiskFlag, RiskSeverity } from "../types/output.js";
import { RiskFlagCode } from "../types/output.js";
import { GuardianError, ErrorCode } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MEVDetectionThresholds {
  highSlippageRiskBps: number;
  warningSlippageRiskBps: number;
}

const DEFAULT_THRESHOLDS: MEVDetectionThresholds = {
  highSlippageRiskBps: 500, // 5%
  warningSlippageRiskBps: 200, // 2%
};

// ---------------------------------------------------------------------------
// AMM Context (passed from AMM Pool Analyzer for cross-analyzer intelligence)
// ---------------------------------------------------------------------------

/**
 * Context from the AMM Pool Analyzer that enables institutional-grade
 * price impact calculations. When unavailable, the MEV analyzer falls
 * back to conservative trade-size heuristics.
 */
export interface AMMContextForMEV {
  /** Estimated USD liquidity depth around the active tick. */
  activeLiquidityUsd: number;
  /** Whether thin liquidity was detected by the AMM analyzer. */
  thinLiquidityDetected: boolean;
  /** Effective liquidity (raw) summed across nearest tick ranges. */
  effectiveLiquidity: string;
}

// ---------------------------------------------------------------------------
// Core Types
// ---------------------------------------------------------------------------

export interface DynamicSlippageCap {
  cappedSlippageBps: number;
  baseSlippageBps: number;
  tradeImpactAdjustment: number;
  priceImpact: number;
  recommendedSlippageBps: number;
  explanation: string;
}

export interface MEVDetectionReport {
  mevRiskLevel: "critical" | "high" | "medium" | "low" | "minimal";
  tradeImpactAssessment: "negligible" | "moderate" | "significant" | "extreme";
  dynamicSlippageCap: DynamicSlippageCap;
  priceImpactPercent: number;
  recommendMevProtection: boolean;
  volatilityBufferApplied: boolean;
  ammContextAvailable: boolean;
  flags: RiskFlag[];
  score: number;
  chainId: SupportedChainId;
}

function createFlag(
  code: RiskFlagCode,
  severity: RiskSeverity,
  message: string,
): RiskFlag {
  return { code, severity, message, source: "mev-detection-analyzer" };
}

// ---------------------------------------------------------------------------
// Price Impact Calculation (replaces hardcoded USD thresholds)
// ---------------------------------------------------------------------------

/**
 * Computes price impact as the ratio of trade size to available liquidity.
 *
 * Formula: priceImpact = tradeAmount / activeLiquidity
 *
 * This is a first-order approximation of concentrated liquidity price impact.
 * For exact calculation, you'd need the full liquidity curve — but this
 * gives us an order-of-magnitude risk signal that's far superior to
 * hardcoded USD thresholds like "$100" or "$1000".
 *
 * @param tradeAmountUsd      - The trade size in USD
 * @param activeLiquidityUsd  - The pool's active liquidity in USD (from AMM analyzer)
 * @returns Price impact as a ratio (0.01 = 1%)
 */
function calculatePriceImpact(
  tradeAmountUsd: number,
  activeLiquidityUsd: number,
): number {
  if (activeLiquidityUsd <= 0) {
    // No liquidity data — return a conservative high impact
    console.log(
      `[mev-detection] WARNING: activeLiquidityUsd is ${activeLiquidityUsd}. ` +
      `Cannot compute precise price impact. Using conservative estimate.`,
    );
    return tradeAmountUsd > 10_000 ? 0.10 : tradeAmountUsd > 1000 ? 0.03 : 0.01;
  }

  const impact = tradeAmountUsd / activeLiquidityUsd;

  console.log(
    `[mev-detection] Calculated Price Impact: ${(impact * 100).toFixed(4)}% ` +
    `(tradeAmount: $${tradeAmountUsd.toFixed(2)} / activeLiquidity: $${activeLiquidityUsd.toFixed(2)})`,
  );

  return impact;
}

// ---------------------------------------------------------------------------
// Dynamic Slippage Cap (based on Price Impact, not USD thresholds)
// ---------------------------------------------------------------------------

/**
 * Computes a dynamic slippage cap based on the calculated price impact.
 *
 * NEW LOGIC:
 *   recommendedSlippage = 1.2 × priceImpact
 *   cappedSlippage = min(baseSlippage, max(10bps, recommendedSlippageBps))
 *
 * The 1.2× multiplier gives a 20% buffer above the expected price impact,
 * which is tight enough to prevent sandwich attacks but loose enough to
 * avoid unnecessary rejections from normal market volatility.
 *
 * @param baseSlippageBps    - The user's/agent's proposed slippage in basis points
 * @param priceImpact        - Calculated price impact ratio (0.01 = 1%)
 * @param volatilityBuffer   - Additional buffer for thin liquidity pools (0.005 = 0.5%)
 */
function computeDynamicSlippageCap(
  baseSlippageBps: number,
  priceImpact: number,
  volatilityBuffer: number = 0,
): DynamicSlippageCap {
  // Recommended slippage = 1.2× price impact + volatility buffer
  const recommendedSlippage = 1.2 * priceImpact + volatilityBuffer;
  const recommendedSlippageBps = Math.max(10, Math.round(recommendedSlippage * 10_000));

  // Cap the slippage to the lower of user's setting or our recommendation
  const cappedSlippageBps = Math.max(10, Math.min(baseSlippageBps, recommendedSlippageBps));

  // How much tighter is the cap vs the original?
  const adjustment = baseSlippageBps > 0
    ? 1 - (cappedSlippageBps / baseSlippageBps)
    : 0;

  console.log(
    `[mev-detection] Dynamic Slippage Cap: ${cappedSlippageBps} bps ` +
    `(recommended: ${recommendedSlippageBps} bps, user: ${baseSlippageBps} bps, ` +
    `adjustment: ${(adjustment * 100).toFixed(1)}% tighter)`,
  );
  console.log(
    `[mev-detection] Formula: recommendedSlippage = 1.2 × ${(priceImpact * 100).toFixed(4)}% ` +
    `+ ${(volatilityBuffer * 100).toFixed(1)}% buffer = ${(recommendedSlippage * 100).toFixed(4)}%`,
  );

  return {
    cappedSlippageBps,
    baseSlippageBps,
    tradeImpactAdjustment: adjustment,
    priceImpact,
    recommendedSlippageBps,
    explanation:
      `Dynamic slippage cap computed from price impact. ` +
      `Price impact: ${(priceImpact * 100).toFixed(2)}%. ` +
      `Recommended: ${recommendedSlippageBps} bps (1.2× impact` +
      `${volatilityBuffer > 0 ? ` + ${(volatilityBuffer * 100).toFixed(1)}% thin-liquidity buffer` : ""}). ` +
      `User setting: ${baseSlippageBps} bps. ` +
      `Final cap: ${cappedSlippageBps} bps ` +
      `(${(adjustment * 100).toFixed(1)}% tighter than original).`,
  };
}

// ---------------------------------------------------------------------------
// Score Computation
// ---------------------------------------------------------------------------

function computeMEVScore(flags: RiskFlag[]): number {
  if (flags.some((f) => f.severity === "critical")) return 0;
  let score = 100;
  for (const flag of flags) {
    switch (flag.severity) {
      case "high":
        score -= 25;
        break;
      case "medium":
        score -= 15;
        break;
      case "low":
        score -= 5;
        break;
      case "info":
        score -= 2;
        break;
    }
  }
  return Math.max(0, Math.min(100, score));
}

// ---------------------------------------------------------------------------
// Main Export: analyzeMEVRisk()
// ---------------------------------------------------------------------------

/**
 * Analyzes a trade's vulnerability to MEV extraction using institutional-grade
 * price impact calculations.
 *
 * PHASE 2 UPGRADES:
 *   1. Price Impact = tradeAmount / activeLiquidity (replaces USD thresholds)
 *   2. Dynamic Slippage = 1.2 × priceImpact (data-driven, not heuristic)
 *   3. MEV_SANDWICH_RISK flag when slippage > 2× recommended
 *   4. Volatility Buffer (+0.5%) for thin-liquidity pools
 *   5. Hard BLOCK when priceImpact > 5% (catastrophic slippage)
 *
 * @param tokenIn         - Input token address
 * @param tokenOut        - Output token address
 * @param tradeAmountUsd  - Trade size in USD
 * @param userAddress     - The user's wallet address
 * @param proposedTxHex   - Optional proposed transaction hex
 * @param chainId         - HashKey Chain ID (default: 177)
 * @param thresholds      - Optional custom detection thresholds
 * @param baseSlippageBps - The user's slippage tolerance in basis points (default: 500)
 * @param ammContext      - Optional AMM context for cross-analyzer intelligence
 */
export async function analyzeMEVRisk(
  tokenIn: Address,
  tokenOut: Address,
  tradeAmountUsd: number,
  userAddress: Address,
  proposedTxHex: HexString | null = null,
  chainId: SupportedChainId = 177,
  thresholds: Partial<MEVDetectionThresholds> = {},
  baseSlippageBps: number = 500,
  ammContext?: AMMContextForMEV,
): Promise<AnalyzerResult> {
  const ANALYZER_NAME = "mev-detection-analyzer";
  const startTime = performance.now();
  const resolvedThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const flags: RiskFlag[] = [];

  logger.info(`[${ANALYZER_NAME}] Starting MEV vulnerability analysis`, {
    tokenIn,
    tokenOut,
    tradeAmountUsd,
    chainId,
    baseSlippageBps,
    ammContextAvailable: !!ammContext,
  });

  try {
    // ------------------------------------------------------------------
    // Step 1: Calculate Price Impact (replaces hardcoded USD thresholds)
    // ------------------------------------------------------------------
    const activeLiquidityUsd = ammContext?.activeLiquidityUsd ?? 0;
    const priceImpact = calculatePriceImpact(tradeAmountUsd, activeLiquidityUsd);
    const priceImpactPercent = priceImpact * 100;

    console.log(
      `[${ANALYZER_NAME}] Price Impact: ${priceImpactPercent.toFixed(4)}% ` +
      `(AMM context: ${ammContext ? "available" : "unavailable"})`,
    );

    // ------------------------------------------------------------------
    // Step 2: HARD BLOCK — Price Impact > 5% → BLOCK
    // If the trade's price impact exceeds 5%, the risk score MUST be
    // below 0.2 (score < 20 on 0–100 scale). We use score: 0 for
    // absolute fail-closed behavior.
    // ------------------------------------------------------------------
    if (priceImpact > 0.05) {
      console.log(
        `[${ANALYZER_NAME}] ⛔ HARD BLOCK: Price Impact ${priceImpactPercent.toFixed(2)}% ` +
        `exceeds 5% threshold. Setting score to 0 (BLOCK).`,
      );

      flags.push(
        createFlag(
          RiskFlagCode.HIGH_PRICE_IMPACT,
          "critical",
          `CRITICAL: Price impact is catastrophically high (${priceImpactPercent.toFixed(2)}%). ` +
          `Trade amount ($${tradeAmountUsd.toFixed(2)}) relative to active liquidity ` +
          `($${activeLiquidityUsd.toFixed(2)}) will cause extreme slippage. ` +
          `This trade is a guaranteed loss and a prime target for MEV extraction. ` +
          `Guardian BLOCKS trades with > 5% price impact.`,
        ),
      );

      // Even though we'll compute more flags below, the score is forced to 0
    }

    // ------------------------------------------------------------------
    // Step 3: Volatility Buffer for thin liquidity pools
    // If the AMM analyzer detected thin liquidity, add a 0.5% buffer
    // to the risk thresholds. This makes the MEV analyzer more
    // conservative when the pool lacks depth.
    // ------------------------------------------------------------------
    let volatilityBuffer = 0;
    const thinLiquidity = ammContext?.thinLiquidityDetected ?? false;

    if (thinLiquidity) {
      volatilityBuffer = 0.005; // 0.5%
      console.log(
        `[${ANALYZER_NAME}] Thin liquidity detected by AMM analyzer — ` +
        `adding 0.5% volatility buffer to risk thresholds`,
      );
    }

    // ------------------------------------------------------------------
    // Step 4: Compute Dynamic Slippage Cap (based on Price Impact)
    // Formula: recommendedSlippage = 1.2 × priceImpact + volatilityBuffer
    // ------------------------------------------------------------------
    const dynamicSlippageCap = computeDynamicSlippageCap(
      baseSlippageBps,
      priceImpact,
      volatilityBuffer,
    );

    // ------------------------------------------------------------------
    // Step 5: MEV_SANDWICH_RISK Detection
    // If the user's slippageTolerance is > 2× the recommendedSlippage,
    // the agent is "over-paying" and inviting front-runners.
    // ------------------------------------------------------------------
    const userSlippageRatio = baseSlippageBps / 10_000; // Convert bps to ratio
    const recommendedSlippage = (1.2 * priceImpact) + volatilityBuffer;

    if (recommendedSlippage > 0 && userSlippageRatio > 2 * recommendedSlippage) {
      const overpayRatio = (userSlippageRatio / recommendedSlippage).toFixed(1);

      console.log(
        `[${ANALYZER_NAME}] ⚠️ MEV_SANDWICH_RISK: User slippage ` +
        `(${(userSlippageRatio * 100).toFixed(2)}%) is ${overpayRatio}× the ` +
        `recommended slippage (${(recommendedSlippage * 100).toFixed(2)}%). ` +
        `This over-payment invites sandwich attacks.`,
      );

      flags.push(
        createFlag(
          RiskFlagCode.MEV_SANDWICH_RISK,
          "high",
          `MEV Sandwich Risk: Slippage tolerance (${baseSlippageBps} bps / ` +
          `${(userSlippageRatio * 100).toFixed(2)}%) is ${overpayRatio}× higher ` +
          `than the recommended slippage (${dynamicSlippageCap.recommendedSlippageBps} bps / ` +
          `${(recommendedSlippage * 100).toFixed(2)}%). ` +
          `The excess slippage tolerance creates a profitable window for MEV bots ` +
          `to sandwich this transaction. The front-runner's profit is approximately ` +
          `${((userSlippageRatio - recommendedSlippage) * tradeAmountUsd).toFixed(2)} USD. ` +
          `Recommended: Tighten slippage to ${dynamicSlippageCap.recommendedSlippageBps} bps ` +
          `or use a private transaction relay.`,
        ),
      );
    }

    // ------------------------------------------------------------------
    // Step 6: Standard slippage risk assessment (with volatility buffer)
    // Apply the volatility buffer to the slippage risk thresholds.
    // ------------------------------------------------------------------
    const adjustedHighThreshold = resolvedThresholds.highSlippageRiskBps +
      Math.round(volatilityBuffer * 10_000);
    const adjustedWarningThreshold = resolvedThresholds.warningSlippageRiskBps +
      Math.round(volatilityBuffer * 10_000);

    if (dynamicSlippageCap.cappedSlippageBps > adjustedHighThreshold) {
      flags.push(
        createFlag(
          RiskFlagCode.FRONTRUN_RISK_HIGH,
          "high",
          `Slippage tolerance is extremely high (${dynamicSlippageCap.cappedSlippageBps} bps, ` +
          `threshold: ${adjustedHighThreshold} bps` +
          `${volatilityBuffer > 0 ? ` including ${(volatilityBuffer * 100).toFixed(1)}% thin-liquidity buffer` : ""}). ` +
          `This makes the trade a highly profitable target for MEV sandwich attacks. ` +
          `Price impact: ${priceImpactPercent.toFixed(2)}%.`,
        ),
      );
    } else if (dynamicSlippageCap.cappedSlippageBps > adjustedWarningThreshold) {
      flags.push(
        createFlag(
          RiskFlagCode.FRONTRUN_RISK_HIGH,
          "medium",
          `Slippage tolerance is elevated (${dynamicSlippageCap.cappedSlippageBps} bps, ` +
          `threshold: ${adjustedWarningThreshold} bps` +
          `${volatilityBuffer > 0 ? ` including ${(volatilityBuffer * 100).toFixed(1)}% thin-liquidity buffer` : ""}). ` +
          `Moderate risk of MEV extraction. ` +
          `Price impact: ${priceImpactPercent.toFixed(2)}%.`,
        ),
      );
    }

    if (dynamicSlippageCap.tradeImpactAdjustment > 0) {
      logger.info(`[${ANALYZER_NAME}] ${dynamicSlippageCap.explanation}`);
    }

    // ------------------------------------------------------------------
    // Step 7: Trade impact assessment (based on price impact, not USD)
    // ------------------------------------------------------------------
    let tradeImpactAssessment: MEVDetectionReport["tradeImpactAssessment"];
    if (priceImpact > 0.05) tradeImpactAssessment = "extreme";
    else if (priceImpact > 0.02) tradeImpactAssessment = "significant";
    else if (priceImpact > 0.005) tradeImpactAssessment = "moderate";
    else tradeImpactAssessment = "negligible";

    console.log(
      `[${ANALYZER_NAME}] Trade Impact Assessment: ${tradeImpactAssessment} ` +
      `(priceImpact=${priceImpactPercent.toFixed(4)}%)`,
    );

    // ------------------------------------------------------------------
    // Step 8: Compute final score
    // ------------------------------------------------------------------
    let score = computeMEVScore(flags);

    // ENFORCE: priceImpact > 5% → score MUST be below 20 (0.2 normalized)
    if (priceImpact > 0.05 && score > 0) {
      console.log(
        `[${ANALYZER_NAME}] Enforcing hard block: score ${score} → 0 (priceImpact > 5%)`,
      );
      score = 0;
    }

    let mevRiskLevel: MEVDetectionReport["mevRiskLevel"];
    if (score <= 10) mevRiskLevel = "critical";
    else if (score <= 30) mevRiskLevel = "high";
    else if (score <= 60) mevRiskLevel = "medium";
    else if (score <= 85) mevRiskLevel = "low";
    else mevRiskLevel = "minimal";

    const durationMs = Math.round(performance.now() - startTime);

    const report: MEVDetectionReport = {
      mevRiskLevel,
      tradeImpactAssessment,
      dynamicSlippageCap,
      priceImpactPercent,
      recommendMevProtection: score < 70,
      volatilityBufferApplied: volatilityBuffer > 0,
      ammContextAvailable: !!ammContext,
      flags,
      score,
      chainId,
    };

    logger.info(`[${ANALYZER_NAME}] ✅ MEV analysis complete: ${mevRiskLevel}`, {
      score,
      priceImpactPercent: priceImpactPercent.toFixed(4),
      dynamicSlippageBps: dynamicSlippageCap.cappedSlippageBps,
      recommendedSlippageBps: dynamicSlippageCap.recommendedSlippageBps,
      volatilityBufferApplied: volatilityBuffer > 0,
      ammContextAvailable: !!ammContext,
      durationMs,
    });

    return {
      analyzerName: ANALYZER_NAME,
      flags,
      score,
      durationMs,
      data: report as unknown as Record<string, unknown>,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - startTime);
    const errorMessage = err instanceof Error ? err.message : String(err);

    logger.error(`[${ANALYZER_NAME}] ❌ MEV analysis FAILED — FAILING CLOSED (score: 0, BLOCK)`, {
      error: errorMessage,
      durationMs,
    });

    console.log(
      `[${ANALYZER_NAME}] ⛔ FAIL-CLOSED: MEV analysis error. ` +
      `Error: ${errorMessage}. Returning score: 0 (BLOCK).`,
    );

    // FAIL-CLOSED: Every catch block returns score: 0 and BLOCK.
    return {
      analyzerName: ANALYZER_NAME,
      flags: [
        createFlag(
          RiskFlagCode.FRONTRUN_RISK_HIGH,
          "critical",
          `FAIL-CLOSED: MEV analysis failed: ${errorMessage}. ` +
          `Guardian cannot verify MEV safety — BLOCKING trade. ` +
          `The trade may be safe, but conditions are unverified.`,
        ),
      ],
      score: 0,
      durationMs,
      data: {
        error: true,
        errorMessage,
        recommendMevProtection: true,
        failClosedReason: "analyzer_error",
      },
    };
  }
}