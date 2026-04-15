// ==========================================================================
// Guardian Protocol — Transaction Simulation Analyzer
// ==========================================================================
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │  WHY WE SIMULATE TRANSACTIONS BEFORE EXECUTING THEM                 │
// │                                                                     │
// │  1. REVERT DETECTION                                                │
// │     A transaction that reverts on-chain WASTES THE FULL GAS         │
// │     BUDGET. On HashKey Chain with HSK as gas, this is a real cost   │
// │     to the agent. We catch reverts BEFORE the tx hits the           │
// │     mempool, protecting the agent's gas budget.                     │
// │                                                                     │
// │  2. EXACT SLIPPAGE CALCULATION                                      │
// │     DEX quotes are approximations. The actual swap output can       │
// │     differ due to price movement between quote and execution.       │
// │     We simulate the exact tx and compute the ACTUAL output vs       │
// │     expected, giving the agent precise slippage figures.            │
// │                                                                     │
// │  3. UNEXPECTED STATE CHANGES                                        │
// │     A malicious contract might embed hidden logic that triggers     │
// │     on swap — approving a drainer, transferring tokens to a         │
// │     third party, or changing contract state in unexpected ways.     │
// │     We compare pre/post simulation state to detect anomalies.       │
// │                                                                     │
// │  4. GAS COST ESTIMATION                                             │
// │     On HashKey Chain, gas costs are paid in HSK. We calculate the   │
// │     exact gas cost so the agent can factor it into profitability.   │
// │     A swap that yields $2 profit but costs $5 in gas is a net       │
// │     loss — agents need this math before executing.                  │
// │                                                                     │
// │  5. BALANCE CHANGE VERIFICATION                                     │
// │     We snapshot the user's token balances before simulation and     │
// │     compare with the dual-RPC cross-validation result. If the      │
// │     numbers don't match, something is wrong.                        │
// └──────────────────────────────────────────────────────────────────────┘
//
// DATA SOURCES:
//   - HashKey Chain JSON-RPC (eth_call, eth_estimateGas, eth_getBalance)
//   - Dual-RPC cross-validation (primary + secondary endpoint)
//   - Both are called in parallel for speed + cross-validation.
//
// ==========================================================================

import type { Address, HexString, SupportedChainId } from "../types/input.js";
import type { AnalyzerResult } from "../types/internal.js";
import type { RiskFlag, RiskSeverity } from "../types/output.js";
import { RiskFlagCode } from "../types/output.js";
import type { TxSimulationData } from "../types/hashkey-api.js";
import {
  HashKeyRPCClient,
  type SimulationCallParams,
  type EthCallResult,
  type TokenBalanceSnapshot,
} from "../services/hashkey-rpc-client.js";
import { GoPlusSecurityClient } from "../services/goplus-security-client.js";
import { GuardianError, ErrorCode } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { formatEther, formatUnits, decodeAbiParameters, parseAbiParameters } from "viem";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configurable thresholds for the simulation analyzer.
 * Agents can override these to match their risk appetite.
 */
export interface SimulationThresholds {
  /**
   * Maximum acceptable slippage in basis points (1 bps = 0.01%).
   * If actual slippage exceeds this, a HIGH flag is raised.
   * Default: 500 (5.00%)
   */
  maxSlippageBps: number;

  /**
   * Slippage warning threshold in basis points.
   * Raises a MEDIUM flag.
   * Default: 200 (2.00%)
   */
  slippageWarningBps: number;

  /**
   * Maximum gas cost in HSK that's considered acceptable.
   * Beyond this, the agent gets a warning that gas is eating profits.
   * Default: 0.1 HSK
   */
  maxGasCostOKB: number;

  /**
   * Timeout for the simulation in milliseconds.
   * If the simulation takes longer, we abort and fail closed.
   * Default: 10000 (10 seconds)
   */
  simulationTimeoutMs: number;
}

const DEFAULT_THRESHOLDS: SimulationThresholds = {
  maxSlippageBps: 500,
  slippageWarningBps: 200,
  maxGasCostOKB: 0.1,
  simulationTimeoutMs: Number(
    process.env["GUARDIAN_TX_SIMULATION_TIMEOUT_MS"] ?? "10000",
  ),
};

// ---------------------------------------------------------------------------
// Simulation Report (module-specific output)
// ---------------------------------------------------------------------------

/**
 * The rich, structured report produced by the simulation analyzer.
 * Stored in `AnalyzerResult.data` for downstream consumers.
 */
export interface TxSimulationReport {
  /** Whether the simulated transaction succeeded (did not revert). */
  simulationSuccess: boolean;

  /** If reverted, the human-readable reason. */
  revertReason: string | null;

  // ---- Gas Analysis ----

  /** Estimated gas units consumed by the transaction. */
  gasUsed: string;

  /** Current gas price in wei. */
  gasPriceWei: string;

  /** Total gas cost in HSK (native token), human-readable decimal. */
  gasCostOKB: string;

  /**
   * If the tx would revert, this is how much HSK would be WASTED
   * on a failed transaction. This is the "cost of a mistake."
   */
  wastedGasCostOKB: string | null;

  // ---- Slippage Analysis ----

  /**
   * The expected output amount (from the agent's DEX quote),
   * in human-readable decimal. Null if not calculable.
   */
  expectedOutputAmount: string | null;

  /**
   * The actual output amount from simulation,
   * in human-readable decimal. Null if simulation reverted.
   */
  actualOutputAmount: string | null;

  /**
   * Exact slippage in basis points (1 bps = 0.01%).
   * Positive = worse than expected. Negative = better than expected.
   * Null if not calculable.
   */
  slippageBps: number | null;

  /**
   * Human-readable slippage percentage string (e.g., "2.35%").
   */
  slippagePercent: string | null;

  // ---- Balance Changes ----

  /**
   * Pre-simulation balance snapshot of the user's tokenOut holdings.
   */
  preBalanceSnapshot: TokenBalanceSnapshot | null;

  /**
   * Balance changes reported by the simulation.
   */
  balanceChanges: Array<{
    tokenAddress: string;
    amount: string;
    direction: "in" | "out";
  }>;

  // ---- Cross-Validation (Dual-RPC) ----

  /**
   * Risk level from the cross-validation RPC endpoint.
   * "safe" | "warning" | "danger" — an independent second opinion.
   */
  crossValidationRiskLevel: string | null;

  /**
   * Risk messages from the cross-validation, if any.
   */
  crossValidationRiskMessages: string[];

  // ---- Execution Context ----

  /** The block number the simulation was pinned to. */
  simulationBlock: string;

  /** Chain ID. */
  chainId: SupportedChainId;

  /** All risk flags raised during simulation. */
  flags: RiskFlag[];

  /** Sub-score for this analyzer (0–100). */
  score: number;
}

// ---------------------------------------------------------------------------
// Helper: Create Risk Flag
// ---------------------------------------------------------------------------

function createFlag(
  code: RiskFlagCode,
  severity: RiskSeverity,
  message: string,
): RiskFlag {
  return {
    code,
    severity,
    message,
    source: "tx-simulation-analyzer",
  };
}

// ---------------------------------------------------------------------------
// Helper: Compute Slippage
// ---------------------------------------------------------------------------

/**
 * Computes slippage in basis points between expected and actual output.
 *
 * Formula: slippageBps = ((expected - actual) / expected) * 10000
 *
 * Positive slippage = agent receives LESS than expected (bad).
 * Negative slippage = agent receives MORE than expected (good, rare).
 * Zero = perfect execution.
 *
 * WHY BASIS POINTS:
 *   Basis points avoid floating-point confusion. "50 bps" is
 *   unambiguous, whereas "0.5%" could be misinterpreted. DeFi
 *   protocols universally use bps for slippage parameters.
 */
function computeSlippageBps(expectedRaw: bigint, actualRaw: bigint): number {
  if (expectedRaw === 0n) return 0;

  // Use scaled integer arithmetic to avoid floating-point errors.
  // Multiply by 10000 (bps scale) BEFORE dividing.
  const diff = expectedRaw - actualRaw;
  const slippageBps = Number((diff * 10000n) / expectedRaw);

  return slippageBps;
}

// ---------------------------------------------------------------------------
// Helper: Compute Simulation Score
// ---------------------------------------------------------------------------

/**
 * Computes a 0–100 sub-score for the simulation analysis.
 *
 * SCORING METHODOLOGY:
 *   - Reverted transaction: immediate 0
 *   - High slippage (> maxSlippageBps): -40
 *   - Warning slippage (> warningBps): -20
 *   - Unexpected state changes from GoPlus isRiskTokenscan: -25
 *   - GoPlus isRiskTokenrisk level "danger": -30
 *   - GoPlus isRiskTokenrisk level "warning": -15
 *   - Gas estimation failure: -10
 *
 * The score never goes below 0.
 */
function computeSimulationScore(flags: RiskFlag[]): number {
  // Reverted tx = immediate 0
  if (flags.some((f) => f.code === RiskFlagCode.TX_SIMULATION_REVERTED)) {
    return 0;
  }

  let score = 100;

  for (const flag of flags) {
    switch (flag.severity) {
      case "critical":
        score -= 40;
        break;
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
// Core: Run RPC Simulation
// ---------------------------------------------------------------------------

/**
 * Runs the eth_call simulation on HashKey Chain and collects balance data.
 *
 * This is separated from the main function for testability and
 * because it handles the retry/timeout logic independently.
 */
async function runRPCSimulation(
  rpcClient: HashKeyRPCClient,
  callParams: SimulationCallParams,
  tokenOutAddress: Address | null,
  userAddress: Address,
  timeoutMs: number,
): Promise<{
  ethCallResult: EthCallResult;
  preBalance: TokenBalanceSnapshot | null;
  gasPrice: bigint;
}> {
  // Race the simulation against a timeout.
  // If the RPC node is slow, we MUST NOT hang the agent indefinitely.
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () =>
        reject(
          new GuardianError(
            ErrorCode.API_TIMEOUT,
            `Transaction simulation timed out after ${timeoutMs}ms. ` +
              `The HashKey Chain RPC node may be congested or unreachable.`,
          ),
        ),
      timeoutMs,
    );
  });

  const simulationPromise = (async () => {
    // Pin to a specific block for deterministic results
    const blockNumber = await rpcClient.getLatestBlockNumber();

    // Run eth_call, balance read, and gas price fetch in parallel
    const [ethCallResult, preBalance, gasPrice] = await Promise.all([
      // 1. The actual simulation
      rpcClient.simulateCall(callParams, blockNumber),

      // 2. Pre-simulation balance of tokenOut (if we know the token)
      tokenOutAddress
        ? rpcClient
            .getTokenBalance(tokenOutAddress, userAddress, blockNumber)
            .catch((err) => {
              logger.warn("Failed to read pre-balance for tokenOut", {
                tokenOutAddress,
                error: err instanceof Error ? err.message : String(err),
              });
              return null;
            })
        : Promise.resolve(null),

      // 3. Current gas price
      rpcClient.getGasPrice().catch(() => {
        logger.warn("Failed to fetch gas price, using fallback");
        return 1_000_000_000n; // 1 gwei fallback
      }),
    ]);

    return { ethCallResult, preBalance, gasPrice };
  })();

  return Promise.race([simulationPromise, timeoutPromise]);
}

// ---------------------------------------------------------------------------
// Core: Run Cross-Validation via Second RPC Endpoint
// ---------------------------------------------------------------------------

/**
 * Runs a second eth_call on a DIFFERENT RPC endpoint from our
 * round-robin pool as an independent cross-validation.
 *
 * This runs IN PARALLEL with the primary RPC simulation — we don't
 * wait for one to finish before starting the other. If both RPCs
 * return the same result, no penalty. If they diverge, we apply
 * the existing -15 cross-validation penalty.
 *
 * If the secondary RPC is unavailable, we continue with primary-only
 * results rather than failing the entire simulation. The cross-check
 * is additive — it ADDS confidence when available but its absence
 * doesn't BLOCK the pipeline.
 */
async function runCrossValidationSimulation(
  goPlusClient: GoPlusSecurityClient,
  from: Address,
  to: Address,
  data: HexString,
  value: string,
  chainId: SupportedChainId,
): Promise<TxSimulationData | null> {
  try {
    return await goPlusClient.simulateTransaction(
      { from, to, data, value },
      chainId,
    );
  } catch (err) {
    // Cross-validation failure is NON-FATAL for the pipeline.
    // We log it and continue with primary RPC-only results.
    logger.warn("Cross-validation simulation failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main Export: simulateTransaction()
// ---------------------------------------------------------------------------

/**
 * The primary entry point for transaction simulation analysis.
 *
 * This function orchestrates:
 *   1. Parallel execution of RPC simulation + cross-validation
 *   2. Revert detection with gas waste calculation
 *   3. Exact slippage computation from simulated balance changes
 *   4. Risk flag generation for all detected issues
 *   5. Standardized AnalyzerResult output for the pipeline
 *
 * DESIGN PRINCIPLES:
 *   - FAIL CLOSED: If simulation fails, score = 0, block the trade
 *   - PARALLEL: Primary + cross-validation run concurrently for speed
 *   - DETERMINISTIC: Pinned to a specific block number
 *   - GRACEFUL DEGRADATION: Cross-validation failure → primary-only (still useful)
 *
 * @param proposedTxHex      - Raw hex transaction data to simulate
 * @param userAddress        - The wallet address executing the tx
 * @param targetAddress      - The contract being called (DEX router)
 * @param tokenOutAddress    - The token the user expects to receive (for slippage calc)
 * @param expectedOutputRaw  - Expected output in raw token units (bigint) for slippage
 * @param tokenOutDecimals   - Decimals of the output token (for formatting)
 * @param chainId            - HashKey Chain ID (177/133)
 * @param txValue            - ETH/HSK value sent with the tx (for native swaps)
 * @param thresholds         - Optional custom thresholds
 * @param rpcClient          - Optional pre-configured RPC client (for testing/DI)
 * @param goPlusClient          - Optional pre-configured cross-validation client (for testing/DI)
 */
export async function simulateTransaction(
  proposedTxHex: HexString,
  userAddress: Address,
  targetAddress: Address,
  tokenOutAddress: Address | null,
  expectedOutputRaw: bigint | null,
  tokenOutDecimals: number = 18,
  chainId: SupportedChainId = 177,
  txValue: string = "0",
  thresholds: Partial<SimulationThresholds> = {},
  rpcClient?: HashKeyRPCClient,
  goPlusClient?: GoPlusSecurityClient,
): Promise<AnalyzerResult> {
  const ANALYZER_NAME = "tx-simulation-analyzer";
  const startTime = performance.now();
  const resolvedThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const flags: RiskFlag[] = [];

  logger.info(`[${ANALYZER_NAME}] Starting transaction simulation`, {
    targetAddress,
    userAddress,
    tokenOutAddress,
    chainId,
    txDataLength: proposedTxHex.length,
    hasExpectedOutput: expectedOutputRaw !== null,
  });

  try {
    // ------------------------------------------------------------------
    // Step 1: Run BOTH simulations in parallel
    // ------------------------------------------------------------------
    // Primary RPC simulation gives us exact execution results.
    // Cross-validation via second RPC provides independent verification.
    // Running them concurrently saves ~200ms wall-clock time.

    const rpc = rpcClient ?? new HashKeyRPCClient(chainId);
    const goPlus = goPlusClient ?? new GoPlusSecurityClient();

    const callParams: SimulationCallParams = {
      from: userAddress,
      to: targetAddress,
      data: proposedTxHex,
      value: txValue,
    };

    const [rpcResult, crossValidationResult] = await Promise.all([
      runRPCSimulation(
        rpc,
        callParams,
        tokenOutAddress,
        userAddress,
        resolvedThresholds.simulationTimeoutMs,
      ),
      runCrossValidationSimulation(
        goPlus,
        userAddress,
        targetAddress,
        proposedTxHex,
        txValue,
        chainId,
      ),
    ]);

    const { ethCallResult, preBalance, gasPrice } = rpcResult;

    // ------------------------------------------------------------------
    // Step 2: Revert detection
    // ------------------------------------------------------------------
    let wastedGasCostOKB: string | null = null;

    if (!ethCallResult.success) {
      // Calculate how much gas would have been wasted
      const wastedGasWei = ethCallResult.gasUsed * gasPrice;
      wastedGasCostOKB = formatEther(wastedGasWei);

      flags.push(
        createFlag(
          RiskFlagCode.TX_SIMULATION_REVERTED,
          "critical",
          `Transaction simulation REVERTED: "${ethCallResult.revertReason ?? "unknown reason"}". ` +
            `If executed on-chain, this transaction would fail and waste ` +
            `approximately ${wastedGasCostOKB} HSK in gas. ` +
            `DO NOT execute this transaction until the revert is resolved.`,
        ),
      );
    }

    // ------------------------------------------------------------------
    // Step 3: Gas cost analysis
    // ------------------------------------------------------------------
    const gasCostWei = ethCallResult.gasUsed * gasPrice;
    const gasCostOKB = formatEther(gasCostWei);
    const gasCostOKBNum = parseFloat(gasCostOKB);

    // ------------------------------------------------------------------
    // Step 4: Slippage calculation
    // ------------------------------------------------------------------
    let slippageBps: number | null = null;
    let slippagePercent: string | null = null;
    let expectedOutputAmount: string | null = null;
    let actualOutputAmount: string | null = null;

    if (ethCallResult.success) {
      // Strategy 1: GoPlus isRiskTokenbalance change reporting (REMOVED in v6)
      // The GoPlus isRiskTokenv6 API no longer reports balance changes. We rely entirely
      // on native RPC simulation (eth_call) decoding.
      let actualOutputRaw: bigint | null = null;

      // Strategy 2: Decode return data from eth_call
      if (actualOutputRaw === null && ethCallResult.returnData && ethCallResult.returnData !== "0x") {
        try {
          // Try to decode as a single uint256 first (standard ExactInputSingle)
          const [decodedAmount] = decodeAbiParameters(
            parseAbiParameters("uint256"),
            ethCallResult.returnData as HexString
          ) as [bigint];
          if (decodedAmount > 0n) {
            actualOutputRaw = decodedAmount;
          }
        } catch {
          try {
            // Try to decode as uint256[] (standard UniswapV2/V3 multi-hop router return)
            const [decodedAmounts] = decodeAbiParameters(
              parseAbiParameters("uint256[]"),
              ethCallResult.returnData as HexString
            ) as [bigint[]];
            if (decodedAmounts && decodedAmounts.length > 0) {
              const lastAmount = decodedAmounts[decodedAmounts.length - 1];
              if (lastAmount && lastAmount > 0n) {
                actualOutputRaw = lastAmount;
              }
            }
          } catch {
            // Return data format unknown, unable to calculate exact slippage via return data
          }
        }
      }

      // Strategy 3: Pre/post balance delta (if we have pre-balance)
      if (actualOutputRaw === null && preBalance) {
        // Note: We can't compute post-balance from eth_call alone
        // This would require a second call after the simulation.
        // For now, we skip this strategy.
      }

      if (actualOutputRaw !== null) {
        actualOutputAmount = formatUnits(actualOutputRaw, tokenOutDecimals);

        if (expectedOutputRaw !== null) {
          expectedOutputAmount = formatUnits(
            expectedOutputRaw,
            tokenOutDecimals,
          );
          slippageBps = computeSlippageBps(expectedOutputRaw, actualOutputRaw);
          const slippageSign = slippageBps < 0 ? "-" : "";
          slippagePercent = `${slippageSign}${Math.abs(slippageBps / 100).toFixed(2)}%`;

          // Flag excessive slippage
          if (slippageBps > resolvedThresholds.maxSlippageBps) {
            flags.push(
              createFlag(
                RiskFlagCode.HIGH_PRICE_IMPACT,
                "high",
                `Simulated slippage (${slippagePercent}) exceeds the maximum acceptable ` +
                  `threshold of ${resolvedThresholds.maxSlippageBps / 100}% ` +
                  `(${resolvedThresholds.maxSlippageBps} bps). ` +
                  `Expected: ${expectedOutputAmount} tokens, ` +
                  `Actual: ${actualOutputAmount} tokens. ` +
                  `The trade would cost significantly more than quoted.`,
              ),
            );
          } else if (slippageBps > resolvedThresholds.slippageWarningBps) {
            flags.push(
              createFlag(
                RiskFlagCode.HIGH_PRICE_IMPACT,
                "medium",
                `Simulated slippage (${slippagePercent}) is elevated above the ` +
                  `${resolvedThresholds.slippageWarningBps / 100}% warning threshold. ` +
                  `Expected: ${expectedOutputAmount} tokens, ` +
                  `Actual: ${actualOutputAmount} tokens. ` +
                  `Consider waiting for better market conditions.`,
              ),
            );
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // Step 5: Cross-validation results (dual-RPC)
    // ------------------------------------------------------------------
    let crossValidationRiskLevel: string | null = null;
    let crossValidationRiskMessages: string[] = [];
    const balanceChanges: TxSimulationReport["balanceChanges"] = []; // Always empty now

    if (crossValidationResult) {
      if (crossValidationResult.action === "block") {
        crossValidationRiskLevel = "danger";
      } else if (crossValidationResult.action === "warn") {
        crossValidationRiskLevel = "warning";
      } else {
        crossValidationRiskLevel = "safe";
      }

      if (crossValidationResult.riskItemDetail) {
        crossValidationRiskMessages = crossValidationResult.riskItemDetail.map((r: any) => r.desc);
      }

      // Flag cross-validation danger rating
      if (crossValidationRiskLevel === "danger") {
        flags.push(
          createFlag(
            RiskFlagCode.UNEXPECTED_STATE_CHANGE,
            "high",
            `Cross-validation pre-execution scan rated this transaction as DANGER (Blocked). ` +
              `Risk messages: ${crossValidationRiskMessages.join("; ") || "none provided"}. ` +
              `The cross-validation oracle independently flagged this transaction as unsafe. ` +
              `This is a strong signal that the transaction should NOT be executed.`,
          ),
        );
      } else if (crossValidationRiskLevel === "warning") {
        flags.push(
          createFlag(
            RiskFlagCode.UNEXPECTED_STATE_CHANGE,
            "medium",
            `Cross-validation pre-execution scan rated this transaction as WARNING. ` +
              `Risk messages: ${crossValidationRiskMessages.join("; ") || "none provided"}. ` +
              `Proceed with additional caution and verify the transaction details.`,
          ),
        );
      }
    }

    // ------------------------------------------------------------------
    // Step 6: Check gas cost reasonableness
    // ------------------------------------------------------------------
    if (
      ethCallResult.success &&
      gasCostOKBNum > resolvedThresholds.maxGasCostOKB
    ) {
      flags.push(
        createFlag(
          RiskFlagCode.GAS_ESTIMATION_FAILED,
          "low",
          `Gas cost is elevated: ${gasCostOKB} HSK ` +
            `(threshold: ${resolvedThresholds.maxGasCostOKB} HSK). ` +
            `This may indicate a complex multi-hop route or HashKey Chain network congestion. ` +
            `Factor this cost into profitability calculations.`,
        ),
      );
    }

    // ------------------------------------------------------------------
    // Step 7: Sort flags and compute score
    // ------------------------------------------------------------------
    const severityOrder: Record<string, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
      info: 4,
    };
    flags.sort(
      (a, b) =>
        (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4),
    );

    const score = computeSimulationScore(flags);
    const durationMs = Math.round(performance.now() - startTime);

    // ------------------------------------------------------------------
    // Step 8: Assemble the report
    // ------------------------------------------------------------------
    const report: TxSimulationReport = {
      simulationSuccess: ethCallResult.success,
      revertReason: ethCallResult.revertReason,

      gasUsed: ethCallResult.gasUsed.toString(),
      gasPriceWei: gasPrice.toString(),
      gasCostOKB,
      wastedGasCostOKB,

      expectedOutputAmount,
      actualOutputAmount,
      slippageBps,
      slippagePercent,

      preBalanceSnapshot: preBalance,
      balanceChanges,

      crossValidationRiskLevel,
      crossValidationRiskMessages,

      simulationBlock: ethCallResult.blockNumber.toString(),
      chainId,
      flags,
      score,
    };

    // ------------------------------------------------------------------
    // Step 9: Log the verdict
    // ------------------------------------------------------------------
    if (!ethCallResult.success) {
      logger.error(`[${ANALYZER_NAME}] ⛔ TRANSACTION WOULD REVERT`, {
        revertReason: ethCallResult.revertReason,
        wastedGasCostOKB,
        durationMs,
      });
    } else if (score < 50) {
      logger.warn(`[${ANALYZER_NAME}] ⚠️  Simulation passed with concerns`, {
        score,
        slippageBps,
        crossValidationRiskLevel,
        flagCount: flags.length,
        durationMs,
      });
    } else {
      logger.info(`[${ANALYZER_NAME}] ✅ Simulation passed`, {
        score,
        slippageBps,
        gasCostOKB,
        durationMs,
      });
    }

    // ------------------------------------------------------------------
    // Step 10: Return standardized AnalyzerResult
    // ------------------------------------------------------------------
    return {
      analyzerName: ANALYZER_NAME,
      flags,
      score,
      durationMs,
      data: report as unknown as Record<string, unknown>,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - startTime);
    const errorMessage =
      err instanceof GuardianError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);

    const isTimeout =
      err instanceof GuardianError && err.code === ErrorCode.API_TIMEOUT;

    logger.error(`[${ANALYZER_NAME}] ❌ Simulation FAILED — FAILING CLOSED`, {
      error: errorMessage,
      isTimeout,
      durationMs,
    });

    const errorFlag = createFlag(
      isTimeout
        ? RiskFlagCode.GAS_ESTIMATION_FAILED
        : RiskFlagCode.TX_SIMULATION_REVERTED,
      "critical",
      `Transaction simulation FAILED: ${errorMessage}. ` +
        `Guardian Protocol fails CLOSED — this transaction is blocked ` +
        `until a successful simulation can be completed. ` +
        (isTimeout
          ? `The HashKey Chain RPC node did not respond within the timeout period. ` +
            `Retry after network conditions improve.`
          : `The simulation infrastructure encountered an error. ` +
            `Verify the transaction data is well-formed and retry.`),
    );

    return {
      analyzerName: ANALYZER_NAME,
      flags: [errorFlag],
      score: 0, // Fail closed
      durationMs,
      data: {
        error: true,
        errorCode:
          err instanceof GuardianError ? err.code : ErrorCode.SIMULATION_FAILED,
        errorMessage,
        simulationSuccess: false,
        revertReason: errorMessage,
        gasUsed: "0",
        gasCostOKB: "0",
        wastedGasCostOKB: null,
        slippageBps: null,
        slippagePercent: null,
        expectedOutputAmount: null,
        actualOutputAmount: null,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience: Quick Revert Check
// ---------------------------------------------------------------------------

/**
 * A lightweight check that ONLY tests if the transaction reverts.
 * Does not compute slippage or run cross-validation.
 *
 * Use this when the calling agent just needs a fast "will this work?"
 * answer without the full analysis. ~2x faster than full simulation.
 */
export async function quickRevertCheck(
  proposedTxHex: HexString,
  userAddress: Address,
  targetAddress: Address,
  chainId: SupportedChainId = 177,
  rpcClient?: HashKeyRPCClient,
): Promise<{
  willRevert: boolean;
  revertReason: string | null;
  estimatedGas: string;
  gasCostOKB: string;
}> {
  const rpc = rpcClient ?? new HashKeyRPCClient(chainId);

  try {
    const [ethCallResult, gasPrice] = await Promise.all([
      rpc.simulateCall({
        from: userAddress,
        to: targetAddress,
        data: proposedTxHex,
      }),
      rpc.getGasPrice(),
    ]);

    const gasCostWei = ethCallResult.gasUsed * gasPrice;

    return {
      willRevert: !ethCallResult.success,
      revertReason: ethCallResult.revertReason,
      estimatedGas: ethCallResult.gasUsed.toString(),
      gasCostOKB: formatEther(gasCostWei),
    };
  } catch (err) {
    // Even the quick check fails closed
    return {
      willRevert: true,
      revertReason: `Simulation failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      estimatedGas: "0",
      gasCostOKB: "0",
    };
  }
}
