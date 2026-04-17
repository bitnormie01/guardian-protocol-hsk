// ==========================================================================
// Guardian Protocol — Trade Impact & MEV Vulnerability Analyzer
// ==========================================================================
//
// This module analyzes a trade's vulnerability to MEV (Maximal Extractable
// Value) extraction by calculating dynamic slippage caps based on the
// trade's size and inherent volatility heuristics, rather than relying on
// static agent configurations.
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
// Core Types
// ---------------------------------------------------------------------------

export interface DynamicSlippageCap {
  cappedSlippageBps: number;
  baseSlippageBps: number;
  tradeImpactAdjustment: number;
  explanation: string;
}

export interface MEVDetectionReport {
  mevRiskLevel: "critical" | "high" | "medium" | "low" | "minimal";
  tradeImpactAssessment: "negligible" | "moderate" | "significant" | "extreme";
  dynamicSlippageCap: DynamicSlippageCap;
  recommendMevProtection: boolean;
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

function computeDynamicSlippageCap(
  baseSlippageBps: number,
  tradeAmountUsd: number,
): DynamicSlippageCap {
  // Simple heuristic: Larger trades require tighter slippage to prevent extraction
  // A $10,000 trade gets a tighter cap than a $10 trade.
  let adjustment = 0;
  if (tradeAmountUsd > 10000) {
    adjustment = 0.5; // 50% tighter
  } else if (tradeAmountUsd > 1000) {
    adjustment = 0.25; // 25% tighter
  } else if (tradeAmountUsd > 100) {
    adjustment = 0.1; // 10% tighter
  }

  const cappedSlippageBps = Math.max(10, Math.round(baseSlippageBps * (1 - adjustment)));

  return {
    cappedSlippageBps,
    baseSlippageBps,
    tradeImpactAdjustment: adjustment,
    explanation: `Dynamic slippage tightened by ${adjustment * 100}% due to trade size ($${tradeAmountUsd.toFixed(2)}). New cap: ${cappedSlippageBps} bps.`,
  };
}

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

export async function analyzeMEVRisk(
  tokenIn: Address,
  tokenOut: Address,
  tradeAmountUsd: number,
  userAddress: Address,
  proposedTxHex: HexString | null = null,
  chainId: SupportedChainId = 177,
  thresholds: Partial<MEVDetectionThresholds> = {},
  baseSlippageBps: number = 500,
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
  });

  try {
    const dynamicSlippageCap = computeDynamicSlippageCap(baseSlippageBps, tradeAmountUsd);

    if (dynamicSlippageCap.cappedSlippageBps > resolvedThresholds.highSlippageRiskBps) {
      flags.push(
        createFlag(
          RiskFlagCode.FRONTRUN_RISK_HIGH,
          "high",
          `Slippage tolerance is extremely high (${dynamicSlippageCap.cappedSlippageBps} bps). This makes the trade a highly profitable target for MEV sandwich attacks.`,
        ),
      );
    } else if (dynamicSlippageCap.cappedSlippageBps > resolvedThresholds.warningSlippageRiskBps) {
      flags.push(
        createFlag(
          RiskFlagCode.FRONTRUN_RISK_HIGH,
          "medium",
          `Slippage tolerance is elevated (${dynamicSlippageCap.cappedSlippageBps} bps). Moderate risk of MEV extraction.`,
        ),
      );
    }

    if (dynamicSlippageCap.tradeImpactAdjustment > 0) {
        logger.info(`[${ANALYZER_NAME}] ${dynamicSlippageCap.explanation}`);
    }

    let tradeImpactAssessment: MEVDetectionReport["tradeImpactAssessment"] = "negligible";
    if (tradeAmountUsd > 10000) tradeImpactAssessment = "extreme";
    else if (tradeAmountUsd > 1000) tradeImpactAssessment = "significant";
    else if (tradeAmountUsd > 100) tradeImpactAssessment = "moderate";

    const score = computeMEVScore(flags);

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
      recommendMevProtection: score < 70,
      flags,
      score,
      chainId,
    };

    logger.info(`[${ANALYZER_NAME}] ✅ MEV analysis complete: ${mevRiskLevel}`, {
      score,
      dynamicSlippageBps: dynamicSlippageCap.cappedSlippageBps,
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

    logger.error(`[${ANALYZER_NAME}] ❌ MEV analysis FAILED — FAILING CLOSED`, {
      error: errorMessage,
      durationMs,
    });

    return {
      analyzerName: ANALYZER_NAME,
      flags: [createFlag(RiskFlagCode.FRONTRUN_RISK_HIGH, "high", errorMessage)],
      score: 20,
      durationMs,
      data: { error: true, errorMessage, recommendMevProtection: true },
    };
  }
}