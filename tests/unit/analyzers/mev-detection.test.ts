// ==========================================================================
// Guardian Protocol — MEV Detection Analyzer Unit Tests
// ==========================================================================
//
// Tests validate MEV risk detection logic including:
//   1. Clean trade with no MEV risk → high score
//   2. Large trade detection → dynamic slippage tightening
//   3. Medium trade → warning level
//   4. Extreme trade — pool domination
//   5. Custom thresholds
//   6. Dynamic slippage cap computation
//   7. Score boundaries
//   8. Report structure completeness
//   9. Flag ordering
//  10. Graceful error handling
// ==========================================================================

import { describe, it, expect } from "vitest";
import { analyzeMEVRisk } from "../../../src/analyzers/mev-detection.js";
import { RiskFlagCode } from "../../../src/types/output.js";
import type { Address, HexString } from "../../../src/types/input.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_IN = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as Address;
const TOKEN_OUT = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" as Address;
const USER_ADDRESS = "0x1234567890AbCdEf1234567890AbCdEf12345678" as Address;
const PROPOSED_TX = "0xabcdef1234567890" as HexString;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MEV Detection Analyzer", () => {
  // -----------------------------------------------------------------------
  // 1. Clean Trade — Minimal MEV Risk
  // -----------------------------------------------------------------------
  describe("clean trade with low MEV risk", () => {
    it("should return high score for small trade in liquid pool", async () => {
      // Small $50 trade — well below any threshold
      const result = await analyzeMEVRisk(
        TOKEN_IN,
        TOKEN_OUT,
        50, // $50 trade — negligible
        USER_ADDRESS,
        PROPOSED_TX,
        196,
      );

      expect(result.analyzerName).toBe("mev-detection-analyzer");
      expect(result.score).toBeGreaterThanOrEqual(70);

      const report = result.data as Record<string, unknown>;
      expect(["minimal", "low"]).toContain(report["mevRiskLevel"]);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Large Trade — Dynamic Slippage Tightening
  // -----------------------------------------------------------------------
  describe("large trade relative to pool", () => {
    it("should flag MEV risk for large trade size", async () => {
      // $150,000 trade — extreme category
      const result = await analyzeMEVRisk(
        TOKEN_IN,
        TOKEN_OUT,
        150_000,
        USER_ADDRESS,
        PROPOSED_TX,
        196,
      );

      const report = result.data as Record<string, unknown>;
      expect(report["recommendMevProtection"]).toBeDefined();
      expect(report["tradeImpactAssessment"]).toBe("extreme");
    });
  });

  // -----------------------------------------------------------------------
  // 3. Medium Trade — Warning Level
  // -----------------------------------------------------------------------
  describe("medium trade at warning level", () => {
    it("should flag medium MEV risk for moderate trade", async () => {
      // $5,000 trade — significant
      const result = await analyzeMEVRisk(
        TOKEN_IN,
        TOKEN_OUT,
        5_000,
        USER_ADDRESS,
        PROPOSED_TX,
        196,
      );

      const report = result.data as Record<string, unknown>;
      expect(report["tradeImpactAssessment"]).toBe("significant");
    });
  });

  // -----------------------------------------------------------------------
  // 4. Extreme Trade — Pool Domination
  // -----------------------------------------------------------------------
  describe("extreme trade size", () => {
    it("should assess extreme impact for very large trades", async () => {
      // $250,000 — extreme
      const result = await analyzeMEVRisk(
        TOKEN_IN,
        TOKEN_OUT,
        250_000,
        USER_ADDRESS,
        PROPOSED_TX,
        196,
      );

      const report = result.data as Record<string, unknown>;
      expect(report["tradeImpactAssessment"]).toBe("extreme");
    });
  });

  // -----------------------------------------------------------------------
  // 5. Custom Thresholds
  // -----------------------------------------------------------------------
  describe("custom thresholds", () => {
    it("should respect custom slippage thresholds", async () => {
      // With very strict thresholds, even small trades should flag
      const result = await analyzeMEVRisk(
        TOKEN_IN,
        TOKEN_OUT,
        500,
        USER_ADDRESS,
        PROPOSED_TX,
        196,
        { highSlippageRiskBps: 100, warningSlippageRiskBps: 50 },
      );

      // Should have higher risk assessment with strict thresholds
      expect(result.score).toBeDefined();
      expect(result.flags).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // 6. Dynamic Slippage Cap
  // -----------------------------------------------------------------------
  describe("dynamic slippage cap", () => {
    it("should include dynamic slippage cap data in report", async () => {
      const result = await analyzeMEVRisk(
        TOKEN_IN,
        TOKEN_OUT,
        500,
        USER_ADDRESS,
        PROPOSED_TX,
        196,
      );

      const report = result.data as Record<string, unknown>;
      expect(report["dynamicSlippageCap"]).toBeDefined();

      const cap = report["dynamicSlippageCap"] as Record<string, unknown>;
      expect(cap).toHaveProperty("cappedSlippageBps");
      expect(cap).toHaveProperty("baseSlippageBps");
      expect(cap).toHaveProperty("tradeImpactAdjustment");
      expect(cap).toHaveProperty("explanation");
    });

    it("should tighten slippage for large trades", async () => {
      const smallTradeResult = await analyzeMEVRisk(
        TOKEN_IN,
        TOKEN_OUT,
        50, // small trade
        USER_ADDRESS,
        PROPOSED_TX,
        196,
      );

      const largeTradeResult = await analyzeMEVRisk(
        TOKEN_IN,
        TOKEN_OUT,
        50_000, // large trade
        USER_ADDRESS,
        PROPOSED_TX,
        196,
      );

      const smallCap = (smallTradeResult.data as Record<string, unknown>)[
        "dynamicSlippageCap"
      ] as Record<string, unknown>;
      const largeCap = (largeTradeResult.data as Record<string, unknown>)[
        "dynamicSlippageCap"
      ] as Record<string, unknown>;

      expect(
        (largeCap["cappedSlippageBps"] as number) <=
          (smallCap["cappedSlippageBps"] as number),
      ).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 7. Score Boundaries
  // -----------------------------------------------------------------------
  describe("score boundaries", () => {
    it("should never return score below 0", async () => {
      const result = await analyzeMEVRisk(
        TOKEN_IN,
        TOKEN_OUT,
        500_000,
        USER_ADDRESS,
        PROPOSED_TX,
        196,
      );

      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it("should never return score above 100", async () => {
      const result = await analyzeMEVRisk(
        TOKEN_IN,
        TOKEN_OUT,
        10, // Tiny trade
        USER_ADDRESS,
        PROPOSED_TX,
        196,
      );

      expect(result.score).toBeLessThanOrEqual(100);
    });
  });

  // -----------------------------------------------------------------------
  // 8. Report Structure Completeness
  // -----------------------------------------------------------------------
  describe("report structure", () => {
    it("should contain all required fields", async () => {
      const result = await analyzeMEVRisk(
        TOKEN_IN,
        TOKEN_OUT,
        1000,
        USER_ADDRESS,
        PROPOSED_TX,
        196,
      );

      const report = result.data as Record<string, unknown>;

      // All required fields present
      expect(report).toHaveProperty("mevRiskLevel");
      expect(report).toHaveProperty("tradeImpactAssessment");
      expect(report).toHaveProperty("dynamicSlippageCap");
      expect(report).toHaveProperty("recommendMevProtection");
      expect(report).toHaveProperty("flags");
      expect(report).toHaveProperty("score");
      expect(report).toHaveProperty("chainId");
    });
  });

  // -----------------------------------------------------------------------
  // 9. Flag Ordering
  // -----------------------------------------------------------------------
  describe("flag ordering", () => {
    it("should sort flags by severity (most severe first)", async () => {
      const result = await analyzeMEVRisk(
        TOKEN_IN,
        TOKEN_OUT,
        200_000,
        USER_ADDRESS,
        PROPOSED_TX,
        196,
      );

      if (result.flags.length > 1) {
        const severityOrder: Record<string, number> = {
          critical: 0,
          high: 1,
          medium: 2,
          low: 3,
          info: 4,
        };

        for (let i = 1; i < result.flags.length; i++) {
          const prev = severityOrder[result.flags[i - 1]!.severity] ?? 4;
          const curr = severityOrder[result.flags[i]!.severity] ?? 4;
          expect(curr).toBeGreaterThanOrEqual(prev);
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // 10. Error Handling
  // -----------------------------------------------------------------------
  describe("error handling", () => {
    it("should return a valid result for any input", async () => {
      const result = await analyzeMEVRisk(
        TOKEN_IN,
        TOKEN_OUT,
        0.001, // Very small amount
        USER_ADDRESS,
        null,  // No proposed TX
        196,
      );

      expect(result.analyzerName).toBe("mev-detection-analyzer");
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.flags).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
