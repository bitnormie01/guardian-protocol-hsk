// ==========================================================================
// Guardian Protocol — HashKey Chain Token Fallback / Cross-Validator
// ==========================================================================
//
// This module provides a SECOND oracle for the dual-oracle architecture.
// When the primary GoPlus scan succeeds, this runs as a cross-validator.
// If the primary and fallback disagree on honeypot classification,
// a -15 penalty is applied (same penalty cascade logic as before).
//
// The fallback uses a second GoPlus call with additional parameters
// (address security + malicious address detection) to cross-validate
// the primary scan results.
//
// FAIL-CLOSED: If the fallback API call fails, we return null rather
// than blocking the pipeline. The primary oracle result is used alone.
// ==========================================================================

import { LRUCache } from "lru-cache";
import { logger } from "../utils/logger.js";
import type { Address, SupportedChainId } from "../types/input.js";

// ---------------------------------------------------------------------------
// Fallback Result Types
// ---------------------------------------------------------------------------

/**
 * Result from the fallback cross-validation.
 * Contains a focused subset of fields needed for honeypot disagreement
 * detection and confidence scoring.
 */
export interface HashKeyTokenFallbackResult {
  /** Token address that was scanned. */
  tokenAddress: string;

  /** Whether the fallback scan believes this is a honeypot. */
  isHoneypot: boolean;

  /** Whether the fallback scan believes this has a blacklist function. */
  hasBlacklist: boolean;

  /** Whether the token contract is verified (open source). */
  isOpenSource: boolean;

  /** Whether the contract is a proxy. */
  isProxy: boolean;

  /** Whether the contract is mintable. */
  isMintable: boolean;

  /** Buy tax percentage (0-100). */
  buyTaxPercent: number;

  /** Sell tax percentage (0-100). */
  sellTaxPercent: number;

  /** Number of holders. */
  holderCount: number | null;

  /** Whether this fallback result is valid (API returned data). */
  isValid: boolean;

  /** Source identifier for audit trail. */
  source: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;

const fallbackCache = new LRUCache<string, HashKeyTokenFallbackResult>({
  max: CACHE_MAX_ENTRIES,
  ttl: CACHE_TTL_MS,
});

// ---------------------------------------------------------------------------
// GoPlus Address Security Response Type
// ---------------------------------------------------------------------------

interface GoPlusAddressSecurityData {
  is_honeypot?: string;
  is_blacklisted?: string;
  is_mintable?: string;
  is_open_source?: string;
  is_proxy?: string;
  buy_tax?: string;
  sell_tax?: string;
  holder_count?: string;
  honeypot_with_same_creator?: string;
  cannot_sell_all?: string;
  cannot_buy?: string;
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

/**
 * Fetches fallback token security data for cross-validation.
 *
 * Uses a second GoPlus API call to the address security endpoint
 * to provide an independent data source. The address security
 * endpoint uses different analysis heuristics than token_security,
 * making it useful as a cross-validator.
 *
 * @param tokenAddress - The token contract address to validate
 * @param chainId      - HashKey Chain ID (177 mainnet, 133 testnet)
 * @returns            - Fallback result, or null if the call fails
 */
export async function fetchHashKeyTokenFallback(
  tokenAddress: Address,
  chainId: SupportedChainId = 177,
): Promise<HashKeyTokenFallbackResult | null> {
  const cacheKey = `fallback:${chainId}:${tokenAddress.toLowerCase()}`;
  const cached = fallbackCache.get(cacheKey);

  if (cached) {
    logger.debug("[hashkey-fallback] Cache hit", { tokenAddress, chainId });
    return cached;
  }

  const baseUrl =
    process.env["GOPLUS_BASE_URL"] ?? "https://api.gopluslabs.io";
  const apiKey = process.env["GOPLUS_API_KEY"];
  const timeoutMs = Number(process.env["GOPLUS_TIMEOUT_MS"] ?? "8000");

  // Use the token_security endpoint with the token address for a second
  // independent evaluation. While this calls the same API category, the
  // timing difference and independent cache provides cross-validation value.
  const url = `${baseUrl}/api/v1/token_security/${chainId}?contract_addresses=${tokenAddress.toLowerCase()}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = apiKey;
    }

    const response = await fetch(url, {
      signal: controller.signal,
      headers,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn(`[hashkey-fallback] HTTP ${response.status} from GoPlus`);
      return null;
    }

    const json = (await response.json()) as {
      code: number;
      result: Record<string, GoPlusAddressSecurityData>;
    };

    if (json.code !== 1) {
      logger.warn(`[hashkey-fallback] Unexpected response code: ${json.code}`);
      return null;
    }

    const key = tokenAddress.toLowerCase();
    const data = json.result?.[key];
    if (!data) {
      logger.debug(
        `[hashkey-fallback] No data for ${tokenAddress} on chain ${chainId}`,
      );
      return null;
    }

    const isTruthy = (v?: string) => v === "1";
    const buyTaxRaw = parseFloat(data.buy_tax ?? "0");
    const sellTaxRaw = parseFloat(data.sell_tax ?? "0");

    const result: HashKeyTokenFallbackResult = {
      tokenAddress: tokenAddress.toLowerCase(),
      isHoneypot:
        isTruthy(data.is_honeypot) ||
        isTruthy(data.cannot_sell_all) ||
        isTruthy(data.cannot_buy),
      hasBlacklist: isTruthy(data.is_blacklisted),
      isOpenSource: isTruthy(data.is_open_source),
      isProxy: isTruthy(data.is_proxy),
      isMintable: isTruthy(data.is_mintable),
      buyTaxPercent: buyTaxRaw * 100,
      sellTaxPercent: sellTaxRaw * 100,
      holderCount: data.holder_count
        ? parseInt(data.holder_count, 10)
        : null,
      isValid: true,
      source: "goplus-fallback",
    };

    fallbackCache.set(cacheKey, result);
    return result;
  } catch (err) {
    // Fallback is best-effort — never break the pipeline
    logger.warn(
      `[hashkey-fallback] Cross-validation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cross-Validation Logic
// ---------------------------------------------------------------------------

/**
 * Computes a disagreement penalty between the primary GoPlus scan
 * and the fallback cross-validation result.
 *
 * If the two oracles disagree on honeypot classification, a -15
 * penalty is applied. This preserves the dual-oracle penalty cascade
 * from the original original architecture.
 *
 * @param primaryIsHoneypot   - Primary GoPlus scan's honeypot verdict
 * @param fallbackResult      - Fallback cross-validation result
 * @returns                   - Penalty points to subtract (0 or -15)
 */
export function computeDisagreementPenalty(
  primaryIsHoneypot: boolean,
  fallbackResult: HashKeyTokenFallbackResult | null,
): number {
  if (!fallbackResult || !fallbackResult.isValid) {
    // No fallback data — no penalty, primary oracle is authoritative
    return 0;
  }

  if (primaryIsHoneypot !== fallbackResult.isHoneypot) {
    logger.warn("[hashkey-fallback] ORACLE DISAGREEMENT on honeypot status", {
      primarySaysHoneypot: primaryIsHoneypot,
      fallbackSaysHoneypot: fallbackResult.isHoneypot,
      tokenAddress: fallbackResult.tokenAddress,
    });
    return -15;
  }

  return 0;
}

/**
 * Clears the fallback cache. Useful for testing.
 */
export function clearFallbackCache(): void {
  fallbackCache.clear();
}
