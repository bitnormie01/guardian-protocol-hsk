// ==========================================================================
// Guardian Protocol — OKX Security API Client
// ==========================================================================
//
// This module wraps the OKX OnchainOS Security API, which is the same
// backend that powers the `okx-security` skill in the onchainos-skills
// repo (token risk, DApp phishing, tx pre-execution, etc.).
//
// The OKX Security API uses HMAC-SHA256 request signing identical to
// the rest of the OKX v5 API family. We construct the signature from
// the timestamp + method + requestPath + body, then attach it along
// with the API key and passphrase in request headers.
//
// WHY THIS MATTERS FOR AGENTS:
// Autonomous agents making swap decisions on X Layer CANNOT visually
// inspect a token contract. They need a programmatic oracle that says
// "this token has a 99% sell-tax — it's a honeypot." This client is
// that oracle.
// ==========================================================================

import { createHmac } from "node:crypto";
import { LRUCache } from "lru-cache";
import type {
  OKXApiResponse,
  OKXDexQuoteData,
  OKXTokenSecurityData,
  OKXTxSimulationData,
} from "../types/okx-api.js";
import type { Address, SupportedChainId } from "../types/input.js";
import { GuardianError, ErrorCode } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Cache Configuration
// ---------------------------------------------------------------------------

/**
 * Default cache TTL: 60 seconds.
 * Token security data changes infrequently — a 60s cache prevents
 * hammering the OKX API during rapid agent evaluation loops while
 * still picking up newly flagged tokens within a minute.
 */
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;
const OKX_RATE_LIMIT_RPS = 2;
const OKX_RATE_LIMIT_WINDOW_MS = 1_000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * OKX API credentials loaded from environment variables.
 * In production these come from the agent's secure keyring;
 * the onchainos CLI can also inject them via .env or TEE signing.
 */
interface OKXSecurityClientConfig {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  projectId: string;
  /** Base URL — defaults to OKX Web3 API gateway. */
  baseUrl: string;
  /** Request timeout in ms — defaults to 10 000. */
  timeoutMs: number;
}

/**
 * Shared per-process rate limiter so Guardian does not exceed the
 * 3 requests/second budget across concurrent analyzer calls.
 */
class OKXApiRateLimiter {
  private static queue: Promise<void> = Promise.resolve();
  private static requestTimestamps: number[] = [];

  static async schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await OKXApiRateLimiter.waitForSlot();
      return fn();
    };

    const task = OKXApiRateLimiter.queue.then(run, run);
    OKXApiRateLimiter.queue = task.then(
      () => undefined,
      () => undefined,
    );

    return task;
  }

  private static async waitForSlot(): Promise<void> {
    while (true) {
      const now = Date.now();
      OKXApiRateLimiter.requestTimestamps =
        OKXApiRateLimiter.requestTimestamps.filter(
          (ts) => now - ts < OKX_RATE_LIMIT_WINDOW_MS,
        );

      if (OKXApiRateLimiter.requestTimestamps.length < OKX_RATE_LIMIT_RPS) {
        OKXApiRateLimiter.requestTimestamps.push(now);
        return;
      }

      const oldest = OKXApiRateLimiter.requestTimestamps[0]!;
      const waitMs =
        OKX_RATE_LIMIT_WINDOW_MS - (now - oldest) + 50; // Increased buffer
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/**
 * Loads config from environment, throwing clear errors if creds are missing.
 * This ensures a calling agent gets an immediate, actionable failure rather
 * than a cryptic 401 deep inside a request chain.
 */
function loadConfigFromEnv(): OKXSecurityClientConfig {
  const required = (key: string): string => {
    const value = process.env[key];
    if (!value) {
      throw new GuardianError(
        ErrorCode.CONFIG_MISSING,
        `Environment variable ${key} is required but not set. ` +
          `Ensure your OKX API credentials are configured in .env or ` +
          `injected by the onchainos CLI keyring.`,
      );
    }
    return value;
  };

  return {
    apiKey: required("OKX_API_KEY"),
    secretKey: required("OKX_SECRET_KEY"),
    passphrase: required("OKX_PASSPHRASE"),
    projectId: required("OKX_PROJECT_ID"),
    baseUrl: process.env["OKX_BASE_URL"] ?? "https://web3.okx.com",
    timeoutMs: Number(process.env["OKX_TIMEOUT_MS"] ?? "10000"),
  };
}

// ---------------------------------------------------------------------------
// Client Class
// ---------------------------------------------------------------------------

export class OKXSecurityClient {
  private readonly config: OKXSecurityClientConfig;

  /** LRU cache for token risk scans — keyed by "chainId:tokenAddress". */
  private readonly tokenRiskCache: LRUCache<string, OKXTokenSecurityData>;

  /** LRU cache for tx simulation results — keyed by tx params hash. */
  private readonly txSimCache: LRUCache<string, OKXTxSimulationData>;

  /** LRU cache for DEX quotes — keyed by chain/from/to/amount. */
  private readonly dexQuoteCache: LRUCache<string, OKXDexQuoteData>;

  constructor(config?: Partial<OKXSecurityClientConfig>) {
    const envConfig = loadConfigFromEnv();
    this.config = { ...envConfig, ...config };

    this.tokenRiskCache = new LRUCache<string, OKXTokenSecurityData>({
      max: CACHE_MAX_ENTRIES,
      ttl: CACHE_TTL_MS,
    });

    this.txSimCache = new LRUCache<string, OKXTxSimulationData>({
      max: CACHE_MAX_ENTRIES,
      ttl: CACHE_TTL_MS,
    });

    this.dexQuoteCache = new LRUCache<string, OKXDexQuoteData>({
      max: CACHE_MAX_ENTRIES,
      ttl: CACHE_TTL_MS,
    });

    logger.debug("OKXSecurityClient initialized", {
      baseUrl: this.config.baseUrl,
      timeoutMs: this.config.timeoutMs,
      cacheMaxEntries: CACHE_MAX_ENTRIES,
      cacheTtlMs: CACHE_TTL_MS,
    });
  }

  // -----------------------------------------------------------------------
  // Request Signing
  // -----------------------------------------------------------------------

  /**
   * Generates the HMAC-SHA256 signature required by OKX's API.
   *
   * The pre-hash string is: timestamp + method + requestPath + body
   * The signature is Base64-encoded.
   */
  private signRequest(
    timestamp: string,
    method: string,
    requestPath: string,
    body: string,
  ): string {
    const preHash = timestamp + method.toUpperCase() + requestPath + body;
    return createHmac("sha256", this.config.secretKey)
      .update(preHash)
      .digest("base64");
  }

  /**
   * Builds the standard OKX API headers for an authenticated request.
   */
  private buildHeaders(
    timestamp: string,
    method: string,
    requestPath: string,
    body: string,
  ): Record<string, string> {
    const signature = this.signRequest(timestamp, method, requestPath, body);

    return {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": this.config.apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": this.config.passphrase,
      "OK-ACCESS-PROJECT": this.config.projectId,
    };
  }

  /**
   * Makes an authenticated GET request to the OKX API.
   */
  private async get<T>(
    path: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const queryString = new URLSearchParams(params).toString();
    const requestPath = queryString ? `${path}?${queryString}` : path;
    const timestamp = new Date().toISOString();
    const headers = this.buildHeaders(timestamp, "GET", requestPath, "");
    const url = `${this.config.baseUrl}${requestPath}`;

    logger.debug("OKX API GET request", { url });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await OKXApiRateLimiter.schedule(() =>
        fetch(url, {
          method: "GET",
          headers,
          signal: controller.signal,
        }),
      );

      if (!response.ok) {
        throw new GuardianError(
          ErrorCode.OKX_API_ERROR,
          `OKX API returned HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const data = (await response.json()) as OKXApiResponse<T>;

      if (String(data.code) !== "0") {
        throw new GuardianError(
          ErrorCode.OKX_API_ERROR,
          `OKX API error: code=${data.code}, msg=${data.msg}`,
        );
      }

      if (!data.data || data.data.length === 0) {
        throw new GuardianError(
          ErrorCode.TOKEN_NOT_FOUND,
          `OKX API returned empty data for path: ${path}`,
        );
      }

      return data.data[0]!;
    } catch (err) {
      if (err instanceof GuardianError) throw err;

      if (err instanceof Error && err.name === "AbortError") {
        throw new GuardianError(
          ErrorCode.OKX_API_TIMEOUT,
          `OKX API request timed out after ${this.config.timeoutMs}ms`,
        );
      }

      throw new GuardianError(
        ErrorCode.OKX_API_ERROR,
        `OKX API request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Makes an authenticated POST request to the OKX API.
   */
  private async post<T>(
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<T> {
    const timestamp = new Date().toISOString();
    const bodyString = JSON.stringify(body);
    const headers = this.buildHeaders(timestamp, "POST", path, bodyString);
    const url = `${this.config.baseUrl}${path}`;

    logger.debug("OKX API POST request", { url });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await OKXApiRateLimiter.schedule(() =>
        fetch(url, {
          method: "POST",
          headers,
          body: bodyString,
          signal: controller.signal,
        }),
      );

      if (!response.ok) {
        throw new GuardianError(
          ErrorCode.OKX_API_ERROR,
          `OKX API returned HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const data = (await response.json()) as OKXApiResponse<T>;

      if (String(data.code) !== "0") {
        throw new GuardianError(
          ErrorCode.OKX_API_ERROR,
          `OKX API error: code=${data.code}, msg=${data.msg}`,
        );
      }

      if (!data.data || data.data.length === 0) {
        throw new GuardianError(
          ErrorCode.OKX_API_ERROR,
          `OKX API returned empty data for path: ${path}`,
        );
      }

      return data.data[0]!;
    } catch (err) {
      if (err instanceof GuardianError) throw err;

      if (err instanceof Error && err.name === "AbortError") {
        throw new GuardianError(
          ErrorCode.OKX_API_TIMEOUT,
          `OKX API request timed out after ${this.config.timeoutMs}ms`,
        );
      }

      throw new GuardianError(
        ErrorCode.OKX_API_ERROR,
        `OKX API request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  // -----------------------------------------------------------------------
  // Public: Token Risk Scanning
  // -----------------------------------------------------------------------

  /**
   * Scans a token contract for security risks using the OKX Security API.
   *
   * Checks: honeypot detection, buy/sell tax, mint function, blacklist,
   * proxy pattern, ownership status, holder count, and contract verification.
   *
   * @param tokenAddress - The EVM token contract address to scan
   * @param chainId      - X Layer chain ID (196 mainnet, 195 testnet)
   * @returns            - Structured token security data
   */
  async scanTokenRisk(
    tokenAddress: Address,
    chainId: SupportedChainId = 196,
  ): Promise<OKXTokenSecurityData> {
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

    logger.info("Scanning token risk via OKX Security API", {
      tokenAddress,
      chainId,
    });

    const result = await this.post<OKXTokenSecurityData>(
      "/api/v6/security/token-scan",
      {
        source: "onchain_os_cli",
        tokenList: [
          {
            chainId: String(chainId),
            contractAddress: tokenAddress,
          },
        ],
      },
    );

    this.tokenRiskCache.set(cacheKey, result);
    return result;
  }

  // -----------------------------------------------------------------------
  // Public: Transaction Simulation
  // -----------------------------------------------------------------------

  /**
   * Simulates a transaction via the OKX Security API's pre-execution
   * scan endpoint. Returns balance changes, risk level, and risk messages.
   *
   * This is the "second opinion" that runs in parallel with our own
   * eth_call simulation for cross-validation.
   *
   * @param tx      - Transaction parameters (from, to, data, value)
   * @param chainId - X Layer chain ID
   * @returns       - Simulation result with balance changes and risk assessment
   */
  async simulateTransaction(
    tx: { from: Address; to: Address; data: string; value: string },
    chainId: SupportedChainId = 196,
  ): Promise<OKXTxSimulationData> {
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

    logger.info("Simulating transaction via OKX Security API", {
      from: tx.from,
      to: tx.to,
      chainId,
    });

    const result = await this.post<OKXTxSimulationData>(
      "/api/v6/security/transaction-scan/evm",
      {
        source: "onchain_os_cli",
        chainId: String(chainId),
        from: tx.from,
        to: tx.to,
        data: tx.data,
        value: tx.value,
      },
    );

    this.txSimCache.set(cacheKey, result);
    return result;
  }

  // -----------------------------------------------------------------------
  // Public: DEX Quotes
  // -----------------------------------------------------------------------

  async getDexQuote(params: {
    chainId: SupportedChainId;
    fromTokenAddress: Address;
    toTokenAddress: Address;
    amountRaw: string;
    swapMode?: "exactIn" | "exactOut";
    singleRouteOnly?: boolean;
    singlePoolPerHop?: boolean;
    priceImpactProtectionPercent?: number;
  }): Promise<OKXDexQuoteData> {
    const swapMode = params.swapMode ?? "exactIn";
    const cacheKey = [
      "dex-quote",
      params.chainId,
      params.fromTokenAddress.toLowerCase(),
      params.toTokenAddress.toLowerCase(),
      params.amountRaw,
      swapMode,
      params.singleRouteOnly ? "single-route" : "multi-route",
      params.singlePoolPerHop ? "single-pool-hop" : "multi-pool-hop",
      params.priceImpactProtectionPercent ?? 90,
    ].join(":");

    const cached = this.dexQuoteCache.get(cacheKey);
    if (cached) {
      logger.info("DEX quote CACHE HIT", {
        chainId: params.chainId,
        fromTokenAddress: params.fromTokenAddress,
        toTokenAddress: params.toTokenAddress,
      });
      return cached;
    }

    logger.info("Fetching DEX quote via OKX API", {
      chainId: params.chainId,
      fromTokenAddress: params.fromTokenAddress,
      toTokenAddress: params.toTokenAddress,
      swapMode,
    });

    const result = await this.get<OKXDexQuoteData>(
      "/api/v6/dex/aggregator/quote",
      {
        chainIndex: String(params.chainId),
        amount: params.amountRaw,
        swapMode,
        fromTokenAddress: params.fromTokenAddress,
        toTokenAddress: params.toTokenAddress,
        singleRouteOnly: String(params.singleRouteOnly ?? true),
        singlePoolPerHop: String(params.singlePoolPerHop ?? true),
        priceImpactProtectionPercent: String(
          params.priceImpactProtectionPercent ?? 90,
        ),
      },
    );

    this.dexQuoteCache.set(cacheKey, result);
    return result;
  }

  // -----------------------------------------------------------------------
  // Public: DEX Swap Transaction
  // -----------------------------------------------------------------------

  async getDexSwapTx(params: {
    chainId: SupportedChainId;
    fromTokenAddress: Address;
    toTokenAddress: Address;
    amountRaw: string;
    userWalletAddress: Address;
    slippage?: string;
  }): Promise<{ tx: { data: string; to: string; value: string } }> {
    const result = await this.get<{ tx: { data: string; to: string; value: string } }>(
      "/api/v6/dex/aggregator/swap",
      {
        chainIndex: String(params.chainId),
        amount: params.amountRaw,
        fromTokenAddress: params.fromTokenAddress,
        toTokenAddress: params.toTokenAddress,
        userWalletAddress: params.userWalletAddress,
        slippage: params.slippage ?? "0.005",
      },
    );
    return result;
  }

  // -----------------------------------------------------------------------
  // Cache Management
  // -----------------------------------------------------------------------

  /** Clears all cached data. Useful for testing or forced re-evaluation. */
  clearCache(): void {
    this.tokenRiskCache.clear();
    this.txSimCache.clear();
    logger.info("OKXSecurityClient cache cleared");
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
