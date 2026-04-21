// ==========================================================================
// Guardian Protocol — Main Orchestrator (Skill Entry Point)
// ==========================================================================
//
// This is the TOP-LEVEL entry point that a calling agent invokes.
// It wires together every module built in Phases 1–5:
//
//   Phase 1: Types & schemas       → input validation, output shaping
//   Phase 2: Token risk analyzer   → scans token contracts
//   Phase 3: TX simulation         → dry-runs the proposed transaction
//   Phase 4: MEV detection         → checks mempool & volatility
//   Phase 4.5: AMM pool analyzer   → concentrated liquidity risk (Phase 2)
//   Phase 5: Risk scoring engine   → aggregates into final verdict
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │                    ORCHESTRATOR PIPELINE                             │
// │                                                                     │
// │  Agent Input (GuardianEvaluationRequest)                            │
// │       │                                                             │
// │       ▼                                                             │
// │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐   │
// │  │ Token Risk  │ │ TX Simul.  │ │ MEV Detect │ │ AMM Pool   │ ← PARALLEL │
// │  │ Analyzer    │ │ Analyzer   │ │ Analyzer   │ │ Analyzer   │   │
// │  └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └─────┬──────┘   │
// │        │              │              │              │           │
// │        └──────────┬───┘──────────────┘──────────────┘           │
// │                     │                                              │
// │                     ▼                                              │
// │          ┌─────────────────────┐                                   │
// │          │  Risk Scoring Engine │                                   │
// │          │  (Phase 5)          │                                    │
// │          └──────────┬──────────┘                                   │
// │                     │                                              │
// │                     ▼                                              │
// │          ┌─────────────────────┐                                   │
// │          │ GuardianEvaluation  │                                    │
// │          │ Response            │                                    │
// │          └─────────────────────┘                                   │
// │                                                                     │
// │  → Deterministic JSON output for the calling agent                  │
// └──────────────────────────────────────────────────────────────────────┘
//
// PERFORMANCE:
//   All three analyzers run IN PARALLEL via Promise.allSettled().
//   A typical evaluation completes in 500–2000ms depending on
//   HashKey Chain RPC and GoPlus API latency.
//
// FAULT TOLERANCE:
//   Individual analyzer failures are caught and recorded. The scoring
//   engine adjusts confidence based on how many analyzers succeeded.
//   The pipeline NEVER crashes — it always produces a response.
//
// ==========================================================================

import { v4 as uuidv4 } from "uuid";

// --- Types (Phase 1) ---
import type {
  GuardianEvaluationRequest,
  TokenScanRequest,
  TxSimulationRequest,
  Address,
  HexString,
  SupportedChainId,
} from "./types/input.js";
import type {
  GuardianEvaluationResponse,
  TokenScanResponse,
  TxSimulationResponse,
  SafetyScore,
  RiskFlag,
} from "./types/output.js";
import { RiskFlagCode } from "./types/output.js";
import type { AnalyzerResult } from "./types/internal.js";

// --- Analyzers (Phases 2–4) ---
import {
  analyzeTokenRisk,
  analyzeTokenPairRisk,
} from "./analyzers/token-risk.js";
import { simulateTransaction } from "./analyzers/tx-simulation.js";
import { analyzeMEVRisk, type AMMContextForMEV } from "./analyzers/mev-detection.js";
import { analyzeAMMPoolRisk } from "./analyzers/amm-pool-analyzer.js";
import { resolveTradeContext } from "./services/trade-context.js";

// --- Scoring Engine (Phase 5) ---
import { computeCompositeScore, mergeFlags } from "./scoring/risk-engine.js";

// --- Config ---
import { createConfig, type GuardianConfig } from "./scoring/thresholds.js";

// --- Utilities ---
import { logger } from "./utils/logger.js";
import { GuardianError, ErrorCode } from "./utils/errors.js";

// ---------------------------------------------------------------------------
// Helper: Wrap Analyzer Execution with Timeout + Error Capture
// ---------------------------------------------------------------------------

/**
 * Executes an analyzer function with error capture.
 * Returns a tuple of [result | null, error | null].
 *
 * This ensures a single analyzer failure NEVER crashes the pipeline.
 * The scoring engine handles null results via confidence adjustment.
 */
async function runAnalyzer(
  name: string,
  fn: () => Promise<AnalyzerResult>,
): Promise<AnalyzerResult> {
  const startTime = performance.now();

  try {
    const result = await fn();
    logger.info(`[orchestrator] Analyzer ${name} completed`, {
      score: result.score,
      flagCount: result.flags.length,
      durationMs: result.durationMs,
    });
    return result;
  } catch (err) {
    const durationMs = Math.round(performance.now() - startTime);
    const errorMessage = err instanceof Error ? err.message : String(err);

    logger.error(`[orchestrator] Analyzer ${name} FAILED`, {
      error: errorMessage,
      durationMs,
    });

    // Return a synthetic "failed" result so the scoring engine
    // can account for this in its confidence calculation.
    return {
      analyzerName: name,
      flags: [],
      score: 0,
      durationMs,
      data: {
        error: true,
        errorCode:
          err instanceof GuardianError ? err.code : ErrorCode.ANALYZER_ERROR,
        errorMessage,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Main Export: evaluateTrade()
// ---------------------------------------------------------------------------

/**
 * The primary entry point for the Guardian Protocol skill.
 *
 * A calling agent sends a `GuardianEvaluationRequest` and receives
 * back a `GuardianEvaluationResponse` containing:
 *   - SafetyScore (0–100 with breakdown and tier)
 *   - isSafeToExecute (boolean verdict)
 *   - flags (all risk flags, sorted by severity)
 *   - optimizedRouting (null in this phase — Phase 6)
 *   - meta (audit trail, timing, analyzer statuses)
 *
 * This function is DETERMINISTIC given identical chain state.
 * No randomness, no ambient state, no side effects beyond logging.
 *
 * @param request  - The agent's trade evaluation request
 * @param config   - Optional custom Guardian configuration
 */
export async function evaluateTrade(
  request: GuardianEvaluationRequest,
  config?: Partial<GuardianConfig>,
): Promise<GuardianEvaluationResponse> {
  const evaluationId = uuidv4();
  const pipelineStart = performance.now();
  const resolvedConfig = createConfig(config);
  const chainId: SupportedChainId = request.chainId ?? 177;

  logger.info("[orchestrator] ═══════════════════════════════════════════");
  logger.info("[orchestrator] Guardian Protocol evaluation STARTED", {
    evaluationId,
    tokenIn: request.tokenIn,
    tokenOut: request.tokenOut,
    amountRaw: request.amountRaw ?? request.amount,
    userAddress: request.userAddress,
    hasProposedTx: !!request.proposedTxHex,
    chainId,
    callerAgentId: request.callerAgentId ?? "anonymous",
  });

  let resolvedTradeContext;
  try {
    resolvedTradeContext = await resolveTradeContext(
      request,
      chainId,
      request.maxSlippageBps ??
        resolvedConfig.txSimulation.maxSlippageBps ??
        500,
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("[orchestrator] Trade context resolution failed", {
      evaluationId,
      error: errorMsg,
    });

    const blockResponse: GuardianEvaluationResponse = {
      evaluationId,
      timestamp: new Date().toISOString(),
      chainId,
      safetyScore: {
        overall: 0,
        breakdown: {
          tokenRisk: 0,
          liquidityRisk: null,
          mevRisk: 0,
          ammPoolRisk: 0,
          walletRisk: null,
          txSimulation: 0,
        },
        tier: "CRITICAL",
      },
      isSafeToExecute: false,
      flags: [
        {
          code: RiskFlagCode.API_UNAVAILABLE,
          severity: "critical",
          message:
            "Trade context resolution failed — RPC unavailable or tokens " +
            "unreadable. Fail-closed by design.",
          source: "orchestrator",
        },
      ],
      optimizedRouting: null,
      meta: {
        guardianVersion: resolvedConfig.version,
        evaluationDurationMs: Math.round(performance.now() - pipelineStart),
        analyzersRun: [],
        tradeContext: {
          amountRaw: request.amountRaw ?? request.amount ?? "0",
          tokenInDecimals: request.tokenInDecimals ?? 18,
          tokenOutDecimals: request.tokenOutDecimals ?? 18,
          estimatedTradeUsd: 0,
          poolAddress: null,
          contextSource: "fallback",
          hasQuoteData: false,
        },
      },
    };

    logger.info(
      "[orchestrator] ⛔ VERDICT: BLOCKED — Score: 0/100 (CRITICAL)",
      {
        evaluationId,
        reason: "Trade context resolution failed",
      },
    );

    return blockResponse;
  }

  logger.info("[orchestrator] Trade context resolved", {
    amountRaw: resolvedTradeContext.amountRaw,
    tokenInDecimals: resolvedTradeContext.tokenInDecimals,
    tokenOutDecimals: resolvedTradeContext.tokenOutDecimals,
    estimatedTradeUsd: resolvedTradeContext.estimatedTradeUsd,
    poolAddress: resolvedTradeContext.poolAddress,
    contextSource: resolvedTradeContext.contextSource,
    hasQuoteData: resolvedTradeContext.hasQuoteData,
  });

  // ==================================================================
  // STAGE 1a: Run AMM Pool Analyzer FIRST
  // ==================================================================
  // The AMM analyzer runs first so its output (active liquidity, thin
  // liquidity detection) can be passed to the MEV analyzer for accurate
  // price impact calculations. This replaces the old parallel execution
  // which prevented cross-analyzer intelligence.

  const ammPoolResult = await runAnalyzer("amm-pool-analyzer", async () => {
    return await analyzeAMMPoolRisk(
      resolvedTradeContext.poolAddress,
      resolvedTradeContext.estimatedTradeUsd,
      request.tokenIn,
      request.tokenOut,
      chainId,
      resolvedConfig.ammPool,
    );
  });

  // Extract AMM context for the MEV analyzer (cross-analyzer intelligence)
  const ammData = ammPoolResult.data as Record<string, unknown>;
  const ammContextForMEV: AMMContextForMEV | undefined =
    ammData?.error !== true
      ? {
          activeLiquidityUsd:
            (ammData?.estimatedLiquidityDepthUsd as number) ?? 0,
          thinLiquidityDetected:
            (ammData?.thinLiquidityDetected as boolean) ?? false,
          effectiveLiquidity:
            (ammData?.effectiveLiquidity as string) ?? "0",
        }
      : undefined;

  logger.info("[orchestrator] AMM context extracted for MEV analyzer", {
    ammContextAvailable: !!ammContextForMEV,
    activeLiquidityUsd: ammContextForMEV?.activeLiquidityUsd ?? "N/A",
    thinLiquidityDetected: ammContextForMEV?.thinLiquidityDetected ?? "N/A",
  });

  // ==================================================================
  // STAGE 1b: Run remaining analyzers IN PARALLEL
  // ==================================================================
  // Token risk, TX simulation, and MEV detection run in parallel.
  // MEV detection now receives AMM context for price impact calculations.

  const [tokenRiskResult, txSimResult, mevResult] =
    await Promise.all([
      // ---- Analyzer 1: Token Risk (Phase 2) ----
      // Scans BOTH tokenIn and tokenOut in parallel.
      runAnalyzer("token-risk-analyzer", async () => {
        const [tokenInResult, tokenOutResult] = await analyzeTokenPairRisk(
          request.tokenIn,
          request.tokenOut,
          chainId,
          resolvedConfig.tokenRisk,
        );

        const result: AnalyzerResult = {
          ...tokenOutResult,
          flags: [...tokenOutResult.flags],
        };

        if (tokenInResult.score === 0) {
          const propagatedFlags = tokenInResult.flags
            .filter((f) => f.severity === "critical" || f.severity === "high")
            .map((f) => ({
              ...f,
              message: `[tokenIn] ${f.message}`,
            }));
          result.flags.push(...propagatedFlags);
          result.score = 0;
        }

        return result;
      }),

      // ---- Analyzer 2: Transaction Simulation (Phase 3) ----
      // Only runs if proposedTxHex is provided. Otherwise returns
      // a "not applicable" result.
      runAnalyzer("tx-simulation-analyzer", async () => {
        if (!request.proposedTxHex) {
          logger.info(
            "[orchestrator] No proposedTxHex — skipping simulation, " +
            "returning neutral score",
          );
          return {
            analyzerName: "tx-simulation-analyzer",
            flags: [],
            score: 75, // Neutral — no tx to simulate isn't inherently bad
            durationMs: 0,
            data: {
              skipped: true,
              reason: "No proposedTxHex provided in request",
              simulationSuccess: true,
            },
          };
        }

        // Determine expected output for slippage calculation.
        // If the agent provided maxSlippageBps, we use that context.
        // Otherwise, we pass null and simulation will skip slippage calc.
        return await simulateTransaction(
          request.proposedTxHex,
          request.userAddress,
          resolvedTradeContext.targetAddress ??
          (() => {
            throw new GuardianError(
              ErrorCode.ANALYZER_ERROR,
              "proposedTxHex requires proposedTxTarget or quoteContext.routerAddress for accurate simulation",
            );
          })(),
          request.tokenOut,
          resolvedTradeContext.expectedOutputRaw,
          resolvedTradeContext.tokenOutDecimals,
          chainId,
          "0",
          resolvedConfig.txSimulation,
        );
      }),

      // ---- Analyzer 3: MEV / Off-Chain Signals (Phase 4) ----
      // Now receives AMM context for institutional-grade price impact.
      runAnalyzer("mev-detection-analyzer", async () => {
        return await analyzeMEVRisk(
          request.tokenIn,
          request.tokenOut,
          resolvedTradeContext.estimatedTradeUsd,
          request.userAddress,
          request.proposedTxHex ?? null,
          chainId,
          resolvedConfig.mevDetection,
          request.maxSlippageBps ?? 500,
          ammContextForMEV,
        );
      }),
    ]);

  // ==================================================================
  // STAGE 2: Merge flags from all analyzers
  // ==================================================================
  const allAnalyzerResults = [
    tokenRiskResult,
    txSimResult,
    mevResult,
    ammPoolResult,
  ];
  const mergedFlags = mergeFlags(allAnalyzerResults);

  logger.info("[orchestrator] All analyzers complete, flags merged", {
    tokenRiskScore: tokenRiskResult.score,
    txSimScore: txSimResult.score,
    mevScore: mevResult.score,
    ammPoolScore: ammPoolResult.score,
    totalFlags: mergedFlags.length,
  });

  // ==================================================================
  // STAGE 3: Run the scoring engine (Phase 5)
  // ==================================================================
  const analyzerResultsMap = new Map<string, AnalyzerResult>();
  analyzerResultsMap.set("token-risk-analyzer", tokenRiskResult);
  analyzerResultsMap.set("tx-simulation-analyzer", txSimResult);
  analyzerResultsMap.set("mev-detection-analyzer", mevResult);
  analyzerResultsMap.set("amm-pool-analyzer", ammPoolResult);

  const { safetyScore, isSafeToExecute, auditTrail } = computeCompositeScore(
    analyzerResultsMap,
    mergedFlags,
    resolvedConfig.scoringWeights,
    resolvedConfig.scoringPolicy,
  );

  // ==================================================================
  // STAGE 4: Assemble the final response
  // ==================================================================
  const totalDurationMs = Math.round(performance.now() - pipelineStart);

  const response: GuardianEvaluationResponse = {
    evaluationId,
    timestamp: new Date().toISOString(),
    chainId,

    safetyScore,
    isSafeToExecute,
    flags: mergedFlags,

    optimizedRouting: resolvedTradeContext.optimizedRouting,

    meta: {
      guardianVersion: resolvedConfig.version,
      evaluationDurationMs: totalDurationMs,
      analyzersRun: allAnalyzerResults.map((r) => ({
        name: r.analyzerName,
        durationMs: r.durationMs,
        status:
          (r.data as Record<string, unknown>)["error"] === true
            ? ("error" as const)
            : ("success" as const),
      })),
      tradeContext: {
        amountRaw: resolvedTradeContext.amountRaw,
        tokenInDecimals: resolvedTradeContext.tokenInDecimals,
        tokenOutDecimals: resolvedTradeContext.tokenOutDecimals,
        estimatedTradeUsd: resolvedTradeContext.estimatedTradeUsd,
        poolAddress: resolvedTradeContext.poolAddress,
        contextSource: resolvedTradeContext.contextSource,
        hasQuoteData: resolvedTradeContext.hasQuoteData,
      },
    },
  };

  // ==================================================================
  // STAGE 5: Log the final verdict
  // ==================================================================
  const verdictEmoji = isSafeToExecute ? "✅" : "⛔";
  const verdictWord = isSafeToExecute ? "APPROVED" : "BLOCKED";

  logger.info(
    `[orchestrator] ${verdictEmoji} VERDICT: ${verdictWord} — ` +
    `Score: ${safetyScore.overall}/100 (${safetyScore.tier})`,
    {
      evaluationId,
      score: safetyScore.overall,
      tier: safetyScore.tier,
      isSafeToExecute,
      flagCount: mergedFlags.length,
      criticalFlags: mergedFlags.filter((f) => f.severity === "critical")
        .length,
      highFlags: mergedFlags.filter((f) => f.severity === "high").length,
      durationMs: totalDurationMs,
      breakdown: safetyScore.breakdown,
      auditReasons: auditTrail.safetyVerdictReasons,
    },
  );

  logger.info("[orchestrator] ═══════════════════════════════════════════");

  return response;
}

// ---------------------------------------------------------------------------
// Convenience: Token-Only Scan
// ---------------------------------------------------------------------------

/**
 * Lightweight endpoint for scanning a single token without a full
 * trade evaluation. Useful for agents that want to pre-screen tokens
 * before constructing a swap transaction.
 */
export async function scanToken(
  request: TokenScanRequest,
  config?: Partial<GuardianConfig>,
): Promise<TokenScanResponse> {
  const evaluationId = uuidv4();
  const startTime = performance.now();
  const resolvedConfig = createConfig(config);
  const chainId: SupportedChainId = request.chainId ?? 177;

  logger.info("[orchestrator] Token scan requested", {
    evaluationId,
    tokenAddress: request.tokenAddress,
    chainId,
  });

  const result = await runAnalyzer("token-risk-analyzer", () =>
    analyzeTokenRisk(request.tokenAddress, chainId, resolvedConfig.tokenRisk),
  );

  const durationMs = Math.round(performance.now() - startTime);
  const report = result.data as Record<string, unknown>;

  return {
    evaluationId,
    timestamp: new Date().toISOString(),
    chainId,
    tokenAddress: request.tokenAddress,
    safetyScore: {
      overall: result.score,
      tier:
        result.score >= 90
          ? "SAFE"
          : result.score >= 70
            ? "MODERATE"
            : result.score >= 50
              ? "CAUTION"
              : result.score >= 30
                ? "DANGEROUS"
                : "CRITICAL",
      tokenRisk: result.score,
    },
    flags: result.flags,
    isSafe:
      result.score >= resolvedConfig.scoringPolicy.safetyThreshold &&
      !result.flags.some((f) => f.severity === "critical"),
  };
}

// ---------------------------------------------------------------------------
// Convenience: Standalone TX Simulation
// ---------------------------------------------------------------------------

/**
 * Lightweight endpoint for simulating a transaction without the full
 * scoring pipeline. Useful for agents that already have token safety
 * data and just want to test if a specific tx will succeed.
 */
export async function simulateTx(
  request: TxSimulationRequest,
  config?: Partial<GuardianConfig>,
): Promise<TxSimulationResponse> {
  const evaluationId = uuidv4();
  const resolvedConfig = createConfig(config);
  const chainId: SupportedChainId = request.chainId ?? 177;

  logger.info("[orchestrator] Standalone TX simulation requested", {
    evaluationId,
    userAddress: request.userAddress,
    chainId,
  });

  const result = await runAnalyzer("tx-simulation-analyzer", () =>
    simulateTransaction(
      request.proposedTxHex,
      request.userAddress,
      request.targetAddress || request.userAddress,
      null,
      null,
      18,
      chainId,
      "0",
      resolvedConfig.txSimulation,
    ),
  );

  const simData = result.data as Record<string, unknown>;

  return {
    evaluationId,
    timestamp: new Date().toISOString(),
    chainId,
    safetyScore: {
      overall: result.score
    },
    simulationSuccess: (simData["simulationSuccess"] as boolean) ?? false,
    gasUsed: (simData["gasUsed"] as string) ?? "0",
    stateChanges: [], // Populated in Phase 6 with full trace analysis
    flags: result.flags,
  };
}

// ---------------------------------------------------------------------------
// Re-exports for consumers
// ---------------------------------------------------------------------------

export type {
  GuardianEvaluationRequest,
  GuardianEvaluationResponse,
  TokenScanRequest,
  TokenScanResponse,
  TxSimulationRequest,
  TxSimulationResponse,
  SafetyScore,
  RiskFlag,
  GuardianConfig,
};
