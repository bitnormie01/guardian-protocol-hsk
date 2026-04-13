// ==========================================================================
// Guardian Protocol — Token Risk Analyzer Unit Tests
// ==========================================================================
//
// These tests validate the token risk analyzer's logic WITHOUT hitting
// the real OKX API or GoPlus. We mock both the OKXSecurityClient and
// the GoPlus enrichment module to return controlled data and verify:
//
//   1. Honeypots are flagged as CRITICAL with score 0
//   2. Blacklisted tokens are flagged as CRITICAL with score 0
//   3. High taxes + mint + unverified produce multiple high-severity flags
//   4. Clean tokens score 100 with no flags
//   5. API failures result in fail-closed behavior (score 0)
//   6. Multiple risk signals stack correctly with correct ordering
// ==========================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { analyzeTokenRisk, analyzeTokenPairRisk } from "../../../src/analyzers/token-risk.js";
import { OKXSecurityClient } from "../../../src/services/okx-security-client.js";
import { RiskFlagCode } from "../../../src/types/output.js";
import type { OKXTokenSecurityData } from "../../../src/types/okx-api.js";
import type { Address } from "../../../src/types/input.js";

// ---------------------------------------------------------------------------
// Mock GoPlus — must be hoisted before any imports use it.
// The GoPlus module is only called when isRiskToken=true but no granular
// field (isHoneypot / hasBlacklist) explains the risk. We mock it to
// return null (unavailable) for all tests, so the HONEYPOT_DETECTED
// fallback flag is used in that path.
// ---------------------------------------------------------------------------

vi.mock("../../../src/services/goplus-enrichment.js", () => ({
  fetchGoPlusTokenSecurity: vi.fn().mockResolvedValue(null),
  buildRiskReasons: vi.fn().mockReturnValue([]),
}));

// ---------------------------------------------------------------------------
// Test Fixtures — Full OKX API v6 Schema
// ---------------------------------------------------------------------------

/** A perfectly clean, safe token. */
const CLEAN_TOKEN: OKXTokenSecurityData = {
  chainId: "196",
  tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  isChainSupported: true,
  isRiskToken: false,
  buyTaxes: "0",
  sellTaxes: "0",
  isHoneypot: false,
  hasBlacklist: false,
  isMintable: false,
  isOpenSource: true,
  isProxy: false,
  ownerAddress: "0x0000000000000000000000000000000000000000",
  holderCount: 250000,
  totalSupply: "1000000000000000",
  tokenName: "USD Coin",
  tokenSymbol: "USDC",
};

/** A confirmed honeypot token. */
const HONEYPOT_TOKEN: OKXTokenSecurityData = {
  ...CLEAN_TOKEN,
  tokenName: "ScamCoin",
  tokenSymbol: "SCAM",
  isRiskToken: true,
  isHoneypot: true,
  isOpenSource: false,
  ownerAddress: "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF",
  holderCount: 5,
};

/** A token with a blacklist function. */
const BLACKLIST_TOKEN: OKXTokenSecurityData = {
  ...CLEAN_TOKEN,
  tokenName: "FreezeToken",
  tokenSymbol: "FREEZE",
  isRiskToken: true,
  hasBlacklist: true,
  ownerAddress: "0x1234567890123456789012345678901234567890",
};

/** A token with predatory taxes, mint function, and unverified source. */
const HIGH_TAX_TOKEN: OKXTokenSecurityData = {
  ...CLEAN_TOKEN,
  tokenName: "TaxHeavy",
  tokenSymbol: "TAX",
  isRiskToken: false,
  buyTaxes: "35",
  sellTaxes: "50",
  isMintable: true,
  isOpenSource: false,
  holderCount: 30,
  ownerAddress: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01",
};

/** A token with moderate, non-fatal risks: proxy, taxes, active owner. */
const MODERATE_RISK_TOKEN: OKXTokenSecurityData = {
  ...CLEAN_TOKEN,
  tokenName: "RiskyButNotFatal",
  tokenSymbol: "RISK",
  isRiskToken: false,
  buyTaxes: "12",
  sellTaxes: "15",
  isProxy: true,
  ownerAddress: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01",
  holderCount: 200,
};

// ---------------------------------------------------------------------------
// Mock Setup
// ---------------------------------------------------------------------------

const TEST_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;

function createMockClient(returnData: OKXTokenSecurityData): OKXSecurityClient {
  const mock = {
    scanTokenRisk: vi.fn().mockResolvedValue(returnData),
    simulateTransaction: vi.fn(),
  } as unknown as OKXSecurityClient;
  return mock;
}

function createFailingClient(error: Error): OKXSecurityClient {
  const mock = {
    scanTokenRisk: vi.fn().mockRejectedValue(error),
    simulateTransaction: vi.fn(),
  } as unknown as OKXSecurityClient;
  return mock;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Token Risk Analyzer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. Clean Token — Should Pass With Flying Colors
  // -----------------------------------------------------------------------
  describe("clean token", () => {
    it("should return score 100 with zero flags", async () => {
      const client = createMockClient(CLEAN_TOKEN);
      const result = await analyzeTokenRisk(TEST_ADDRESS, 196, {}, client);

      expect(result.analyzerName).toBe("token-risk-analyzer");
      expect(result.score).toBe(100);
      expect(result.flags).toHaveLength(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Verify the rich report in data
      const report = result.data as Record<string, unknown>;
      expect(report["hasFatalRisk"]).toBe(false);
      expect(report["isHoneypot"]).toBe(false);
      expect(report["isBlacklisted"]).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Honeypot — MUST be Fatal, Score Zero
  // -----------------------------------------------------------------------
  describe("honeypot detection", () => {
    it("should flag as CRITICAL and return score 0", async () => {
      const client = createMockClient(HONEYPOT_TOKEN);
      const result = await analyzeTokenRisk(TEST_ADDRESS, 196, {}, client);

      expect(result.score).toBe(0);

      const honeypotFlag = result.flags.find(
        (f) => f.code === RiskFlagCode.HONEYPOT_DETECTED
      );
      expect(honeypotFlag).toBeDefined();
      expect(honeypotFlag!.severity).toBe("critical");
      expect(honeypotFlag!.message).toContain("DO NOT EXECUTE");

      const report = result.data as Record<string, unknown>;
      expect(report["hasFatalRisk"]).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 3. Blacklisted Token — MUST be Fatal, Score Zero
  // -----------------------------------------------------------------------
  describe("blacklist detection", () => {
    it("should flag as CRITICAL and return score 0", async () => {
      const client = createMockClient(BLACKLIST_TOKEN);
      const result = await analyzeTokenRisk(TEST_ADDRESS, 196, {}, client);

      expect(result.score).toBe(0);

      const blacklistFlag = result.flags.find(
        (f) => f.code === RiskFlagCode.BLACKLIST_FUNCTION
      );
      expect(blacklistFlag).toBeDefined();
      expect(blacklistFlag!.severity).toBe("critical");
      expect(blacklistFlag!.message).toContain("FATAL");

      const report = result.data as Record<string, unknown>;
      expect(report["hasFatalRisk"]).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 4. High Tax Token — Should Produce Multiple High-Severity Flags
  // -----------------------------------------------------------------------
  describe("high tax token", () => {
    it("should produce high-severity flags and a low score", async () => {
      const client = createMockClient(HIGH_TAX_TOKEN);
      const result = await analyzeTokenRisk(TEST_ADDRESS, 196, {}, client);

      // Multiple high flags: buy tax danger, sell tax danger, mintable, unverified
      const highFlags = result.flags.filter((f) => f.severity === "high");
      expect(highFlags.length).toBeGreaterThanOrEqual(3);

      // Score should be very low but not zero (no fatals)
      expect(result.score).toBeLessThan(30);
      expect(result.score).toBeGreaterThanOrEqual(0);

      // Should also flag low holder count
      const lowHolders = result.flags.find(
        (f) => f.code === RiskFlagCode.LOW_HOLDER_COUNT
      );
      expect(lowHolders).toBeDefined();

      // Should flag unverified source code
      const unverified = result.flags.find(
        (f) => f.code === RiskFlagCode.UNVERIFIED_CONTRACT
      );
      expect(unverified).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // 5. Moderate Risk Token — Flags Present but Score Still Viable
  // -----------------------------------------------------------------------
  describe("moderate risk token", () => {
    it("should produce medium-severity flags with moderate score", async () => {
      const client = createMockClient(MODERATE_RISK_TOKEN);
      const result = await analyzeTokenRisk(TEST_ADDRESS, 196, {}, client);

      // Should have flags for: elevated taxes, proxy, ownership
      expect(result.flags.length).toBeGreaterThanOrEqual(3);

      // No critical flags
      const criticals = result.flags.filter((f) => f.severity === "critical");
      expect(criticals).toHaveLength(0);

      // Score should be in the middle range
      expect(result.score).toBeGreaterThan(20);
      expect(result.score).toBeLessThan(80);

      const report = result.data as Record<string, unknown>;
      expect(report["hasFatalRisk"]).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 6. Custom Thresholds — Agent Can Tighten or Loosen Rules
  // -----------------------------------------------------------------------
  describe("custom thresholds", () => {
    it("should respect custom tax thresholds", async () => {
      const client = createMockClient({
        ...CLEAN_TOKEN,
        sellTaxes: "8",
        ownerAddress: "0x0000000000000000000000000000000000000000",
      });

      // With default thresholds (warning at 10%), 8% should NOT flag
      const resultDefault = await analyzeTokenRisk(TEST_ADDRESS, 196, {}, client);
      const taxFlagsDefault = resultDefault.flags.filter(
        (f) => f.code === RiskFlagCode.HIGH_TAX_TOKEN
      );
      expect(taxFlagsDefault).toHaveLength(0);

      // With custom threshold (warning at 5%), 8% SHOULD flag
      const resultStrict = await analyzeTokenRisk(
        TEST_ADDRESS,
        196,
        { sellTaxWarningPercent: 5 },
        client
      );
      const taxFlagsStrict = resultStrict.flags.filter(
        (f) => f.code === RiskFlagCode.HIGH_TAX_TOKEN
      );
      expect(taxFlagsStrict.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // 7. API Failure — MUST Fail Closed (Score 0)
  // -----------------------------------------------------------------------
  describe("API failure — fail closed", () => {
    it("should return score 0 when OKX API is unreachable", async () => {
      const client = createFailingClient(new Error("Network timeout"));
      const result = await analyzeTokenRisk(TEST_ADDRESS, 196, {}, client);

      // FAIL CLOSED: score must be 0
      expect(result.score).toBe(0);

      // Must have at least one flag explaining the failure
      expect(result.flags.length).toBeGreaterThanOrEqual(1);
      expect(result.flags[0]!.code).toBe(RiskFlagCode.API_UNAVAILABLE);
      expect(result.flags[0]!.message).toContain("failed");

      // Error metadata should be in the data payload
      const data = result.data as Record<string, unknown>;
      expect(data["error"]).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 8. Flag Ordering — Criticals Must Come First
  // -----------------------------------------------------------------------
  describe("flag ordering", () => {
    it("should order flags by severity (critical first)", async () => {
      // A token that has BOTH a honeypot AND high taxes AND mint
      const client = createMockClient({
        ...HONEYPOT_TOKEN,
        buyTaxes: "40",
        sellTaxes: "60",
        isMintable: true,
      });

      const result = await analyzeTokenRisk(TEST_ADDRESS, 196, {}, client);

      // First flag must be critical
      expect(result.flags[0]!.severity).toBe("critical");

      // Verify ordering is maintained throughout
      for (let i = 1; i < result.flags.length; i++) {
        const prevOrder = severityToOrder(result.flags[i - 1]!.severity);
        const currOrder = severityToOrder(result.flags[i]!.severity);
        expect(currOrder).toBeGreaterThanOrEqual(prevOrder);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 9. Pair Analysis — Both Tokens Scanned in Parallel
  // -----------------------------------------------------------------------
  describe("token pair analysis", () => {
    it("should scan both tokens and return tuple", async () => {
      const client = {
        scanTokenRisk: vi
          .fn()
          .mockResolvedValueOnce(CLEAN_TOKEN)
          .mockResolvedValueOnce(HONEYPOT_TOKEN),
        simulateTransaction: vi.fn(),
      } as unknown as OKXSecurityClient;

      const [tokenInResult, tokenOutResult] = await analyzeTokenPairRisk(
        "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as Address,
        "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" as Address,
        196,
        {},
        client
      );

      // tokenIn (CLEAN) should be safe
      expect(tokenInResult.score).toBe(100);

      // tokenOut (HONEYPOT) should be fatal
      expect(tokenOutResult.score).toBe(0);
      expect(
        tokenOutResult.flags.some(
          (f) => f.code === RiskFlagCode.HONEYPOT_DETECTED
        )
      ).toBe(true);

      // Both scans should have been called
      expect(client.scanTokenRisk).toHaveBeenCalledTimes(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Test Utility
// ---------------------------------------------------------------------------

function severityToOrder(severity: string): number {
  const order: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };
  return order[severity] ?? 5;
}
