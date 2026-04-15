// ============================================================
// Guardian Protocol — HashKey Chain API Response Types
// Typed wrappers for GoPlus Security API & DEX API responses.
// GoPlus is the PRIMARY security data source for HashKey Chain.
// ============================================================

/**
 * Standard API response envelope (compatible with GoPlus / legacy GoPlus isRiskTokenshape).
 */
export interface ApiResponse<T> {
  code: string;
  msg: string;
  data: T[];
}

/**
 * Token Security scan result.
 *
 * On HashKey Chain, the GoPlus Security API is the PRIMARY data source:
 *   https://api.gopluslabs.io/api/v1/token_security/177
 *
 * The response shape is normalized to match our internal interface.
 * Fields that are not returned by the API will be undefined.
 */
export interface TokenSecurityData {
  chainId: string;
  tokenAddress: string;
  isChainSupported: boolean;

  // ---- Top-level risk flag ----
  /** Consolidated risk signal. True = do NOT trade. */
  isRiskToken: boolean;

  // ---- Tax data ----
  /** Buy tax as a percentage string (e.g. "5.0"). May be "0" for clean tokens. */
  buyTaxes: string;
  /** Sell tax as a percentage string (e.g. "10.0"). May be "0" for clean tokens. */
  sellTaxes: string;

  // ---- Granular risk signals ----
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
 * DEX quote/swap response shape.
 */
export interface DexQuoteData {
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
 * Transaction pre-execution simulation result.
 * Uses GoPlus contract security / transaction simulation on HashKey Chain.
 */
export interface TxSimulationData {
  /** Verdict on the transaction. "" = safe, "warn" = warning, "block" = danger. */
  action: "" | "warn" | "block";
  /** Array of individual risk items that explain the verdict. */
  riskItemDetail: Array<{
    riskLevel: string;
    riskItem: string;
    desc: string;
  }>;
}
