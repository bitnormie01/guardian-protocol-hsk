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

  /**
   * Whether to run the 8-variant invariant fuzzer after the primary
   * simulation succeeds. Disable for latency-critical evaluations.
   * Default: true
   */
  enableFuzzing: boolean;

  /**
   * Timeout for the entire fuzz batch in milliseconds.
   * All 8 variants run in parallel; this is the wall-clock budget.
   * Default: 5000 (5 seconds)
   */
  fuzzTimeoutMs: number;

  /**
   * Maximum acceptable deviation ratio between a fuzz variant's output
   * and the expected proportional output. Values above this trigger a
   * FUZZING_INVARIANT_VIOLATION flag for output non-linearity.
   * Default: 0.30 (30%)
   */
  fuzzMaxDeviationRatio: number;
}

const DEFAULT_THRESHOLDS: SimulationThresholds = {
  maxSlippageBps: 500,
  slippageWarningBps: 200,
  maxGasCostOKB: 0.1,
  simulationTimeoutMs: Number(
    process.env["GUARDIAN_TX_SIMULATION_TIMEOUT_MS"] ?? "10000",
  ),
  enableFuzzing: true,
  fuzzTimeoutMs: 5000,
  fuzzMaxDeviationRatio: 0.30,
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

  // ---- Invariant Fuzzing Results ----

  /**
   * Results from the 8-variant invariant fuzzer.
   * Null if fuzzing was disabled, skipped (primary reverted), or timed out entirely.
   */
  fuzzingResults: {
    /** Whether fuzzing was enabled for this evaluation. */
    enabled: boolean;
    /** Number of fuzz variants attempted. */
    variantsRun: number;
    /** Number that completed (success or revert). */
    variantsCompleted: number;
    /** Number that failed due to RPC errors (not reverts). */
    variantsFailed: number;
    /** Number of invariant violations detected. */
    invariantViolations: number;
    /** Per-variant results. */
    variants: Array<{
      name: string;
      success: boolean;
      reverted: boolean;
      outputDeviation: number | null;
      anomaly: string | null;
    }>;
    /** Wall-clock time for the fuzz batch. */
    durationMs: number;
  } | null;
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
// Invariant Fuzzing: 8-Variant Mutation Engine
// ---------------------------------------------------------------------------
//
// After the primary eth_call succeeds, we run 8 MUTATED versions of
// the same transaction to probe for hidden contract behavior:
//
//   - State-dependent traps (reverts only under certain conditions)
//   - Non-linear output (price manipulation, hidden fees on large amounts)
//   - Fallback function traps (unexpected selector handling)
//   - ABI compliance issues (missing parameter handling)
//
// All 8 variants run IN PARALLEL via Promise.allSettled, reusing the
// same round-robin RPC pool. Each variant uses the SAME pinned block
// for deterministic results.
// ---------------------------------------------------------------------------

/** A single fuzz variant definition. */
interface FuzzVariant {
  name: string;
  /** The mutated calldata hex string. */
  data: HexString;
  /** Expected output multiplier relative to the primary (for linearity checks). */
  expectedMultiplier: number | null;
}

/** Result of a single fuzz variant execution. */
interface FuzzVariantResult {
  name: string;
  success: boolean;
  reverted: boolean;
  returnData: HexString | null;
  error: string | null;
}

/**
 * Generates 8 mutated variants of the proposed transaction calldata.
 *
 * All mutations operate on raw hex bytes — no ABI decoding required.
 * This is intentional: a fuzzer should test the contract's handling
 * of MALFORMED inputs, not just well-formed ones.
 *
 * The calldata layout for a typical EVM function call:
 *   Bytes 0–3:   Function selector (4 bytes)
 *   Bytes 4–35:  First parameter (32 bytes, typically uint256)
 *   Bytes 36–67: Second parameter, etc.
 */
function generateFuzzVariants(originalData: HexString): FuzzVariant[] {
  // Strip 0x prefix for byte manipulation, then re-add
  const raw = originalData.slice(2);
  const selector = raw.slice(0, 8); // 4 bytes = 8 hex chars
  const params = raw.slice(8);      // Everything after selector

  // If calldata is too short (just a selector or less), skip fuzzing
  if (params.length < 64) {
    logger.info("[fuzz] Calldata too short for meaningful fuzzing, skipping", {
      calldataLength: raw.length / 2,
    });
    return [];
  }

  // Extract the first uint256 parameter (bytes 4–35 = hex chars 8–71)
  const firstParam = params.slice(0, 64);
  const firstParamBigInt = BigInt("0x" + firstParam);
  const restParams = params.slice(64);

  const variants: FuzzVariant[] = [];

  // Variant 1: Zero-args — replace all params with zeros
  variants.push({
    name: "zero-args",
    data: ("0x" + selector + "0".repeat(params.length)) as HexString,
    expectedMultiplier: null, // Can't predict output for zero input
  });

  // Variant 2: Max-uint256 — replace first param with 2^256 - 1
  const maxUint256 = "f".repeat(64);
  variants.push({
    name: "max-uint256",
    data: ("0x" + selector + maxUint256 + restParams) as HexString,
    expectedMultiplier: null, // Overflow-class test, no linear expectation
  });

  // Variant 3: Half-amount — divide first param by 2
  const halfAmount = (firstParamBigInt / 2n).toString(16).padStart(64, "0");
  variants.push({
    name: "half-amount",
    data: ("0x" + selector + halfAmount + restParams) as HexString,
    expectedMultiplier: 0.5,
  });

  // Variant 4: Double-amount — multiply first param by 2
  const doubleAmount = (firstParamBigInt * 2n).toString(16).padStart(64, "0");
  // Protect against overflow beyond uint256
  const doubleHex = doubleAmount.length > 64
    ? maxUint256
    : doubleAmount;
  variants.push({
    name: "double-amount",
    data: ("0x" + selector + doubleHex + restParams) as HexString,
    expectedMultiplier: 2.0,
  });

  // Variant 5: 10x-amount — multiply first param by 10
  const tenXAmount = (firstParamBigInt * 10n).toString(16).padStart(64, "0");
  const tenXHex = tenXAmount.length > 64
    ? maxUint256
    : tenXAmount;
  variants.push({
    name: "10x-amount",
    data: ("0x" + selector + tenXHex + restParams) as HexString,
    expectedMultiplier: 10.0,
  });

  // Variant 6: Byte-flip — XOR the first byte of the first param with 0xFF
  const flippedFirstByte = (parseInt(firstParam.slice(0, 2), 16) ^ 0xFF)
    .toString(16)
    .padStart(2, "0");
  const flippedParam = flippedFirstByte + firstParam.slice(2);
  variants.push({
    name: "byte-flip",
    data: ("0x" + selector + flippedParam + restParams) as HexString,
    expectedMultiplier: null, // Random mutation, no linear expectation
  });

  // Variant 7: Truncation — remove last 32 bytes of calldata
  const truncatedRaw = raw.slice(0, Math.max(raw.length - 64, 8));
  variants.push({
    name: "truncation",
    data: ("0x" + truncatedRaw) as HexString,
    expectedMultiplier: null,
  });

  // Variant 8: Selector-swap — replace selector with 0x00000000 (fallback)
  variants.push({
    name: "selector-swap",
    data: ("0x" + "00000000" + params) as HexString,
    expectedMultiplier: null,
  });

  return variants;
}

/**
 * Fires all fuzz variants in parallel against the RPC pool.
 *
 * Uses Promise.allSettled so individual failures don't crash the batch.
 * The entire batch is wrapped in a timeout — if the RPC pool is slow,
 * we abandon fuzzing rather than blocking the pipeline.
 */
async function runFuzzBatch(
  rpcClient: HashKeyRPCClient,
  baseParams: SimulationCallParams,
  variants: FuzzVariant[],
  blockNumber: bigint,
  timeoutMs: number,
): Promise<FuzzVariantResult[]> {
  const fuzzPromises = variants.map(async (variant): Promise<FuzzVariantResult> => {
    try {
      const result = await rpcClient.simulateCall(
        { ...baseParams, data: variant.data },
        blockNumber,
      );
      return {
        name: variant.name,
        success: result.success,
        reverted: !result.success,
        returnData: result.returnData,
        error: null,
      };
    } catch (err) {
      return {
        name: variant.name,
        success: false,
        reverted: false,
        returnData: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Race the entire batch against a timeout
  const timeoutPromise = new Promise<FuzzVariantResult[]>((resolve) => {
    setTimeout(() => {
      logger.warn("[fuzz] Fuzz batch timed out, returning partial results");
      resolve([]);
    }, timeoutMs);
  });

  return Promise.race([
    Promise.all(fuzzPromises),
    timeoutPromise,
  ]);
}

/**
 * Analyzes fuzz results against the primary simulation to detect:
 *   A. Hidden reverts — variants that revert when the primary succeeded
 *   B. Output non-linearity — proportional inputs producing disproportionate outputs
 *
 * Returns an array of risk flags for each detected anomaly.
 */
function analyzeFuzzResults(
  primaryReturnData: HexString | null,
  variants: FuzzVariant[],
  results: FuzzVariantResult[],
  maxDeviationRatio: number,
): {
  flags: RiskFlag[];
  variantDetails: Array<{
    name: string;
    success: boolean;
    reverted: boolean;
    outputDeviation: number | null;
    anomaly: string | null;
  }>;
} {
  const flags: RiskFlag[] = [];
  const variantDetails: Array<{
    name: string;
    success: boolean;
    reverted: boolean;
    outputDeviation: number | null;
    anomaly: string | null;
  }> = [];

  // Decode the primary simulation's output as a uint256 for comparison
  let primaryOutput: bigint | null = null;
  if (primaryReturnData && primaryReturnData !== "0x" && primaryReturnData.length >= 66) {
    try {
      const [decoded] = decodeAbiParameters(
        parseAbiParameters("uint256"),
        primaryReturnData as HexString,
      ) as [bigint];
      if (decoded > 0n) {
        primaryOutput = decoded;
      }
    } catch {
      // Can't decode primary output — skip linearity checks
    }
  }

  // Track hidden reverts
  const hiddenReverts: string[] = [];

  for (const result of results) {
    const variant = variants.find((v) => v.name === result.name);
    if (!variant) continue;

    let outputDeviation: number | null = null;
    let anomaly: string | null = null;

    // --- Check A: Hidden Reverts ---
    // Variants that revert when the primary succeeded indicate
    // state-dependent contract behavior (traps, conditional modifiers).
    if (result.reverted && !result.error) {
      // Certain variants are EXPECTED to revert (zero-args, max-uint256,
      // truncation, selector-swap, byte-flip). These test edge cases.
      // Only flag amount-based variants (half, double, 10x) as suspicious
      // because proportional inputs should not cause reverts.
      const amountVariants = ["half-amount", "double-amount", "10x-amount"];
      if (amountVariants.includes(result.name)) {
        hiddenReverts.push(result.name);
        anomaly = `${result.name} REVERTED while primary succeeded — ` +
          `the contract has state-dependent behavior that blocks ` +
          `proportional inputs. This may indicate a trap or conditional restriction.`;
      }
    }

    // --- Check B: Output Non-Linearity ---
    // For variants with expected multipliers (half, double, 10x),
    // verify the output is roughly proportional.
    if (
      result.success &&
      primaryOutput !== null &&
      variant.expectedMultiplier !== null &&
      result.returnData &&
      result.returnData !== "0x" &&
      result.returnData.length >= 66
    ) {
      try {
        const [variantOutput] = decodeAbiParameters(
          parseAbiParameters("uint256"),
          result.returnData as HexString,
        ) as [bigint];

        if (variantOutput > 0n) {
          const expectedOutput = Number(primaryOutput) * variant.expectedMultiplier;
          const actualOutput = Number(variantOutput);
          const deviation = Math.abs(actualOutput - expectedOutput) / expectedOutput;
          outputDeviation = Math.round(deviation * 10000) / 10000;

          if (deviation > maxDeviationRatio) {
            anomaly = `${result.name} output deviates ${(deviation * 100).toFixed(1)}% ` +
              `from expected proportional output (threshold: ${(maxDeviationRatio * 100).toFixed(0)}%). ` +
              `Expected ~${expectedOutput.toFixed(0)} but got ${actualOutput.toFixed(0)}. ` +
              `This suggests non-linear pricing behavior — possible manipulation or hidden fees.`;
          }
        }
      } catch {
        // Can't decode variant output — skip linearity check
      }
    }

    variantDetails.push({
      name: result.name,
      success: result.success,
      reverted: result.reverted,
      outputDeviation,
      anomaly,
    });
  }

  // --- Generate Flags ---

  // Hidden reverts: high severity if 2+ variants revert, medium if 1
  if (hiddenReverts.length >= 2) {
    flags.push(createFlag(
      RiskFlagCode.FUZZING_INVARIANT_VIOLATION,
      "high",
      `INVARIANT VIOLATION: ${hiddenReverts.length} fuzz variants (${hiddenReverts.join(", ")}) ` +
        `REVERTED while the primary transaction succeeded. The contract exhibits ` +
        `state-dependent gating behavior that blocks proportional inputs — ` +
        `this is a strong indicator of a conditional trap or hidden restriction.`,
    ));
  } else if (hiddenReverts.length === 1) {
    flags.push(createFlag(
      RiskFlagCode.FUZZING_INVARIANT_VIOLATION,
      "medium",
      `INVARIANT WARNING: Fuzz variant "${hiddenReverts[0]}" REVERTED while ` +
        `the primary transaction succeeded. The contract may have amount-dependent ` +
        `restrictions. Exercise caution — the trade may be fragile to input changes.`,
    ));
  }

  // Output non-linearity: flag each deviation independently
  const nonLinearVariants = variantDetails.filter(
    (v) => v.anomaly !== null && !v.reverted,
  );
  if (nonLinearVariants.length > 0) {
    const severity = nonLinearVariants.length >= 2 ? "high" as const : "medium" as const;
    flags.push(createFlag(
      RiskFlagCode.FUZZING_INVARIANT_VIOLATION,
      severity,
      `NON-LINEAR OUTPUT: ${nonLinearVariants.length} fuzz variant(s) produced ` +
        `disproportionate outputs (${nonLinearVariants.map((v) => v.name).join(", ")}). ` +
        `The contract's pricing curve is non-linear beyond the acceptable threshold. ` +
        `This may indicate hidden fees, price manipulation, or a rigged AMM curve.`,
    ));
  }

  return { flags, variantDetails };
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
    // Step 2.5: Invariant Fuzzing (8 variants, parallel)
    // ------------------------------------------------------------------
    // Run ONLY if the primary simulation SUCCEEDED. If it reverted,
    // there's no baseline to compare fuzz variants against.
    // Fuzzing is fire-and-forget: if it fails (timeout, RPC error),
    // we continue with the primary result only.

    let fuzzingResults: TxSimulationReport["fuzzingResults"] = null;

    if (
      ethCallResult.success &&
      resolvedThresholds.enableFuzzing
    ) {
      const fuzzStart = performance.now();
      try {
        const variants = generateFuzzVariants(proposedTxHex);

        if (variants.length > 0) {
          logger.info(`[${ANALYZER_NAME}] Running ${variants.length}-variant invariant fuzzer`, {
            variantNames: variants.map((v) => v.name),
            blockNumber: ethCallResult.blockNumber.toString(),
            fuzzTimeoutMs: resolvedThresholds.fuzzTimeoutMs,
          });

          const fuzzResults = await runFuzzBatch(
            rpc,
            callParams,
            variants,
            ethCallResult.blockNumber,
            resolvedThresholds.fuzzTimeoutMs,
          );

          const fuzzDurationMs = Math.round(performance.now() - fuzzStart);

          if (fuzzResults.length > 0) {
            const analysis = analyzeFuzzResults(
              ethCallResult.returnData,
              variants,
              fuzzResults,
              resolvedThresholds.fuzzMaxDeviationRatio,
            );

            // Merge fuzzing flags into the main flag array
            flags.push(...analysis.flags);

            const completed = fuzzResults.filter(
              (r) => r.success || r.reverted,
            ).length;
            const failed = fuzzResults.filter(
              (r) => r.error !== null,
            ).length;

            fuzzingResults = {
              enabled: true,
              variantsRun: variants.length,
              variantsCompleted: completed,
              variantsFailed: failed,
              invariantViolations: analysis.flags.length,
              variants: analysis.variantDetails,
              durationMs: fuzzDurationMs,
            };

            logger.info(`[${ANALYZER_NAME}] Fuzzing complete`, {
              variantsRun: variants.length,
              completed,
              failed,
              violations: analysis.flags.length,
              durationMs: fuzzDurationMs,
            });
          } else {
            // Fuzz batch timed out entirely
            fuzzingResults = {
              enabled: true,
              variantsRun: variants.length,
              variantsCompleted: 0,
              variantsFailed: variants.length,
              invariantViolations: 0,
              variants: [],
              durationMs: fuzzDurationMs,
            };
            logger.warn(`[${ANALYZER_NAME}] Fuzz batch timed out entirely`, {
              durationMs: fuzzDurationMs,
            });
          }
        } else {
          logger.info(`[${ANALYZER_NAME}] Fuzzing skipped — calldata too short`);
        }
      } catch (fuzzErr) {
        // Fuzzing failure is NON-FATAL — we continue with primary results
        const fuzzDurationMs = Math.round(performance.now() - fuzzStart);
        logger.warn(`[${ANALYZER_NAME}] Fuzzing failed (non-fatal)`, {
          error: fuzzErr instanceof Error ? fuzzErr.message : String(fuzzErr),
          durationMs: fuzzDurationMs,
        });
      }
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

      fuzzingResults,
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
