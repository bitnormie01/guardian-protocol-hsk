// ============================================================
// Guardian Protocol — Input Types
// The contract between a calling agent and Guardian Protocol.
// ============================================================

/**
 * Supported chain IDs for Guardian Protocol.
 * X Layer mainnet = 196, X Layer testnet = 195.
 */
export type SupportedChainId = 196 | 195;

/**
 * EVM hex-encoded address (checksummed or lowercase).
 */
export type Address = `0x${string}`;

/**
 * Raw hex-encoded transaction data.
 */
export type HexString = `0x${string}`;

/**
 * Optional quote/routing context supplied by the caller.
 * This lets Guardian consume a pre-fetched DEX quote instead of
 * resolving it internally on every evaluation.
 */
export interface QuoteContext {
  /** Expected output amount in raw token units (smallest denomination). */
  expectedOutputAmountRaw?: string;

  /** Output token decimals associated with expectedOutputAmountRaw. */
  tokenOutDecimals?: number;

  /** Caller-provided USD estimate for the trade notional. */
  estimatedUsd?: number;

  /**
   * Best-effort router target for simulation or execution.
   * This is optional because quote APIs do not always expose it.
   */
  routerAddress?: Address;

  /** Human-readable source for auditability (e.g. "okx-dex-quote"). */
  routeSource?: string;
}

/**
 * The primary input payload that a calling agent sends
 * to Guardian Protocol for evaluation.
 */
export interface GuardianEvaluationRequest {
  /** The token contract address being sold / swapped from. */
  tokenIn: Address;

  /** The token contract address being purchased / swapped to. */
  tokenOut: Address;

  /**
   * DEPRECATED alias for `amountRaw`.
   *
   * Historically this field was ambiguously documented. Guardian now
   * treats it as raw token units for backward compatibility.
   */
  amount?: string;

  /**
   * The amount of `tokenIn` to swap in raw token units (smallest denomination).
   * Example: 1.0 USDC (6 decimals) => "1000000".
   */
  amountRaw?: string;

  /**
   * Decimal precision for tokenIn.
   * Strongly recommended because it lets Guardian normalize the amount
   * without guessing or making extra RPC calls.
   */
  tokenInDecimals?: number;

  /**
   * Optional decimal precision for tokenOut.
   * If omitted, Guardian will infer it from quote or on-chain metadata.
   */
  tokenOutDecimals?: number;

  /** The wallet address of the end-user initiating the trade. */
  userAddress: Address;

  /**
   * Optional raw hex-encoded transaction payload already
   * constructed by the calling agent's DEX integration.
   * If provided, Guardian will simulate THIS exact tx.
   * If omitted, Guardian builds its own optimized route.
   */
  proposedTxHex?: HexString;

  /**
   * The contract address that `proposedTxHex` is intended to call.
   * Required for accurate transaction simulation when proposedTxHex is provided.
   */
  proposedTxTarget?: Address;

  /** Chain ID — defaults to 196 (X Layer mainnet). */
  chainId?: SupportedChainId;

  /**
   * Optional: maximum acceptable slippage in basis points.
   * 50 = 0.50%. Defaults to skill-level configuration.
   */
  maxSlippageBps?: number;

  /**
   * Optional pre-resolved concentrated liquidity pool address.
   * If supplied, Guardian will use this directly for AMM analysis.
   */
  poolAddress?: Address;

  /**
   * Optional pre-fetched quote/routing context from an upstream DEX integration.
   */
  quoteContext?: QuoteContext;

  /**
   * Optional: the calling agent's identity for audit trail.
   */
  callerAgentId?: string;
}

/**
 * Simplified input for token-only scanning
 * (no swap context needed).
 */
export interface TokenScanRequest {
  /** The token contract address to scan. */
  tokenAddress: Address;

  /** Chain ID — defaults to 196 (X Layer mainnet). */
  chainId?: SupportedChainId;
}

/**
 * Input for standalone transaction simulation.
 */
export interface TxSimulationRequest {
  /** The raw transaction hex to simulate. */
  proposedTxHex: HexString;

  /** The originating wallet address. */
  userAddress: Address;

  /** The destination contract address. */
  targetAddress?: Address;

  /** Chain ID — defaults to 196 (X Layer mainnet). */
  chainId?: SupportedChainId;
}
