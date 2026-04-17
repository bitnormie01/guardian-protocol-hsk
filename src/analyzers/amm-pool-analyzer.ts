// ==========================================================================
// Guardian Protocol — AMM Concentrated Liquidity Pool Analyzer (Phase 2)
// ==========================================================================
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │  WHY THIS ANALYZER EXISTS                                           │
// │                                                                     │
// │  Concentrated liquidity DEXs (Uniswap V3, and equivalents on       │
// │  HashKey Chain) are mathematically complex. Unlike Uniswap V2       │
// │  product pools (x * y = k), concentrated liquidity pools allow     │
// │  liquidity providers to concentrate their assets within specific    │
// │  price ranges (ticks). This creates opportunities for:             │
// │                                                                     │
// │  1. THIN LIQUIDITY MANIPULATION:                                    │
// │     An attacker can remove liquidity around the current price       │
// │     tick, creating a "liquidity void". When a large swap attempts   │
// │     to trade through this void, the price impact is catastrophic,  │
// │     far exceeding what constant-product math would predict.         │
// │                                                                     │
// │  2. TICK GAP ATTACKS:                                               │
// │     Strategic placement of liquidity at distant ticks with gaps     │
// │     near the current price. This creates price "cliffs" that can   │
// │     be exploited by MEV bots who know where the liquidity is.       │
// │                                                                     │
// │  3. sqrtPriceX96 MANIPULATION:                                      │
// │     Oracle manipulation where the current price (stored as          │
// │     sqrtPriceX96 in the pool) deviates significantly from the      │
// │     TWAP or external price feeds. This signals active price         │
// │     manipulation or an impending oracle attack.                     │
// │                                                                     │
// │  4. ONE-SIDED LIQUIDITY:                                            │
// │     When liquidity is heavily concentrated on one side of the       │
// │     current price, it suggests a coordinated position that may     │
// │     be used for a rug-pull or strategic extraction.                 │
// │                                                                     │
// │  This analyzer reads on-chain pool state via RPC and flags these   │
// │  conditions before the agent's trade executes.                      │
// └──────────────────────────────────────────────────────────────────────┘
//
// ==========================================================================

import type { Address, SupportedChainId } from "../types/input.js";
import type { AnalyzerResult } from "../types/internal.js";
import type { RiskFlag, RiskSeverity } from "../types/output.js";
import { RiskFlagCode } from "../types/output.js";
import { HashKeyRPCClient } from "../services/hashkey-rpc-client.js";
import { enrichWithUniswapAI, type UniswapPoolEnrichment } from "../services/uniswap-ai-enrichment.js";
import { logger } from "../utils/logger.js";
import { ErrorCode } from "../utils/errors.js";
import { parseAbi } from "viem";

// ---------------------------------------------------------------------------
// Uniswap V3-Compatible Pool ABI Fragments
// ---------------------------------------------------------------------------

/**
 * Minimal ABI for reading concentrated liquidity pool state.
 * Compatible with Uniswap V3, SushiSwap V3, PancakeSwap V3,
 * and any fork deployed on HashKey Chain.
 */
const CONCENTRATED_POOL_ABI = parseAbi([
  // slot0: returns current price, tick, and observation data
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  // Current active liquidity at the current tick
  "function liquidity() view returns (uint128)",
  // Read tick-level data
  "function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)",
  // Tick spacing
  "function tickSpacing() view returns (int24)",
  // Fee tier
  "function fee() view returns (uint24)",
  // Token addresses
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configurable thresholds for the AMM pool analyzer.
 */
export interface AMMPoolAnalyzerConfig {
  /**
   * Minimum acceptable liquidity depth at the current tick in USD.
   * Below this → the pool is too thin for the trade.
   * Default: 10000 ($10k)
   */
  minLiquidityDepthUsd: number;

  /**
   * Maximum acceptable tick gap ratio. If the gap between initialized
   * ticks around the current price is large relative to tick spacing,
   * liquidity has been strategically removed.
   * Default: 20 (20x tick spacing = suspicious gap)
   */
  maxTickGapMultiplier: number;

  /**
   * Maximum acceptable sqrtPriceX96 deviation from an estimated
   * fair value, as a ratio. If current price deviates by more than
   * this from recent observations, flag as manipulated.
   * Default: 0.05 (5% deviation)
   */
  maxPriceDeviationRatio: number;

  /**
   * Liquidity asymmetry threshold. If the ratio of liquidity
   * above the current price vs below (or vice versa) exceeds this,
   * the pool has one-sided liquidity.
   * Default: 5.0 (5:1 ratio = suspicious)
   */
  liquidityAsymmetryThreshold: number;

  /**
   * Number of ticks to scan in each direction from the current tick
   * for liquidity analysis.
   * Default: 20
   */
  tickScanRange: number;
}

const DEFAULT_AMM_CONFIG: AMMPoolAnalyzerConfig = {
  minLiquidityDepthUsd: 10_000,
  maxTickGapMultiplier: 20,
  maxPriceDeviationRatio: 0.05,
  liquidityAsymmetryThreshold: 5.0,
  tickScanRange: 20,
};

// ---------------------------------------------------------------------------
// Pool State Types
// ---------------------------------------------------------------------------

/**
 * On-chain state of a concentrated liquidity pool.
 */
export interface ConcentratedPoolState {
  /** Current sqrtPriceX96 (Q64.96 fixed-point). */
  sqrtPriceX96: bigint;
  /** Current active tick. */
  currentTick: number;
  /** Active liquidity at the current tick. */
  activeLiquidity: bigint;
  /** Tick spacing for this pool. */
  tickSpacing: number;
  /** Fee tier in hundredths of a bps (e.g., 3000 = 0.30%). */
  fee: number;
  /** Token0 address. */
  token0: Address;
  /** Token1 address. */
  token1: Address;
  /** Liquidity distribution around the current tick. */
  tickLiquidityMap: Map<
    number,
    { liquidityGross: bigint; liquidityNet: bigint; initialized: boolean }
  >;
  /** The block number this state was read at. */
  blockNumber: bigint;
}

/**
 * AMM pool risk analysis report.
 */
export interface AMMPoolReport {
  /** Whether pool state was successfully read. */
  poolReadSuccess: boolean;
  /** The pool address analyzed. */
  poolAddress: Address;
  /** Current sqrtPriceX96 as string. */
  sqrtPriceX96: string;
  /** Current tick. */
  currentTick: number;
  /** Active liquidity as string. */
  activeLiquidity: string;
  /** Estimated liquidity depth in USD around the current tick. */
  estimatedLiquidityDepthUsd: number;
  /** Whether thin liquidity was detected. */
  thinLiquidityDetected: boolean;
  /** Whether tick gap manipulation was detected. */
  tickGapManipulationDetected: boolean;
  /** Maximum tick gap found (in tick spacing units). */
  maxTickGap: number;
  /** Whether price deviation was detected. */
  priceDeviationDetected: boolean;
  /** Price deviation ratio (0 = no deviation). */
  priceDeviationRatio: number;
  /** Whether one-sided liquidity was detected. */
  oneSidedLiquidityDetected: boolean;
  /** Liquidity asymmetry ratio. */
  liquidityAsymmetryRatio: number;
  /** All risk flags. */
  flags: RiskFlag[];
  /** Sub-score (0–100). */
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
    source: "amm-pool-analyzer",
  };
}

// ---------------------------------------------------------------------------
// Core: Read Concentrated Liquidity Pool State
// ---------------------------------------------------------------------------

/**
 * Reads the exact on-chain state of a concentrated liquidity pool.
 *
 * Uses Uniswap V3-compatible ABI calls to read:
 *   - slot0: current sqrtPriceX96, tick, and observation data
 *   - liquidity: active liquidity at the current tick
 *   - ticks: liquidity distribution at specific tick indices
 *   - tickSpacing: the pool's tick spacing
 *   - fee: the pool's fee tier
 *
 * All reads are pinned to the same block number for consistency.
 */
async function readConcentratedLiquidityState(
  rpcClient: HashKeyRPCClient,
  poolAddress: Address,
  scanRange: number = 20,
): Promise<ConcentratedPoolState> {
  // Pin to a specific block
  const blockNumber = await rpcClient.getLatestBlockNumber();

  logger.debug("[amm-pool] Reading concentrated liquidity pool state", {
    poolAddress,
    blockNumber: blockNumber.toString(),
    scanRange,
  });

  // Read slot0, liquidity, tickSpacing, fee, and tokens in parallel
  const [
    slot0Result,
    liquidityResult,
    tickSpacingResult,
    feeResult,
    token0Result,
    token1Result,
  ] = await Promise.all([
    rpcClient.readContract<
      readonly [bigint, number, number, number, number, number, boolean]
    >({
      address: poolAddress,
      abi: CONCENTRATED_POOL_ABI,
      functionName: "slot0",
      blockNumber,
    }),
    rpcClient.readContract<bigint>({
      address: poolAddress,
      abi: CONCENTRATED_POOL_ABI,
      functionName: "liquidity",
      blockNumber,
    }),
    rpcClient.readContract<number>({
      address: poolAddress,
      abi: CONCENTRATED_POOL_ABI,
      functionName: "tickSpacing",
      blockNumber,
    }),
    rpcClient.readContract<number>({
      address: poolAddress,
      abi: CONCENTRATED_POOL_ABI,
      functionName: "fee",
      blockNumber,
    }),
    rpcClient.readContract<Address>({
      address: poolAddress,
      abi: CONCENTRATED_POOL_ABI,
      functionName: "token0",
      blockNumber,
    }),
    rpcClient.readContract<Address>({
      address: poolAddress,
      abi: CONCENTRATED_POOL_ABI,
      functionName: "token1",
      blockNumber,
    }),
  ]);

  const sqrtPriceX96 = slot0Result[0];
  const currentTick = Number(slot0Result[1]);
  const tickSpacing = Number(tickSpacingResult);

  // --- Scan tick liquidity distribution ---
  // Read ticks in a range around the current tick
  const tickLiquidityMap = new Map<
    number,
    { liquidityGross: bigint; liquidityNet: bigint; initialized: boolean }
  >();

  // Align current tick to tick spacing boundary
  const alignedTick = Math.floor(currentTick / tickSpacing) * tickSpacing;

  // Generate tick indices to scan
  const ticksToScan: number[] = [];
  for (let i = -scanRange; i <= scanRange; i++) {
    ticksToScan.push(alignedTick + i * tickSpacing);
  }

  // Read all ticks in parallel (batched)
  const tickResults = await Promise.allSettled(
    ticksToScan.map(async (tick) => {
      const result = await rpcClient.readContract<
        readonly [
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          number,
          boolean,
        ]
      >({
        address: poolAddress,
        abi: CONCENTRATED_POOL_ABI,
        functionName: "ticks",
        args: [tick],
        blockNumber,
      });

      return {
        tick,
        liquidityGross: result[0],
        liquidityNet: result[1],
        initialized: result[7],
      };
    }),
  );

  for (const result of tickResults) {
    if (result.status === "fulfilled") {
      const { tick, liquidityGross, liquidityNet, initialized } = result.value;
      tickLiquidityMap.set(tick, { liquidityGross, liquidityNet, initialized });
    }
  }

  return {
    sqrtPriceX96,
    currentTick,
    activeLiquidity: liquidityResult,
    tickSpacing,
    fee: Number(feeResult),
    token0: token0Result,
    token1: token1Result,
    tickLiquidityMap,
    blockNumber,
  };
}

// ---------------------------------------------------------------------------
// Core: Detect Liquidity Manipulation
// ---------------------------------------------------------------------------

/**
 * Analyzes the pool state for manipulation signals.
 *
 * Returns detected anomalies and their severity.
 */
function detectLiquidityManipulation(
  poolState: ConcentratedPoolState,
  tradeAmountUsd: number,
  config: AMMPoolAnalyzerConfig,
): {
  thinLiquidity: boolean;
  estimatedDepthUsd: number;
  tickGapManipulation: boolean;
  maxTickGap: number;
  priceDeviation: boolean;
  priceDeviationRatio: number;
  oneSidedLiquidity: boolean;
  asymmetryRatio: number;
  flags: RiskFlag[];
} {
  const flags: RiskFlag[] = [];

  // ------------------------------------------------------------------
  // 1. THIN LIQUIDITY DETECTION
  // ------------------------------------------------------------------
  // Estimate USD liquidity around the current tick.
  //
  // For concentrated liquidity, the available liquidity for a swap
  // is determined by the `liquidity` value active at the current tick.
  // A rough USD estimate: liquidity × 2 × (sqrtPrice) / 2^96
  // This is simplified — real math involves the tick range and
  // token decimals, but it gives us an order-of-magnitude check.

  const sqrtPrice = Number(poolState.sqrtPriceX96) / 2 ** 96;
  // Very rough USD estimate based on active liquidity
  // Real implementation would use token prices from an oracle
  const estimatedDepthUsd =
    (Number(poolState.activeLiquidity) * sqrtPrice * 2) / 1e18;

  const thinLiquidity =
    poolState.activeLiquidity === 0n ||
    estimatedDepthUsd < config.minLiquidityDepthUsd;

  if (thinLiquidity) {
    const severity: RiskSeverity =
      poolState.activeLiquidity === 0n ? "critical" : "high";

    const depthStr = Math.round(estimatedDepthUsd) === 0 ? "(USD pricing unavailable)" : `$${Math.round(estimatedDepthUsd).toLocaleString()}`;
    const tradeStr = Math.round(tradeAmountUsd) === 0 ? "(USD pricing unavailable)" : `$${Math.round(tradeAmountUsd).toLocaleString()}`;

    flags.push(
      createFlag(
        RiskFlagCode.AMM_THIN_LIQUIDITY,
        severity,
        poolState.activeLiquidity === 0n
          ? `CRITICAL: Zero active liquidity at the current tick (${poolState.currentTick}). ` +
              `The pool has no liquidity available for trading at the current price. ` +
              `This means ANY swap will experience catastrophic price impact, ` +
              `moving the price to the next initialized tick. ` +
              `DO NOT execute this trade.`
          : `Thin liquidity detected around current tick. Estimated depth: ` +
              `${depthStr} ` +
              `(minimum required: $${config.minLiquidityDepthUsd.toLocaleString()}). ` +
              `Trade size (${tradeStr}) may ` +
              `experience excessive price impact. ` +
              `The liquidity may have been intentionally removed to create ` +
              `a manipulation opportunity.`,
      ),
    );
  }

  // ------------------------------------------------------------------
  // 2. TICK GAP MANIPULATION DETECTION
  // ------------------------------------------------------------------
  // Scan for gaps between initialized ticks near the current price.
  // Large gaps mean liquidity has been removed in a narrow band,
  // creating price "cliffs" that can be exploited.

  const initializedTicks: number[] = [];
  for (const [tick, data] of poolState.tickLiquidityMap) {
    if (data.initialized) {
      initializedTicks.push(tick);
    }
  }
  initializedTicks.sort((a, b) => a - b);

  let maxTickGap = 0;
  let maxGapLocation = 0;

  if (initializedTicks.length >= 2) {
    for (let i = 1; i < initializedTicks.length; i++) {
      const gap =
        (initializedTicks[i]! - initializedTicks[i - 1]!) /
        poolState.tickSpacing;

      if (gap > maxTickGap) {
        maxTickGap = gap;
        maxGapLocation = initializedTicks[i - 1]!;
      }
    }
  }

  const tickGapManipulation = maxTickGap >= config.maxTickGapMultiplier;

  if (tickGapManipulation) {
    // Check if the gap is near the current price (within scan range)
    const gapNearCurrentPrice =
      Math.abs(maxGapLocation - poolState.currentTick) <
      config.tickScanRange * poolState.tickSpacing;

    flags.push(
      createFlag(
        RiskFlagCode.AMM_TICK_GAP_MANIPULATION,
        gapNearCurrentPrice ? "high" : "medium",
        `Tick gap manipulation detected: ${maxTickGap}× tick spacing gap ` +
          `(threshold: ${config.maxTickGapMultiplier}× = ${config.maxTickGapMultiplier * poolState.tickSpacing} ticks). ` +
          `Maximum gap found at tick ${maxGapLocation}, ${gapNearCurrentPrice ? "NEAR" : "away from"} the current price (tick ${poolState.currentTick}). ` +
          `${
            gapNearCurrentPrice
              ? "Liquidity has been strategically removed near the current price, " +
                "creating a price cliff that could cause catastrophic slippage."
              : "Large tick gap exists but is not immediately adjacent to the current price. " +
                "Monitor for liquidity shifts that could bring the gap closer."
          }`,
      ),
    );
  }

  // ------------------------------------------------------------------
  // 3. sqrtPriceX96 DEVIATION DETECTION
  // ------------------------------------------------------------------
  // Compare the current sqrtPriceX96 against a "fair" value derived
  // from the tick index. If they're inconsistent, the price may have
  // been manipulated within the current block.
  //
  // Fair sqrtPriceX96 from tick: sqrt(1.0001^tick) × 2^96
  // This is the theoretical price at the given tick.

  const theoreticalPrice = Math.sqrt(1.0001 ** poolState.currentTick);
  const actualPrice = sqrtPrice;

  let priceDeviationRatio = 0;
  if (theoreticalPrice > 0) {
    priceDeviationRatio = Math.abs(
      (actualPrice - theoreticalPrice) / theoreticalPrice,
    );
  }

  const priceDeviation = priceDeviationRatio > config.maxPriceDeviationRatio;

  if (priceDeviation) {
    flags.push(
      createFlag(
        RiskFlagCode.AMM_PRICE_DEVIATION,
        priceDeviationRatio > config.maxPriceDeviationRatio * 2
          ? "high"
          : "medium",
        `sqrtPriceX96 deviation detected: ${(priceDeviationRatio * 100).toFixed(2)}% ` +
          `deviation from theoretical tick price ` +
          `(threshold: ${(config.maxPriceDeviationRatio * 100).toFixed(1)}%). ` +
          `Current sqrtPriceX96: ${poolState.sqrtPriceX96.toString()}, ` +
          `Current tick: ${poolState.currentTick}. ` +
          `This deviation may indicate intra-block price manipulation, ` +
          `a flash loan attack in progress, or oracle price feed divergence. ` +
          `The trade price may not reflect the true market value.`,
      ),
    );
  }

  // ------------------------------------------------------------------
  // 4. ONE-SIDED LIQUIDITY DETECTION
  // ------------------------------------------------------------------
  // Compare liquidity above vs below the current tick.
  // Heavy asymmetry suggests a coordinated position.

  let liquidityAbove = 0n;
  let liquidityBelow = 0n;

  for (const [tick, data] of poolState.tickLiquidityMap) {
    if (data.initialized && data.liquidityGross > 0n) {
      if (tick > poolState.currentTick) {
        liquidityAbove += data.liquidityGross;
      } else if (tick < poolState.currentTick) {
        liquidityBelow += data.liquidityGross;
      }
    }
  }

  let asymmetryRatio = 1.0;
  if (liquidityAbove > 0n && liquidityBelow > 0n) {
    const above = Number(liquidityAbove);
    const below = Number(liquidityBelow);
    asymmetryRatio = Math.max(above / below, below / above);
  } else if (liquidityAbove > 0n || liquidityBelow > 0n) {
    // One side has zero liquidity — extreme asymmetry
    asymmetryRatio = Infinity;
  }

  const oneSidedLiquidity =
    asymmetryRatio >= config.liquidityAsymmetryThreshold;

  if (oneSidedLiquidity) {
    const dominantSide = liquidityAbove > liquidityBelow ? "above" : "below";

    flags.push(
      createFlag(
        RiskFlagCode.AMM_ONESIDED_LIQUIDITY,
        asymmetryRatio >= config.liquidityAsymmetryThreshold * 2
          ? "high"
          : "medium",
        `One-sided liquidity detected: ${asymmetryRatio === Infinity ? "∞" : asymmetryRatio.toFixed(1)}:1 ` +
          `asymmetry ratio (threshold: ${config.liquidityAsymmetryThreshold}:1). ` +
          `Liquidity is heavily concentrated ${dominantSide} the current price. ` +
          `Above: ${liquidityAbove.toString()}, Below: ${liquidityBelow.toString()}. ` +
          `This asymmetric distribution may indicate: ` +
          `(1) a coordinated LP position preparing for a rug-pull, ` +
          `(2) an imminent large sell/buy order that will exploit the thin side, or ` +
          `(3) organic market maker activity (less likely at this ratio). ` +
          `Swaps in the direction of thin liquidity will experience amplified price impact.`,
      ),
    );
  }

  return {
    thinLiquidity,
    estimatedDepthUsd,
    tickGapManipulation,
    maxTickGap,
    priceDeviation,
    priceDeviationRatio,
    oneSidedLiquidity,
    asymmetryRatio,
    flags,
  };
}

// ---------------------------------------------------------------------------
// Score Computation
// ---------------------------------------------------------------------------

function computeAMMPoolScore(flags: RiskFlag[]): number {
  if (flags.some((f) => f.severity === "critical")) return 0;

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
// Main Export: analyzeAMMPoolRisk()
// ---------------------------------------------------------------------------

/**
 * The primary entry point for AMM concentrated liquidity pool analysis.
 *
 * Reads the exact on-chain state of a concentrated liquidity pool
 * and analyzes it for manipulation signals:
 *   - Thin liquidity at the current tick
 *   - Artificial tick gaps near the current price
 *   - sqrtPriceX96 deviation from theoretical fair value
 *   - One-sided liquidity distribution
 *
 * @param poolAddress      - The concentrated liquidity pool contract address
 * @param tradeAmountUsd   - The trade size in USD (for liquidity depth comparison)
 * @param chainId          - HashKey Chain ID
 * @param config           - Optional custom thresholds
 * @param rpcClient        - Optional pre-configured RPC client (for DI)
 */
export async function analyzeAMMPoolRisk(
  poolAddress: Address,
  tradeAmountUsd: number,
  chainId: SupportedChainId = 177,
  config: Partial<AMMPoolAnalyzerConfig> = {},
  rpcClient?: HashKeyRPCClient,
): Promise<AnalyzerResult> {
  const ANALYZER_NAME = "amm-pool-analyzer";
  const startTime = performance.now();
  const resolvedConfig = { ...DEFAULT_AMM_CONFIG, ...config };
  const flags: RiskFlag[] = [];

  logger.info(`[${ANALYZER_NAME}] Starting AMM pool analysis`, {
    poolAddress,
    tradeAmountUsd,
    chainId,
    tickScanRange: resolvedConfig.tickScanRange,
  });

  try {
    const rpc = rpcClient ?? new HashKeyRPCClient(chainId);

    // ------------------------------------------------------------------
    // Step 1: Read pool state
    // ------------------------------------------------------------------
    const poolState = await readConcentratedLiquidityState(
      rpc,
      poolAddress,
      resolvedConfig.tickScanRange,
    );

    logger.info(`[${ANALYZER_NAME}] Pool state read complete`, {
      sqrtPriceX96: poolState.sqrtPriceX96.toString(),
      currentTick: poolState.currentTick,
      activeLiquidity: poolState.activeLiquidity.toString(),
      tickSpacing: poolState.tickSpacing,
      fee: poolState.fee,
      initializedTicks: [...poolState.tickLiquidityMap.entries()].filter(
        ([, d]) => d.initialized,
      ).length,
    });

    // ------------------------------------------------------------------
    // Step 2: Run detection heuristics + Uniswap AI enrichment in parallel
    // ------------------------------------------------------------------
    const manipulationResults = detectLiquidityManipulation(
      poolState,
      tradeAmountUsd,
      resolvedConfig,
    );

    flags.push(...manipulationResults.flags);

    // ------------------------------------------------------------------
    // Step 2b: Uniswap AI Skills Enrichment
    // Adds TWAP oracle deviation analysis and V4 hook security assessment.
    // Runs non-blocking — enrichment failure never blocks the pipeline.
    // References: Uniswap/uniswap-ai (swap-integration, v4-security-foundations)
    // ------------------------------------------------------------------
    let uniswapEnrichment: UniswapPoolEnrichment | null = null;
    try {
      uniswapEnrichment = await enrichWithUniswapAI(
        poolAddress,
        chainId,
        rpc,
      );
      if (uniswapEnrichment.flags.length > 0) {
        flags.push(...uniswapEnrichment.flags);
        logger.info(`[${ANALYZER_NAME}] Uniswap AI enrichment added ${uniswapEnrichment.flags.length} flag(s)`, {
          oracleManipulation: uniswapEnrichment.oracleManipulationDetected,
          hasV4Hook: uniswapEnrichment.hasV4Hook,
        });
      }
    } catch (err) {
      logger.debug(`[${ANALYZER_NAME}] Uniswap AI enrichment failed (non-fatal)`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ------------------------------------------------------------------
    // Step 3: Compute score
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

    const score = computeAMMPoolScore(flags);
    const durationMs = Math.round(performance.now() - startTime);

    // ------------------------------------------------------------------
    // Step 4: Assemble report
    // ------------------------------------------------------------------
    const report: AMMPoolReport & { uniswapAIEnrichment?: UniswapPoolEnrichment | null } = {
      poolReadSuccess: true,
      poolAddress,
      sqrtPriceX96: poolState.sqrtPriceX96.toString(),
      currentTick: poolState.currentTick,
      activeLiquidity: poolState.activeLiquidity.toString(),
      estimatedLiquidityDepthUsd: manipulationResults.estimatedDepthUsd,
      thinLiquidityDetected: manipulationResults.thinLiquidity,
      tickGapManipulationDetected: manipulationResults.tickGapManipulation,
      maxTickGap: manipulationResults.maxTickGap,
      priceDeviationDetected: manipulationResults.priceDeviation,
      priceDeviationRatio: manipulationResults.priceDeviationRatio,
      oneSidedLiquidityDetected: manipulationResults.oneSidedLiquidity,
      liquidityAsymmetryRatio: manipulationResults.asymmetryRatio,
      uniswapAIEnrichment: uniswapEnrichment,
      flags,
      score,
    };

    // ------------------------------------------------------------------
    // Step 5: Log verdict
    // ------------------------------------------------------------------
    if (score < 50) {
      logger.warn(`[${ANALYZER_NAME}] ⚠️  AMM pool risks detected`, {
        score,
        thinLiquidity: manipulationResults.thinLiquidity,
        tickGapManipulation: manipulationResults.tickGapManipulation,
        priceDeviation: manipulationResults.priceDeviation,
        oneSidedLiquidity: manipulationResults.oneSidedLiquidity,
        flagCount: flags.length,
        durationMs,
      });
    } else {
      logger.info(`[${ANALYZER_NAME}] ✅ AMM pool analysis complete`, {
        score,
        estimatedDepthUsd: Math.round(manipulationResults.estimatedDepthUsd),
        flagCount: flags.length,
        durationMs,
      });
    }

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

    logger.error(
      `[${ANALYZER_NAME}] ❌ AMM pool analysis FAILED — returning degraded score`,
      {
        error: errorMessage,
        durationMs,
      },
    );

    // AMM pool analysis failure is non-fatal — the trade might still be
    // safe, we just can't confirm pool health. Guardian fails closed here:
    // if pool state cannot be read, we should not treat the trade as safe.
    const errorFlag = createFlag(
      RiskFlagCode.AMM_READ_FAILED,
      "high",
      `AMM pool analysis failed: ${errorMessage}. ` +
        `Could not read pool state to verify liquidity health. ` +
        `The pool may not exist, may not be a Uniswap V3 compatible pool, ` +
        `or the RPC endpoint may be unavailable. ` +
        `Guardian fails CLOSED in this situation because concentrated ` +
        `liquidity conditions are unverified.`,
    );

    return {
      analyzerName: ANALYZER_NAME,
      flags: [errorFlag],
      score: 0,
      durationMs,
      data: {
        error: true,
        errorCode: ErrorCode.ANALYZER_ERROR,
        errorMessage,
        poolAddress,
        poolReadSuccess: false,
      },
    };
  }
}
