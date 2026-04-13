// ==========================================================================
// Guardian Protocol — Token Risk Analyzer
// ==========================================================================
//
// This is the FIRST line of defense for any autonomous agent attempting
// a swap on X Layer. Before an agent spends a single wei of gas, this
// analyzer answers the question:
//
//   "Is this token contract safe to interact with?"
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │  HOW THIS PROTECTS AGENTS                                           │
// │                                                                     │
// │  1. HONEYPOT DETECTION                                              │
// │     A honeypot token allows buying but blocks selling — the most    │
// │     common scam on EVM chains. If an agent buys a honeypot, those   │
// │     funds are gone forever. We check the OKX Security API's         │
// │     `isHoneypot` flag, which tests actual sell-path execution.      │
// │                                                                     │
// │  2. TAX ANALYSIS                                                    │
// │     Some tokens impose hidden buy/sell taxes (sometimes 50–99%).    │
// │     An agent expecting 100 USDT output but receiving 1 USDT has     │
// │     effectively been robbed. We check `buyTax` and `sellTax` and    │
// │     flag anything above configurable thresholds.                    │
// │                                                                     │
// │  3. MINT FUNCTION                                                   │
// │     If the deployer can mint unlimited tokens, they can inflate     │
// │     supply to zero the price after an agent buys. We flag this.     │
// │                                                                     │
// │  4. BLACKLIST FUNCTION                                              │
// │     Contracts with blacklist functions can freeze the agent's       │
// │     address after purchase, making the tokens untransferable.       │
// │     This is functionally equivalent to a honeypot but harder to     │
// │     detect via simulation alone.                                    │
// │                                                                     │
// │  5. CONTRACT VERIFICATION & PROXY PATTERNS                          │
// │     Unverified source code means the community can't audit the      │
// │     contract. Upgradeable proxies mean the owner can change         │
// │     contract logic post-deployment — a rug-pull vector.             │
// │                                                                     │
// │  6. HOLDER DISTRIBUTION                                             │
// │     Extremely low holder counts signal a brand-new or abandoned     │
// │     token — both high-risk for an agent managing real value.        │
// └──────────────────────────────────────────────────────────────────────┘
//
// ARCHITECTURE:
//   This analyzer implements the standard `AnalyzerResult` interface.
//   It is called by the orchestrator in `src/index.ts` and its output
//   feeds into the risk scoring engine at `src/scoring/risk-engine.ts`.
//
// DATA SOURCE:
//   OKX OnchainOS Security API — the same backend that the `okx-security`
//   skill uses for token risk scanning, phishing detection, and approval
//   management. We call it via our typed `OKXSecurityClient`.
//
// ==========================================================================

import type { Address, SupportedChainId } from "../types/input.js";
import type { AnalyzerResult } from "../types/internal.js";
import type { RiskFlag } from "../types/output.js";
import { RiskFlagCode } from "../types/output.js";
import type { OKXTokenSecurityData } from "../types/okx-api.js";
import { OKXSecurityClient } from "../services/okx-security-client.js";
import {
  fetchGoPlusTokenSecurity,
  buildRiskReasons,
} from "../services/goplus-enrichment.js";
import { GuardianError, ErrorCode } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Configurable Thresholds
// ---------------------------------------------------------------------------

/**
 * Thresholds that determine when a tax rate, holder count, etc.
 * should trigger a risk flag. These are intentionally conservative
 * defaults — an agent integrator can override them.
 *
 * WHY THESE DEFAULTS:
 *   - 10% tax is already aggressive; legitimate tokens rarely exceed 5%.
 *   - 30% tax is predatory and almost certainly malicious.
 *   - 50 holders is the minimum for any token to have real liquidity.
 *   - These match the heuristics used by DexScreener and GoPlusSecurity
 *     for their "caution" / "danger" labels.
 */
export interface TokenRiskThresholds {
  /** Buy tax % above this triggers a MEDIUM flag.  Default: 10 */
  buyTaxWarningPercent: number;
  /** Buy tax % above this triggers a HIGH flag.    Default: 30 */
  buyTaxDangerPercent: number;
  /** Sell tax % above this triggers a MEDIUM flag.  Default: 10 */
  sellTaxWarningPercent: number;
  /** Sell tax % above this triggers a HIGH flag.    Default: 30 */
  sellTaxDangerPercent: number;
  /** Holder count below this triggers a LOW flag.   Default: 50 */
  minHolderCount: number;
}

const DEFAULT_THRESHOLDS: TokenRiskThresholds = {
  buyTaxWarningPercent: 10,
  buyTaxDangerPercent: 30,
  sellTaxWarningPercent: 10,
  sellTaxDangerPercent: 30,
  minHolderCount: 50,
};

// ---------------------------------------------------------------------------
// Token Risk Report (module-specific output)
// ---------------------------------------------------------------------------

/**
 * A rich, structured risk report for a single token.
 * This is stored inside `AnalyzerResult.data` so downstream modules
 * (like the scoring engine) can access granular details.
 */
/**
 * A rich, structured risk report for a single token.
 * This is stored inside `AnalyzerResult.data` so downstream modules
 * (like the scoring engine) can access granular details.
 */
export interface TokenRiskReport {
  /** The scanned token address. */
  tokenAddress: Address;

  /** Chain the scan was performed on. */
  chainId: SupportedChainId;

  /** Human-readable token name from the contract. */
  tokenName: string;

  /** Token ticker symbol. */
  tokenSymbol: string;

  // ---- Fatal signals (any one = do not touch) ----

  /** True if OKX Security API flags this as a risk token. */
  isRiskToken: boolean;

  /** True if confirmed as a honeypot (buying allowed, selling blocked). */
  isHoneypot: boolean;

  /** True if the contract has a blacklist/blocklist function. */
  isBlacklisted: boolean;

  // ---- High-risk signals ----

  /** True if the contract owner can mint unlimited tokens. */
  isMintable: boolean;

  /** True if the contract source code is verified. */
  isOpenSource: boolean;

  /** True if the contract uses an upgradeable proxy pattern. */
  isProxy: boolean;

  /** Buy tax as a percentage (0–100). */
  buyTaxPercent: number;

  /** Sell tax as a percentage (0–100). */
  sellTaxPercent: number;

  /** Number of unique token holders. */
  holderCount: number | null;

  // ---- Aggregate ----

  /**
   * Whether ANY fatal condition was detected.
   * If true, the calling agent MUST NOT proceed with the trade.
   */
  hasFatalRisk: boolean;

  /** All risk flags raised during this scan. */
  flags: RiskFlag[];

  /** Sub-score for this analyzer (0 = catastrophic, 100 = clean). */
  score: number;
}

// ---------------------------------------------------------------------------
// Helper: Build Risk Flags from Raw Data
// ---------------------------------------------------------------------------

/**
 * Analyzes the raw OKX security data and produces a list of risk flags.
 *
 * This is the core intelligence of the token risk analyzer. Each check
 * is independent and contributes flags with appropriate severity levels.
 * The flags are ordered: fatals first, then descending severity.
 */
async function buildRiskFlags(
  data: OKXTokenSecurityData,
  thresholds: TokenRiskThresholds,
): Promise<RiskFlag[]> {
  const flags: RiskFlag[] = [];
  let fatalDetectedDirectly = false;

  // ====================================================================
  // SECTION 1 — FATAL CHECKS
  // We first check granular OKX v6 boolean fields. Only if isRiskToken
  // is true but no granular reason is found do we fall back to GoPlus.
  // ====================================================================

  if (data.isHoneypot) {
    fatalDetectedDirectly = true;
    flags.push({
      code: RiskFlagCode.HONEYPOT_DETECTED,
      severity: "critical",
      message:
        `FATAL: Token ${data.tokenAddress} is confirmed as a HONEYPOT. ` +
        `Buying is allowed but selling is permanently blocked — any funds ` +
        `sent to this contract cannot be recovered. DO NOT EXECUTE THIS TRADE.`,
      source: "token-risk-analyzer",
    });
  }

  if (data.hasBlacklist) {
    fatalDetectedDirectly = true;
    flags.push({
      code: RiskFlagCode.BLACKLIST_FUNCTION,
      severity: "critical",
      message:
        `FATAL: Token ${data.tokenAddress} contains a BLACKLIST function. ` +
        `The contract owner can freeze this token in any wallet after purchase, ` +
        `rendering holdings permanently untransferable. ` +
        `This is functionally equivalent to a honeypot. DO NOT EXECUTE THIS TRADE.`,
      source: "token-risk-analyzer",
    });
  }

  // Fallback: OKX flagged as risk but no granular boolean explains why.
  // Use GoPlus Security API for secondary enrichment.
  if (data.isRiskToken && !fatalDetectedDirectly) {
    const chainId = parseInt(data.chainId, 10);
    const goPlusData = await fetchGoPlusTokenSecurity(
      data.tokenAddress,
      chainId,
    );

    if (goPlusData) {
      const reasons = buildRiskReasons(goPlusData, data.tokenAddress);

      logger.info(
        `[token-risk-analyzer] GoPlus enrichment found ${reasons.length} specific risk(s)`,
        { tokenAddress: data.tokenAddress, risks: reasons.map((r) => r.label) },
      );

      if (reasons.length > 0) {
        const codeMap: Record<string, RiskFlagCode> = {
          Honeypot: RiskFlagCode.HONEYPOT_DETECTED,
          "Sell restriction": RiskFlagCode.HONEYPOT_DETECTED,
          "Buy disabled": RiskFlagCode.HONEYPOT_DETECTED,
          "Blacklist function": RiskFlagCode.BLACKLIST_FUNCTION,
          "Unlimited minting": RiskFlagCode.MINT_FUNCTION_PRESENT,
          "Hidden owner": RiskFlagCode.OWNERSHIP_NOT_RENOUNCED,
          "Reclaimable ownership": RiskFlagCode.OWNERSHIP_NOT_RENOUNCED,
          "Upgradeable proxy contract": RiskFlagCode.PROXY_CONTRACT_UPGRADEABLE,
          "Unverified source code": RiskFlagCode.UNVERIFIED_CONTRACT,
        };
        for (const reason of reasons) {
          flags.push({
            code: codeMap[reason.label] ?? RiskFlagCode.HONEYPOT_DETECTED,
            severity: reason.severity,
            message: reason.detail,
            source: "token-risk-analyzer/goplus",
          });
        }
      } else {
        // GoPlus returned data but found no specific risks.
        flags.push({
          code: RiskFlagCode.HONEYPOT_DETECTED,
          severity: "critical",
          message:
            `FATAL: Token ${data.tokenAddress} is flagged as a risk token by OKX OnchainOS ` +
            `but the specific vulnerability could not be identified via secondary analysis. ` +
            `The token is treated as UNSAFE. DO NOT EXECUTE THIS TRADE.`,
          source: "token-risk-analyzer",
        });
      }
    } else {
      // GoPlus unavailable — fall back to generic OKX flag.
      flags.push({
        code: RiskFlagCode.HONEYPOT_DETECTED,
        severity: "critical",
        message:
          `FATAL: Token ${data.tokenAddress} is flagged as a risk token by OKX OnchainOS. ` +
          `Detailed risk analysis is unavailable. Possible threats include honeypot, ` +
          `blacklist function, or malicious contract behavior. ` +
          `DO NOT EXECUTE THIS TRADE.`,
        source: "token-risk-analyzer",
      });
    }
  }

  // ====================================================================
  // SECTION 2 — HIGH-SEVERITY CHECKS
  // ====================================================================

  if (data.isMintable) {
    flags.push({
      code: RiskFlagCode.MINT_FUNCTION_PRESENT,
      severity: "high",
      message:
        `Token ${data.tokenAddress} has an active MINT function. ` +
        `The deployer can inflate token supply at any time, ` +
        `diluting holder value and enabling instant rug pulls.`,
      source: "token-risk-analyzer",
    });
  }

  if (data.isOpenSource === false) {
    flags.push({
      code: RiskFlagCode.UNVERIFIED_CONTRACT,
      severity: "high",
      message:
        `Token ${data.tokenAddress} has UNVERIFIED source code. ` +
        `The contract cannot be publicly audited — hidden malicious logic may exist. ` +
        `Treat this token with extreme caution.`,
      source: "token-risk-analyzer",
    });
  }

  const sellTax = parseFloat(data.sellTaxes) || 0;

  if (sellTax >= thresholds.sellTaxDangerPercent) {
    flags.push({
      code: RiskFlagCode.HIGH_TAX_TOKEN,
      severity: "high",
      message:
        `Dangerously high sell tax detected: ${sellTax.toFixed(1)}%. ` +
        `Selling will forfeit ~${sellTax.toFixed(0)}% of the output amount. ` +
        `This is a strong indicator of a scam or exit-tax rug.`,
      source: "token-risk-analyzer",
    });
  } else if (sellTax >= thresholds.sellTaxWarningPercent) {
    flags.push({
      code: RiskFlagCode.HIGH_TAX_TOKEN,
      severity: "medium",
      message:
        `Elevated sell tax detected: ${sellTax.toFixed(1)}%. ` +
        `This exceeds the warning threshold.`,
      source: "token-risk-analyzer",
    });
  }

  const buyTax = parseFloat(data.buyTaxes) || 0;

  if (buyTax >= thresholds.buyTaxDangerPercent) {
    flags.push({
      code: RiskFlagCode.HIGH_TAX_TOKEN,
      severity: "high",
      message:
        `Dangerously high buy tax detected: ${buyTax.toFixed(1)}%. ` +
        `Buying will forfeit ~${buyTax.toFixed(0)}% of the input amount.`,
      source: "token-risk-analyzer",
    });
  } else if (buyTax >= thresholds.buyTaxWarningPercent) {
    flags.push({
      code: RiskFlagCode.HIGH_TAX_TOKEN,
      severity: "medium",
      message:
        `Elevated buy tax detected: ${buyTax.toFixed(1)}%. ` +
        `This exceeds the warning threshold.`,
      source: "token-risk-analyzer",
    });
  }

  // ====================================================================
  // SECTION 3 — MEDIUM-SEVERITY CHECKS
  // ====================================================================

  if (data.isProxy) {
    flags.push({
      code: RiskFlagCode.PROXY_CONTRACT_UPGRADEABLE,
      severity: "medium",
      message:
        `Token ${data.tokenAddress} uses an UPGRADEABLE PROXY pattern. ` +
        `The contract logic can be replaced after deployment. ` +
        `This is a potential rug-pull vector — trust the owner's track record.`,
      source: "token-risk-analyzer",
    });
  }

  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
  if (
    data.ownerAddress !== undefined &&
    data.ownerAddress.toLowerCase() !== ZERO_ADDRESS
  ) {
    flags.push({
      code: RiskFlagCode.OWNERSHIP_NOT_RENOUNCED,
      severity: "medium",
      message:
        `Token ${data.tokenAddress} ownership has NOT been renounced. ` +
        `Owner (${data.ownerAddress}) retains admin privileges ` +
        `including the ability to modify fees, pause trading, or drain liquidity.`,
      source: "token-risk-analyzer",
    });
  }

  // ====================================================================
  // SECTION 4 — LOW-SEVERITY CHECKS
  // ====================================================================

  if (
    data.holderCount !== undefined &&
    data.holderCount < thresholds.minHolderCount
  ) {
    flags.push({
      code: RiskFlagCode.LOW_HOLDER_COUNT,
      severity: "low",
      message:
        `Token ${data.tokenAddress} has only ${data.holderCount} unique holders ` +
        `(minimum: ${thresholds.minHolderCount}). ` +
        `Very low holder count signals a new or abandoned token with thin liquidity.`,
      source: "token-risk-analyzer",
    });
  }

  // Sort: critical first, then high, medium, low, info
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

  return flags;
}

// ---------------------------------------------------------------------------
// Helper: Compute Sub-Score
// ---------------------------------------------------------------------------

/**
 * Computes a 0–100 risk sub-score for this token.
 *
 * SCORING METHODOLOGY:
 *   Start at 100 (perfectly safe) and subtract penalty points
 *   for each risk signal. This "deduction" model is intuitive:
 *   every red flag costs you points.
 *
 *   - Fatal flags (honeypot, blacklist) → immediate 0
 *   - High-severity flags → -25 each
 *   - Medium-severity flags → -15 each
 *   - Low-severity flags → -5 each
 *   - Tax penalties are proportional to the actual tax rate
 *
 *   The score is clamped to [0, 100].
 *
 * WHY THIS MATTERS:
 *   A calling agent can set a threshold (e.g., "only trade tokens
 *   scoring >= 70") and Guardian enforces it. The sub-score also
 *   feeds into the composite SafetyScore in the risk engine.
 */
function computeTokenRiskScore(
  data: OKXTokenSecurityData,
  flags: RiskFlag[],
): number {
  // Immediate zero for fatal conditions — no partial credit
  const hasFatal = flags.some((f) => f.severity === "critical");
  if (hasFatal) return 0;

  let score = 100;

  // Deductions by severity
  for (const flag of flags) {
    switch (flag.severity) {
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
      // critical already handled above
    }
  }

  // Additional proportional deduction for high taxes
  // A 50% sell tax should hurt more than a 15% sell tax,
  // even though both trigger the same flag code.
  const sellTax = parseFloat(data.sellTaxes) || 0;
  const buyTax = parseFloat(data.buyTaxes) || 0;

  // Deduct 0.5 points per percentage point of tax
  // (This is ON TOP of the flag-based deduction above)
  score -= Math.floor(sellTax * 0.5);
  score -= Math.floor(buyTax * 0.3);

  // Clamp to [0, 100]
  return Math.max(0, Math.min(100, score));
}

// ---------------------------------------------------------------------------
// Main Export: analyzeTokenRisk()
// ---------------------------------------------------------------------------

/**
 * The primary entry point for token risk analysis.
 *
 * This function:
 *   1. Calls the OKX Security API to fetch raw token risk data
 *   2. Evaluates every risk dimension against configurable thresholds
 *   3. Produces structured risk flags with human-readable explanations
 *   4. Computes a 0–100 sub-score for the scoring engine
 *   5. Returns a standardized `AnalyzerResult` for the pipeline
 *
 * USAGE BY CALLING AGENTS:
 *   An agent middleware calls Guardian Protocol → Guardian calls this
 *   analyzer → if hasFatalRisk is true, Guardian returns
 *   isSafeToExecute: false and the calling agent aborts the trade.
 *
 * @param tokenAddress  - EVM token contract address to scan
 * @param chainId       - X Layer chain ID (196 mainnet, 195 testnet)
 * @param thresholds    - Optional custom thresholds (overrides defaults)
 * @param client        - Optional pre-configured OKX client (for testing/DI)
 *
 * @returns AnalyzerResult conforming to the Guardian pipeline interface,
 *          with `data` containing the full `TokenRiskReport`.
 */
export async function analyzeTokenRisk(
  tokenAddress: Address,
  chainId: SupportedChainId = 196,
  thresholds: Partial<TokenRiskThresholds> = {},
  client?: OKXSecurityClient,
): Promise<AnalyzerResult> {
  const ANALYZER_NAME = "token-risk-analyzer";
  const startTime = performance.now();
  const resolvedThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };

  logger.info(`[${ANALYZER_NAME}] Starting token risk analysis`, {
    tokenAddress,
    chainId,
    thresholds: resolvedThresholds,
  });

  try {
    // ------------------------------------------------------------------
    // Step 1: Fetch raw security data from OKX
    // ------------------------------------------------------------------
    const okxClient = client ?? new OKXSecurityClient();
    const rawData = await okxClient.scanTokenRisk(tokenAddress, chainId);

    logger.debug(`[${ANALYZER_NAME}] Received OKX security data`, {
      tokenAddress: rawData.tokenAddress,
      isRiskToken: rawData.isRiskToken,
      buyTaxes: rawData.buyTaxes,
      sellTaxes: rawData.sellTaxes,
    });

    // ------------------------------------------------------------------
    // Step 2: Evaluate all risk dimensions → produce flags
    // ------------------------------------------------------------------
    const flags = await buildRiskFlags(rawData, resolvedThresholds);

    // ------------------------------------------------------------------
    // Step 3: Compute sub-score
    // ------------------------------------------------------------------
    const score = computeTokenRiskScore(rawData, flags);

    // ------------------------------------------------------------------
    // Step 4: Determine fatal status
    // ------------------------------------------------------------------
    // A token has a fatal risk if ANY critical-severity flag is present.
    // This is the "hard stop" signal — no amount of routing optimization
    // can make a honeypot safe.
    const hasFatalRisk = flags.some((f) => f.severity === "critical");

    // ------------------------------------------------------------------
    // Step 5: Assemble the rich report
    // ------------------------------------------------------------------
    const report: TokenRiskReport = {
      tokenAddress,
      chainId,
      tokenName: rawData.tokenName ?? "Unknown",
      tokenSymbol: rawData.tokenSymbol ?? "Unknown",

      // Fatal signals
      isRiskToken: rawData.isRiskToken,
      isHoneypot: rawData.isHoneypot ?? false,
      isBlacklisted: rawData.hasBlacklist ?? false,

      // High-risk signals
      isMintable: rawData.isMintable ?? false,
      isOpenSource: rawData.isOpenSource ?? true,
      isProxy: rawData.isProxy ?? false,
      buyTaxPercent: parseFloat(rawData.buyTaxes) || 0,
      sellTaxPercent: parseFloat(rawData.sellTaxes) || 0,
      holderCount: rawData.holderCount ?? null,

      // Aggregate
      hasFatalRisk,
      flags,
      score,
    };

    const durationMs = Math.round(performance.now() - startTime);

    // ------------------------------------------------------------------
    // Step 6: Log the verdict
    // ------------------------------------------------------------------
    if (hasFatalRisk) {
      logger.error(`[${ANALYZER_NAME}] ⛔ FATAL RISK DETECTED`, {
        tokenAddress,
        score,
        flagCount: flags.length,
        durationMs,
      });
    } else if (score < 50) {
      logger.warn(`[${ANALYZER_NAME}] ⚠️  High-risk token detected`, {
        tokenAddress,
        score,
        flagCount: flags.length,
        durationMs,
      });
    } else {
      logger.info(`[${ANALYZER_NAME}] ✅ Token analysis complete`, {
        tokenAddress,
        score,
        flagCount: flags.length,
        durationMs,
      });
    }

    // ------------------------------------------------------------------
    // Step 7: Return standardized AnalyzerResult for the pipeline
    // ------------------------------------------------------------------
    return {
      analyzerName: ANALYZER_NAME,
      flags,
      score,
      durationMs,
      data: report as unknown as Record<string, unknown>,
    };
  } catch (err) {
    // ------------------------------------------------------------------
    // Error Handling
    // ------------------------------------------------------------------
    // If the OKX API is down or the token isn't indexed, we do NOT
    // silently pass. Failing open (assuming safe) would defeat the
    // entire purpose of a security middleware. Instead, we return a
    // score of 0 with an error flag, forcing the calling agent to
    // treat this as unsafe until proven otherwise.
    //
    // This is the FAIL-CLOSED principle: when in doubt, block.
    // ------------------------------------------------------------------
    const durationMs = Math.round(performance.now() - startTime);

    const errorMessage =
      err instanceof GuardianError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);

    logger.error(`[${ANALYZER_NAME}] ❌ Analysis failed — FAILING CLOSED`, {
      tokenAddress,
      chainId,
      error: errorMessage,
      durationMs,
    });

    const errorFlag: RiskFlag = {
      code: RiskFlagCode.API_UNAVAILABLE,
      severity: "high",
      message:
        `Token risk analysis failed for ${tokenAddress}: ${errorMessage}. ` +
        `Guardian Protocol fails CLOSED — this token is treated as unsafe ` +
        `until a successful scan can be completed. This protects the agent ` +
        `from trading a potentially malicious token when security data is ` +
        `unavailable.`,
      source: ANALYZER_NAME,
    };

    return {
      analyzerName: ANALYZER_NAME,
      flags: [errorFlag],
      score: 0, // Fail closed: score zero = do not trade
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
// Convenience: Scan Both Tokens in a Pair
// ---------------------------------------------------------------------------

/**
 * Scans BOTH tokenIn and tokenOut in parallel and returns combined results.
 *
 * WHY SCAN BOTH:
 *   An agent might be selling a safe token (USDT) to buy a honeypot.
 *   But it's also possible the tokenIn itself has restrictions — e.g.,
 *   a blacklist-enabled token might block the agent's address from
 *   transferring it to the DEX router, causing the entire swap to revert
 *   and waste gas.
 *
 * @returns A tuple of [tokenInResult, tokenOutResult]
 */
export async function analyzeTokenPairRisk(
  tokenIn: Address,
  tokenOut: Address,
  chainId: SupportedChainId = 196,
  thresholds: Partial<TokenRiskThresholds> = {},
  client?: OKXSecurityClient,
): Promise<[AnalyzerResult, AnalyzerResult]> {
  logger.info("Analyzing token pair risk in parallel", {
    tokenIn,
    tokenOut,
    chainId,
  });

  // Run both scans concurrently — no dependency between them.
  // This cuts wall-clock time roughly in half vs. sequential scanning.
  const [tokenInResult, tokenOutResult] = await Promise.all([
    analyzeTokenRisk(tokenIn, chainId, thresholds, client),
    analyzeTokenRisk(tokenOut, chainId, thresholds, client),
  ]);

  return [tokenInResult, tokenOutResult];
}
