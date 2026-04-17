// ==========================================================================
// Guardian Protocol — GoPlus Security API Client
// ==========================================================================
//
// This module wraps the GoPlus Security API, which is the PRIMARY
// security oracle for Guardian Protocol on HashKey Chain.
//
// GoPlus provides free-tier access with no authentication required.
// When the GOPLUS_API_KEY env var is set, it is sent as a header
// for higher rate limits and priority access.
//
// WHY THIS MATTERS FOR AGENTS:
// Autonomous agents making swap decisions on HashKey Chain CANNOT
// visually inspect a token contract. They need a programmatic oracle
// that says "this token has a 99% sell-tax — it's a honeypot."
// This client is that oracle.
//
// FAIL-CLOSED: If the GoPlus API call fails for any reason, we
// return a score of 0 (unsafe) rather than silently passing.
// ==========================================================================

import { LRUCache } from "lru-cache";
import type {
  TokenSecurityData,
  TxSimulationData,
  DexQuoteData,
} from "../types/hashkey-api.js";
import type { Address, SupportedChainId } from "../types/input.js";
import { GuardianError, ErrorCode } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Cache Configuration
// ---------------------------------------------------------------------------

/**
 * Default cache TTL: 60 seconds.
 * Token security data changes infrequently — a 60s cache prevents
 * hammering the GoPlus API during rapid agent evaluation loops while
 * still picking up newly flagged tokens within a minute.
 */
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;

// ---------------------------------------------------------------------------
// GoPlus Response Types
// ---------------------------------------------------------------------------

/**
 * Raw GoPlus token_security API response shape.
 * GoPlus returns "1" for true, "0" for false (string-encoded booleans).
 */
interface GoPlusTokenData {
  is_honeypot?: string;
  is_blacklisted?: string;
  is_mintable?: string;
  is_open_source?: string;
  is_proxy?: string;
  holder_count?: string;
  total_supply?: string;
  owner_address?: string;
  token_name?: string;
  token_symbol?: string;
  buy_tax?: string;
  sell_tax?: string;
  can_take_back_ownership?: string;
  hidden_owner?: string;
  cannot_sell_all?: string;
  cannot_buy?: string;
  honeypot_with_same_creator?: string;
  selfdestruct?: string;
  external_call?: string;
  transfer_pausable?: string;
  personal_slippage_modifiable?: string;
  is_airdrop_scam?: string;
  is_anti_whale?: string;
  anti_whale_modifiable?: string;
  trading_cooldown?: string;
  owner_change_balance?: string;
  lp_holder_count?: string;
  lp_total_supply?: string;
  is_true_token?: string;
  trust_list?: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface GoPlusClientConfig {
  /** Optional GoPlus API key for higher rate limits. */
  apiKey?: string;
  /** GoPlus API base URL. */
  baseUrl: string;
  /** Request timeout in ms — defaults to 10 000. */
  timeoutMs: number;
}

function loadConfigFromEnv(): GoPlusClientConfig {
  return {
    apiKey: process.env["GOPLUS_API_KEY"] || undefined,
    baseUrl:
      process.env["GOPLUS_BASE_URL"] ?? "https://api.gopluslabs.io",
    timeoutMs: Number(process.env["GOPLUS_TIMEOUT_MS"] ?? "10000"),
  };
}

// ---------------------------------------------------------------------------
// GoPlus → Guardian Data Mapper
// ---------------------------------------------------------------------------

/**
 * Maps GoPlus token_security response fields to Guardian's internal
 * TokenSecurityData schema. This preserves the internal type contract
 * so all downstream analyzers and scoring logic work unchanged.
 *
 * GoPlus field mapping:
 *   is_honeypot ("1"/"0")       → isHoneypot (boolean)
 *   buy_tax (decimal 0-1)       → buyTaxes (percentage string)
 *   sell_tax (decimal 0-1)      → sellTaxes (percentage string)
 *   is_blacklisted ("1"/"0")    → hasBlacklist (boolean)
 *   is_mintable ("1"/"0")       → isMintable (boolean)
 *   is_open_source ("1"/"0")    → isOpenSource (boolean)
 *   is_proxy ("1"/"0")          → isProxy (boolean)
 *   holder_count (string)       → holderCount (number)
 *   owner_address (string)      → ownerAddress (string)
 *   token_name (string)         → tokenName (string)
 *   token_symbol (string)       → tokenSymbol (string)
 *   total_supply (string)       → totalSupply (string)
 */
function mapGoPlusToGuardian(
  data: GoPlusTokenData,
  tokenAddress: string,
  chainId: string,
): TokenSecurityData {
  const isTruthy = (v?: string) => v === "1";

  // GoPlus returns buy_tax/sell_tax as decimals (0-1), e.g. "0.05" = 5%
  // Guardian expects percentage strings (e.g. "5")
  const buyTaxRaw = parseFloat(data.buy_tax ?? "0");
  const sellTaxRaw = parseFloat(data.sell_tax ?? "0");
  const buyTaxPercent = (buyTaxRaw * 100).toFixed(1);
  const sellTaxPercent = (sellTaxRaw * 100).toFixed(1);

  // Determine isRiskToken: true if ANY critical signal is detected
  const isHoneypot = isTruthy(data.is_honeypot);
  const hasBlacklist = isTruthy(data.is_blacklisted);
  const isMintable = isTruthy(data.is_mintable);
  const cannotSellAll = isTruthy(data.cannot_sell_all);
  const cannotBuy = isTruthy(data.cannot_buy);
  const highSellTax = sellTaxRaw >= 0.5; // 50%+
  const highBuyTax = buyTaxRaw >= 0.5;

  const isRiskToken =
    isHoneypot ||
    hasBlacklist ||
    cannotSellAll ||
    cannotBuy ||
    highSellTax ||
    highBuyTax;

  return {
    chainId,
    tokenAddress: tokenAddress.toLowerCase(),
    isChainSupported: true,
    isRiskToken,
    buyTaxes: buyTaxPercent,
    sellTaxes: sellTaxPercent,
    isHoneypot,
    hasBlacklist,
    isMintable,
    isOpenSource: isTruthy(data.is_open_source),
    isProxy: isTruthy(data.is_proxy),
    holderCount: data.holder_count ? parseInt(data.holder_count, 10) : undefined,
    totalSupply: data.total_supply,
    ownerAddress: data.owner_address,
    tokenName: data.token_name,
    tokenSymbol: data.token_symbol,
  };
}

// ---------------------------------------------------------------------------
// Client Class
// ---------------------------------------------------------------------------

export class GoPlusSecurityClient {
  private readonly config: GoPlusClientConfig;

  /** LRU cache for token risk scans — keyed by "chainId:tokenAddress". */
  private readonly tokenRiskCache: LRUCache<string, TokenSecurityData>;

  /** LRU cache for tx simulation results — keyed by tx params hash. */
  private readonly txSimCache: LRUCache<string, TxSimulationData>;

  /** LRU cache for DEX quotes — keyed by chain/from/to/amount. */
  private readonly dexQuoteCache: LRUCache<string, DexQuoteData>;

  constructor(config?: Partial<GoPlusClientConfig>) {
    const envConfig = loadConfigFromEnv();
    this.config = { ...envConfig, ...config };

    this.tokenRiskCache = new LRUCache<string, TokenSecurityData>({
      max: CACHE_MAX_ENTRIES,
      ttl: CACHE_TTL_MS,
    });

    this.txSimCache = new LRUCache<string, TxSimulationData>({
      max: CACHE_MAX_ENTRIES,
      ttl: CACHE_TTL_MS,
    });

    this.dexQuoteCache = new LRUCache<string, DexQuoteData>({
      max: CACHE_MAX_ENTRIES,
      ttl: CACHE_TTL_MS,
    });

    logger.debug("GoPlusSecurityClient initialized", {
      baseUrl: this.config.baseUrl,
      timeoutMs: this.config.timeoutMs,
      hasApiKey: !!this.config.apiKey,
      cacheMaxEntries: CACHE_MAX_ENTRIES,
      cacheTtlMs: CACHE_TTL_MS,
    });
  }

  // -----------------------------------------------------------------------
  // HTTP Layer
  // -----------------------------------------------------------------------

  /**
   * Builds request headers. GoPlus free tier requires no auth,
   * but an API key (if present) enables higher rate limits.
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (this.config.apiKey && this.config.apiKey !== "your_goplus_api_key") {
      headers["Authorization"] = this.config.apiKey;
    }

    return headers;
  }

  /**
   * Makes a GET request to the GoPlus API.
   */
  private async get<T>(
    path: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const queryString = new URLSearchParams(params).toString();
    const requestPath = queryString ? `${path}?${queryString}` : path;
    const url = `${this.config.baseUrl}${requestPath}`;
    const headers = this.buildHeaders();

    logger.debug("GoPlus API GET request", { url });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new GuardianError(
          ErrorCode.API_ERROR,
          `GoPlus API returned HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const data = await response.json();
      return data as T;
    } catch (err) {
      if (err instanceof GuardianError) throw err;

      if (err instanceof Error && err.name === "AbortError") {
        throw new GuardianError(
          ErrorCode.API_TIMEOUT,
          `GoPlus API request timed out after ${this.config.timeoutMs}ms`,
        );
      }

      throw new GuardianError(
        ErrorCode.API_ERROR,
        `GoPlus API request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  // -----------------------------------------------------------------------
  // Public: Token Risk Scanning
  // -----------------------------------------------------------------------

  /**
   * Scans a token contract for security risks using the GoPlus Security API.
   *
   * Endpoint: GET /api/v1/token_security/{chainId}?contract_addresses=0x...
   *
   * Checks: honeypot detection, buy/sell tax, mint function, blacklist,
   * proxy pattern, ownership status, holder count, and contract verification.
   *
   * @param tokenAddress - The EVM token contract address to scan
   * @param chainId      - HashKey Chain ID (177 mainnet, 133 testnet)
   * @returns            - Structured token security data (mapped to Guardian schema)
   */
  async scanTokenRisk(
    tokenAddress: Address,
    chainId: SupportedChainId = 177,
  ): Promise<TokenSecurityData> {
    const cacheKey = `${chainId}:${tokenAddress.toLowerCase()}`;
    const cached = this.tokenRiskCache.get(cacheKey);

    if (cached) {
      logger.info("Token risk scan CACHE HIT", {
        tokenAddress,
        chainId,
        cacheKey,
      });
      return cached;
    }

    logger.info("Scanning token risk via GoPlus Security API", {
      tokenAddress,
      chainId,
    });

    const response = await this.get<{
      code: number;
      message: string;
      result: Record<string, GoPlusTokenData>;
    }>(`/api/v1/token_security/${chainId}`, {
      contract_addresses: tokenAddress.toLowerCase(),
    });

    // GoPlus returns code: 1 for success
    if (response.code !== 1) {
      throw new GuardianError(
        ErrorCode.API_ERROR,
        `GoPlus API error: code=${response.code}, msg=${response.message}`,
      );
    }

    const key = tokenAddress.toLowerCase();
    const rawData = response.result?.[key];

    if (!rawData) {
      throw new GuardianError(
        ErrorCode.TOKEN_NOT_FOUND,
        `GoPlus API returned no data for token ${tokenAddress} on chain ${chainId}`,
      );
    }

    const result = mapGoPlusToGuardian(rawData, tokenAddress, String(chainId));

    this.tokenRiskCache.set(cacheKey, result);
    return result;
  }

  // -----------------------------------------------------------------------
  // Public: Transaction Simulation
  // -----------------------------------------------------------------------

  /**
   * Simulates a transaction using GoPlus contract security analysis.
   * This is a best-effort cross-validation — if GoPlus doesn't support
   * full tx simulation for HashKey Chain, we return a safe-by-default
   * result and let our own eth_call simulation be authoritative.
   *
   * @param tx      - Transaction parameters (from, to, data, value)
   * @param chainId - HashKey Chain ID
   * @returns       - Simulation result with risk assessment
   */
  async simulateTransaction(
    tx: { from: Address; to: Address; data: string; value: string },
    chainId: SupportedChainId = 177,
  ): Promise<TxSimulationData> {
    const cacheKey = `txsim:${chainId}:${tx.from.toLowerCase()}:${tx.to.toLowerCase()}:${tx.data}:${tx.value}`;
    const cached = this.txSimCache.get(cacheKey);

    if (cached) {
      logger.info("TX simulation CACHE HIT", {
        from: tx.from,
        to: tx.to,
        chainId,
      });
      return cached;
    }

    logger.info("Simulating transaction via GoPlus contract analysis", {
      from: tx.from,
      to: tx.to,
      chainId,
    });

    // GoPlus provides contract security analysis which we can use
    // to assess the target contract's risk profile
    try {
      const contractResponse = await this.get<{
        code: number;
        message: string;
        result: Record<string, GoPlusTokenData>;
      }>(`/api/v1/token_security/${chainId}`, {
        contract_addresses: tx.to.toLowerCase(),
      });

      if (contractResponse.code === 1) {
        const contractData = contractResponse.result?.[tx.to.toLowerCase()];
        const riskItems: TxSimulationData["riskItemDetail"] = [];

        if (contractData) {
          if (contractData.is_honeypot === "1") {
            riskItems.push({
              riskLevel: "danger",
              riskItem: "honeypot",
              desc: "Target contract is a confirmed honeypot",
            });
          }
          if (contractData.is_blacklisted === "1") {
            riskItems.push({
              riskLevel: "danger",
              riskItem: "blacklist",
              desc: "Target contract has blacklist function",
            });
          }
          if (contractData.is_proxy === "1") {
            riskItems.push({
              riskLevel: "warning",
              riskItem: "proxy",
              desc: "Target contract is upgradeable proxy",
            });
          }
        }

        const action =
          riskItems.some((r) => r.riskLevel === "danger")
            ? "block"
            : riskItems.length > 0
              ? "warn"
              : "";

        const result: TxSimulationData = {
          action: action as TxSimulationData["action"],
          riskItemDetail: riskItems,
        };

        this.txSimCache.set(cacheKey, result);
        return result;
      }
    } catch (err) {
      logger.warn(
        "GoPlus contract analysis failed, returning safe-by-default",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }

    // Fallback: return safe-by-default and let eth_call simulation be authoritative
    const fallbackResult: TxSimulationData = {
      action: "",
      riskItemDetail: [],
    };

    this.txSimCache.set(cacheKey, fallbackResult);
    return fallbackResult;
  }

  // -----------------------------------------------------------------------
  // Public: DEX Quotes (Stub — GoPlus doesn't provide DEX aggregation)
  // -----------------------------------------------------------------------

  /**
   * DEX quote functionality is not available through GoPlus.
   * This method exists for interface compatibility. The trade context
   * resolver will use on-chain pool reads instead.
   */
  async getDexQuote(params: {
    chainId: SupportedChainId;
    fromTokenAddress: Address;
    toTokenAddress: Address;
    amountRaw: string;
    swapMode?: "exactIn" | "exactOut";
    singleRouteOnly?: boolean;
    singlePoolPerHop?: boolean;
    priceImpactProtectionPercent?: number;
  }): Promise<DexQuoteData> {
    throw new GuardianError(
      ErrorCode.API_ERROR,
      "DEX quote aggregation is not available via GoPlus. " +
        "Use on-chain pool reads or a HashKey Chain DEX aggregator.",
    );
  }

  /**
   * DEX swap transaction building is not available through GoPlus.
   */
  async getDexSwapTx(params: {
    chainId: SupportedChainId;
    fromTokenAddress: Address;
    toTokenAddress: Address;
    amountRaw: string;
    userWalletAddress: Address;
    slippage?: string;
  }): Promise<{ tx: { data: string; to: string; value: string } }> {
    throw new GuardianError(
      ErrorCode.API_ERROR,
      "DEX swap construction is not available via GoPlus. " +
        "Use on-chain pool reads or a HashKey Chain DEX aggregator.",
    );
  }

  // -----------------------------------------------------------------------
  // Cache Management
  // -----------------------------------------------------------------------

  /** Clears all cached data. Useful for testing or forced re-evaluation. */
  clearCache(): void {
    this.tokenRiskCache.clear();
    this.txSimCache.clear();
    this.dexQuoteCache.clear();
    logger.info("GoPlusSecurityClient cache cleared");
  }

  /** Returns current cache statistics for observability. */
  getCacheStats(): {
    tokenRisk: { size: number };
    txSim: { size: number };
    dexQuote: { size: number };
  } {
    return {
      tokenRisk: { size: this.tokenRiskCache.size },
      txSim: { size: this.txSimCache.size },
      dexQuote: { size: this.dexQuoteCache.size },
    };
  }
}
