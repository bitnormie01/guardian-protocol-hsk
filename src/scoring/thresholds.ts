// ==========================================================================
// Guardian Protocol — Configurable Risk Thresholds & Policies
// ==========================================================================

import type { ScoringWeights, ScoringPolicy } from "./risk-engine.js";
import type { TokenRiskThresholds } from "../analyzers/token-risk.js";
import type { SimulationThresholds } from "../analyzers/tx-simulation.js";
import type { MEVDetectionThresholds } from "../analyzers/mev-detection.js";
import type { AMMPoolAnalyzerConfig } from "../analyzers/amm-pool-analyzer.js";

export interface GuardianConfig {
  scoringWeights: ScoringWeights;
  scoringPolicy: ScoringPolicy;
  tokenRisk: Partial<TokenRiskThresholds>;
  txSimulation: Partial<SimulationThresholds>;
  mevDetection: Partial<MEVDetectionThresholds>;
  ammPool: Partial<AMMPoolAnalyzerConfig>;
  version: string;
}

export const DEFAULT_GUARDIAN_CONFIG: GuardianConfig = {
  scoringWeights: {
    tokenRisk: 0.3,
    txSimulation: 0.3,
    mevSignals: 0.15,
    ammPool: 0.25,
  },
  scoringPolicy: {
    safetyThreshold: Number(process.env["GUARDIAN_SAFETY_THRESHOLD"] ?? "70"),
    minimumSubScore: 20,
    maxHighFlagsBeforeBlock: 3,
  },
  tokenRisk: {
    buyTaxWarningPercent: 10,
    buyTaxDangerPercent: 30,
    sellTaxWarningPercent: 10,
    sellTaxDangerPercent: 30,
    minHolderCount: 50,
  },
  txSimulation: {
    maxSlippageBps: Number(process.env["GUARDIAN_MAX_SLIPPAGE_BPS"] ?? "500"),
    slippageWarningBps: 200,
    maxGasCostOKB: 0.1,
    simulationTimeoutMs: Number(
      process.env["GUARDIAN_TX_SIMULATION_TIMEOUT_MS"] ?? "10000",
    ),
  },
  mevDetection: {
    highSlippageRiskBps: 500,
    warningSlippageRiskBps: 200,
  },
  ammPool: {
    minLiquidityDepthUsd: 10_000,
    maxTickGapMultiplier: 20,
    maxPriceDeviationRatio: 0.05,
    liquidityAsymmetryThreshold: 5.0,
    tickScanRange: 20,
  },
  version: "0.2.1",
};

export function createConfig(
  overrides: Partial<GuardianConfig> = {},
): GuardianConfig {
  return {
    scoringWeights: {
      ...DEFAULT_GUARDIAN_CONFIG.scoringWeights,
      ...overrides.scoringWeights,
    },
    scoringPolicy: {
      ...DEFAULT_GUARDIAN_CONFIG.scoringPolicy,
      ...overrides.scoringPolicy,
    },
    tokenRisk: { ...DEFAULT_GUARDIAN_CONFIG.tokenRisk, ...overrides.tokenRisk },
    txSimulation: {
      ...DEFAULT_GUARDIAN_CONFIG.txSimulation,
      ...overrides.txSimulation,
    },
    mevDetection: {
      ...DEFAULT_GUARDIAN_CONFIG.mevDetection,
      ...overrides.mevDetection,
    },
    ammPool: { ...DEFAULT_GUARDIAN_CONFIG.ammPool, ...overrides.ammPool },
    version: overrides.version ?? DEFAULT_GUARDIAN_CONFIG.version,
  };
}
