// ============================================================
// Guardian Protocol — OKX OnchainOS API Response Types
// Typed wrappers for the OKX Security & DEX API responses.
// ============================================================

/**
 * Standard OKX API envelope.
 */
export interface OKXApiResponse<T> {
  code: string;
  msg: string;
  data: T[];
}

/**
 * OKX Token Security scan result (API v6 — /api/v6/security/token-scan).
 *
 * The v6 API returns a richer payload than v5. All fields below are
 * present in live API responses. The critical top-level signal is
 * `isRiskToken` — when true, GoPlus enrichment is used to determine
 * the SPECIFIC risk reason (honeypot, blacklist, etc.).
 *
 * Fields that are not returned by the API will be undefined.
 */
export interface OKXTokenSecurityData {
  chainId: string;
  tokenAddress: string;
  isChainSupported: boolean;

  // ---- Top-level OKX risk flag ----
  /** OKX OnchainOS consolidated risk signal. True = do NOT trade. */
  isRiskToken: boolean;

  // ---- Tax data ----
  /** Buy tax as a percentage string (e.g. "5.0"). May be "0" for clean tokens. */
  buyTaxes: string;
  /** Sell tax as a percentage string (e.g. "10.0"). May be "0" for clean tokens. */
  sellTaxes: string;

  // ---- Granular risk signals (returned alongside isRiskToken) ----
  /** True if the token has been confirmed as a honeypot (sell is blocked). */
  isHoneypot?: boolean;
  /** True if the contract has a blacklist/blocklist function. */
  hasBlacklist?: boolean;
  /** True if the contract owner can mint additional tokens. */
  isMintable?: boolean;
  /** True if the contract source code is verified on-chain explorer. */
  isOpenSource?: boolean;
  /** True if the contract uses a proxy/upgradeable pattern. */
  isProxy?: boolean;
  /** Number of unique token holders. Low count signals a new/abandoned token. */
  holderCount?: number;
  /** Total token supply as a decimal string. */
  totalSupply?: string;
  /** Owner address. Zero address means ownership was renounced. */
  ownerAddress?: string;
  /** Human-readable token name (e.g. "USD Coin"). */
  tokenName?: string;
  /** Token ticker symbol (e.g. "USDC"). */
  tokenSymbol?: string;
}

/**
 * OKX DEX quote/swap response shape.
 */
export interface OKXDexQuoteData {
  chainIndex: string;
  swapMode: "exactIn" | "exactOut";
  fromTokenAmount: string;
  toTokenAmount: string;
  tradeFee?: string;
  estimateGasFee?: string;
  router?: string;
  priceImpactPercent?: string;
  dexRouterList: Array<{
    dexProtocol?: {
      dexName?: string;
      percent?: string;
    };
    dexName?: string;
    percent?: string;
    fromTokenIndex?: string;
    toTokenIndex?: string;
    fromToken: {
      tokenContractAddress: string;
      tokenSymbol: string;
      tokenUnitPrice?: string | null;
      decimal: string;
      isHoneyPot?: boolean;
      taxRate?: string;
    };
    toToken: {
      tokenContractAddress: string;
      tokenSymbol: string;
      tokenUnitPrice?: string | null;
      decimal: string;
      isHoneyPot?: boolean;
      taxRate?: string;
    };
    amountOut?: string;
    tradeFee?: string;
    priceImpactPercent?: string;
  }>;
}

/**
 * OKX transaction pre-execution simulation result
 * (API v6 — /api/v6/security/transaction-scan/evm).
 *
 * The v6 API uses `action` (not `riskLevel`) to convey the verdict,
 * and `riskItemDetail` (not `riskMessages`) for individual risk reasons.
 * Balance changes are no longer returned by the v6 API.
 */
export interface OKXTxSimulationData {
  /** OKX verdict on the transaction. "" = safe, "warn" = warning, "block" = danger. */
  action: "" | "warn" | "block";
  /** Array of individual risk items that explain the verdict. */
  riskItemDetail: Array<{
    riskLevel: string;
    riskItem: string;
    desc: string;
  }>;
}
