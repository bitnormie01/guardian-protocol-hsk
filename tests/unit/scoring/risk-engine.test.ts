// ==========================================================================
// Guardian Protocol — Risk Scoring Engine Unit Tests (Phase 2 Updated)
// ==========================================================================
//
// These tests validate the BRAIN of Guardian Protocol — the scoring
// engine that aggregates all analyzer outputs into a single verdict.
//
// Test categories:
//   1.  Perfect trade — all scores 100, zero flags → SAFE
//   2.  Critical flag → score 0, blocked
//   3.  Simulation revert → score 0, blocked
//   4.  Weighted aggregation math verification (4-analyzer)
//   5.  Sub-score floor violation → blocked
//   6.  Cross-analyzer correlation detection
//   7.  Confidence degradation (missing analyzers)
//   8.  Flag accumulation decay
//   9.  Multiple high flags → blocked
//  10.  Edge case: all analyzers failed
//  11.  Determinism: same input → same output
//  12.  Flag merging and deduplication
//  13.  Tier classification boundaries
//  14.  Weight validation (4 weights must sum to 1.0)
//  15.  Phase 2: AMM pool cross-analyzer correlations
//  16.  Phase 2: 4-analyzer confidence degradation
// ==========================================================================

import { describe, it, expect } from "vitest";
import {
  computeCompositeScore,
  mergeFlags,
} from "../../../src/scoring/risk-engine.js";
import { RiskFlagCode } from "../../../src/types/output.js";
import type { AnalyzerResult } from "../../../src/types/internal.js";
import type { RiskFlag } from "../../../src/types/output.js";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function makeResult(
  name: string,
  score: number,
  flags: RiskFlag[] = [],
  data: Record<string, unknown> = {}
): AnalyzerResult {
  return {
    analyzerName: name,
    score,
    flags,
    durationMs: 100,
    data,
  };
}

function makeFlag(
  code: RiskFlagCode,
  severity: RiskFlag["severity"],
  message: string = "test flag"
): RiskFlag {
  return { code, severity, message, source: "test" };
}

function buildMap(results: AnalyzerResult[]): Map<string, AnalyzerResult> {
  const map = new Map<string, AnalyzerResult>();
  for (const r of results) {
    map.set(r.analyzerName, r);
  }
  return map;
}

/**
 * Helper to create a full 4-analyzer result set with specified scores.
 */
function makeFourAnalyzers(
  tokenRisk: number = 100,
  txSim: number = 100,
  mev: number = 100,
  ammPool: number = 100,
  flags: RiskFlag[] = []
): AnalyzerResult[] {
  return [
    makeResult("token-risk-analyzer", tokenRisk, flags),
    makeResult("tx-simulation-analyzer", txSim),
    makeResult("mev-detection-analyzer", mev),
    makeResult("amm-pool-analyzer", ammPool),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Risk Scoring Engine", () => {
  // -----------------------------------------------------------------------
  // 1. Perfect Trade — All Scores 100, Zero Flags
  // -----------------------------------------------------------------------
  describe("perfect trade", () => {
    it("should return score 100 and SAFE tier with isSafeToExecute = true", () => {
      const results = makeFourAnalyzers(100, 100, 100, 100);

      const { safetyScore, isSafeToExecute, auditTrail } =
        computeCompositeScore(buildMap(results), []);

      expect(safetyScore.overall).toBe(100);
      expect(safetyScore.tier).toBe("SAFE");
      expect(isSafeToExecute).toBe(true);

      // Verify breakdown includes AMM pool
      expect(safetyScore.breakdown.tokenRisk).toBe(100);
      expect(safetyScore.breakdown.txSimulation).toBe(100);
      expect(safetyScore.breakdown.mevRisk).toBe(100);
      expect(safetyScore.breakdown.ammPoolRisk).toBe(100);

      // Verify audit trail
      expect(auditTrail.rawWeightedScore).toBe(100);
      expect(auditTrail.combinedPenaltyMultiplier).toBe(1);
      expect(auditTrail.confidenceFactor).toBe(1);
      expect(auditTrail.finalScore).toBe(100);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Critical Flag → Score 0, Blocked
  // -----------------------------------------------------------------------
  describe("critical flag killswitch", () => {
    it("should return score 0 when a critical flag is present", () => {
      const criticalFlag = makeFlag(
        RiskFlagCode.HONEYPOT_DETECTED,
        "critical",
        "Confirmed honeypot"
      );

      const results = [
        makeResult("token-risk-analyzer", 0, [criticalFlag]),
        makeResult("tx-simulation-analyzer", 80),
        makeResult("mev-detection-analyzer", 90),
        makeResult("amm-pool-analyzer", 100),
      ];

      const { safetyScore, isSafeToExecute } = computeCompositeScore(
        buildMap(results),
        [criticalFlag]
      );

      expect(safetyScore.overall).toBe(0);
      expect(safetyScore.tier).toBe("CRITICAL");
      expect(isSafeToExecute).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 3. Simulation Revert → Score 0, Blocked
  // -----------------------------------------------------------------------
  describe("simulation revert killswitch", () => {
    it("should return score 0 when simulation reverted", () => {
      const revertFlag = makeFlag(
        RiskFlagCode.TX_SIMULATION_REVERTED,
        "critical",
        "Transaction would revert"
      );

      const results = [
        makeResult("token-risk-analyzer", 100),
        makeResult("tx-simulation-analyzer", 0, [revertFlag]),
        makeResult("mev-detection-analyzer", 100),
        makeResult("amm-pool-analyzer", 100),
      ];

      const { safetyScore, isSafeToExecute } = computeCompositeScore(
        buildMap(results),
        [revertFlag]
      );

      expect(safetyScore.overall).toBe(0);
      expect(isSafeToExecute).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Weighted Aggregation Math (Phase 2: 4-analyzer)
  // -----------------------------------------------------------------------
  describe("weighted aggregation", () => {
    it("should compute correct weighted score (30/30/15/25 split)", () => {
      const results = makeFourAnalyzers(80, 60, 100, 90);

      const { safetyScore, auditTrail } = computeCompositeScore(
        buildMap(results),
        []
      );

      // Expected: 80 × 0.30 + 60 × 0.30 + 100 × 0.15 + 90 × 0.25
      //         = 24 + 18 + 15 + 22.5 = 79.5
      expect(auditTrail.rawWeightedScore).toBe(79.5);
      expect(safetyScore.overall).toBe(80); // Rounded
      expect(safetyScore.tier).toBe("MODERATE");
    });

    it("should handle custom weights", () => {
      const results = makeFourAnalyzers(50, 50, 50, 50);

      // All weights equal: 0.25 each
      const { safetyScore } = computeCompositeScore(
        buildMap(results),
        [],
        { tokenRisk: 0.25, txSimulation: 0.25, mevSignals: 0.25, ammPool: 0.25 }
      );

      // Should be exactly 50
      expect(safetyScore.overall).toBe(50);
    });

    it("should correctly weight AMM pool score", () => {
      // AMM pool at 0 (manipulation detected), everything else perfect
      const results = makeFourAnalyzers(100, 100, 100, 0);

      const { safetyScore, auditTrail } = computeCompositeScore(
        buildMap(results),
        []
      );

      // Expected: 100 × 0.30 + 100 × 0.30 + 100 × 0.15 + 0 × 0.25
      //         = 30 + 30 + 15 + 0 = 75
      expect(auditTrail.rawWeightedScore).toBe(75);
    });
  });

  // -----------------------------------------------------------------------
  // 5. Sub-Score Floor Violation
  // -----------------------------------------------------------------------
  describe("sub-score floor violation", () => {
    it("should block when any sub-score is below minimum", () => {
      const results = makeFourAnalyzers(10, 100, 100, 100);

      const { isSafeToExecute, auditTrail } = computeCompositeScore(
        buildMap(results),
        [],
        undefined,
        { safetyThreshold: 70, minimumSubScore: 20, maxHighFlagsBeforeBlock: 3 }
      );

      expect(isSafeToExecute).toBe(false);
      expect(
        auditTrail.safetyVerdictReasons.some((r) => r.includes("Sub-score floor"))
      ).toBe(true);
    });

    it("should block when AMM pool sub-score is below minimum", () => {
      const results = makeFourAnalyzers(100, 100, 100, 10);

      const { isSafeToExecute, auditTrail } = computeCompositeScore(
        buildMap(results),
        [],
        undefined,
        { safetyThreshold: 70, minimumSubScore: 20, maxHighFlagsBeforeBlock: 3 }
      );

      expect(isSafeToExecute).toBe(false);
      expect(
        auditTrail.safetyVerdictReasons.some((r) => r.includes("Sub-score floor"))
      ).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 6. Cross-Analyzer Correlation: High Tax + High Slippage
  // -----------------------------------------------------------------------
  describe("cross-analyzer correlations", () => {
    it("should apply penalty when high tax correlates with slippage", () => {
      const taxFlag = makeFlag(RiskFlagCode.HIGH_TAX_TOKEN, "high");
      const slippageFlag = makeFlag(RiskFlagCode.HIGH_PRICE_IMPACT, "high");

      const results = [
        makeResult("token-risk-analyzer", 50, [taxFlag]),
        makeResult("tx-simulation-analyzer", 50, [slippageFlag]),
        makeResult("mev-detection-analyzer", 80),
        makeResult("amm-pool-analyzer", 100),
      ];

      const { safetyScore, auditTrail } = computeCompositeScore(
        buildMap(results),
        [taxFlag, slippageFlag]
      );

      // The correlation penalty (0.70) should reduce the score
      const hasCorrelationPenalty = auditTrail.penaltyMultipliers.some(
        (p) => p.triggered && p.name.includes("cross_analyzer_correlation")
      );
      expect(hasCorrelationPenalty).toBe(true);

      // Score should be lower than raw weighted due to penalty
      expect(safetyScore.overall).toBeLessThan(auditTrail.rawWeightedScore);
    });
  });

  // -----------------------------------------------------------------------
  // 7. Confidence Degradation (updated for 4 analyzers)
  // -----------------------------------------------------------------------
  describe("confidence adjustment", () => {
    it("should reduce score when an analyzer is missing", () => {
      // Only 3 of 4 analyzers present
      const results = [
        makeResult("token-risk-analyzer", 80),
        makeResult("tx-simulation-analyzer", 80),
        makeResult("mev-detection-analyzer", 80),
        // amm-pool-analyzer is MISSING
      ];

      const { auditTrail } = computeCompositeScore(buildMap(results), []);

      expect(auditTrail.confidenceFactor).toBe(0.88);
      expect(auditTrail.confidenceReason).toContain("1 analyzer failed");
    });

    it("should penalize more when 2 analyzers fail", () => {
      const results = [
        makeResult("token-risk-analyzer", 80, [], { error: true, errorMessage: "API down" }),
        makeResult("tx-simulation-analyzer", 0, [], { error: true, errorMessage: "timeout" }),
        makeResult("mev-detection-analyzer", 90),
        makeResult("amm-pool-analyzer", 85),
      ];

      const { auditTrail } = computeCompositeScore(
        buildMap(results),
        []
      );

      expect(auditTrail.confidenceFactor).toBe(0.65);
    });

    it("should severely penalize when 3 analyzers fail", () => {
      const results = [
        makeResult("token-risk-analyzer", 0, [], { error: true }),
        makeResult("tx-simulation-analyzer", 0, [], { error: true }),
        makeResult("mev-detection-analyzer", 0, [], { error: true }),
        makeResult("amm-pool-analyzer", 90),
      ];

      const { auditTrail } = computeCompositeScore(
        buildMap(results),
        []
      );

      expect(auditTrail.confidenceFactor).toBe(0.35);
    });
  });

  // -----------------------------------------------------------------------
  // 8. Flag Accumulation Decay
  // -----------------------------------------------------------------------
  describe("flag accumulation decay", () => {
    it("should apply decay penalty for many flags", () => {
      // 10 medium flags (5 excess beyond threshold of 5)
      const manyFlags = Array.from({ length: 10 }, (_, i) =>
        makeFlag(
          RiskFlagCode.OWNERSHIP_NOT_RENOUNCED,
          "medium",
          `Flag ${i}`
        )
      );

      const results = [
        makeResult("token-risk-analyzer", 70, manyFlags.slice(0, 3)),
        makeResult("tx-simulation-analyzer", 70, manyFlags.slice(3, 5)),
        makeResult("mev-detection-analyzer", 70, manyFlags.slice(5, 7)),
        makeResult("amm-pool-analyzer", 70, manyFlags.slice(7)),
      ];

      const { auditTrail } = computeCompositeScore(
        buildMap(results),
        manyFlags
      );

      const decayPenalty = auditTrail.penaltyMultipliers.find(
        (p) => p.name === "flag_accumulation_decay"
      );
      expect(decayPenalty).toBeDefined();
      expect(decayPenalty!.triggered).toBe(true);
      expect(decayPenalty!.value).toBeLessThan(1.0);
    });
  });

  // -----------------------------------------------------------------------
  // 9. Multiple High Flags → Blocked
  // -----------------------------------------------------------------------
  describe("multiple high flags blocking", () => {
    it("should block when high flag count exceeds threshold", () => {
      const highFlags = [
        makeFlag(RiskFlagCode.HIGH_TAX_TOKEN, "high", "Sell tax 35%"),
        makeFlag(RiskFlagCode.MINT_FUNCTION_PRESENT, "high", "Mintable"),
        makeFlag(RiskFlagCode.HIGH_PRICE_IMPACT, "high", "Slippage 8%"),
      ];

      const results = [
        makeResult("token-risk-analyzer", 40, highFlags.slice(0, 2)),
        makeResult("tx-simulation-analyzer", 50, [highFlags[2]!]),
        makeResult("mev-detection-analyzer", 80),
        makeResult("amm-pool-analyzer", 100),
      ];

      const { isSafeToExecute } = computeCompositeScore(
        buildMap(results),
        highFlags,
        undefined,
        { safetyThreshold: 70, minimumSubScore: 20, maxHighFlagsBeforeBlock: 3 }
      );

      expect(isSafeToExecute).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 10. All Analyzers Failed
  // -----------------------------------------------------------------------
  describe("total analyzer failure", () => {
    it("should return very low score and block", () => {
      const results = [
        makeResult("token-risk-analyzer", 0, [], { error: true }),
        makeResult("tx-simulation-analyzer", 0, [], { error: true }),
        makeResult("mev-detection-analyzer", 0, [], { error: true }),
        makeResult("amm-pool-analyzer", 0, [], { error: true }),
      ];

      const { safetyScore, isSafeToExecute, auditTrail } =
        computeCompositeScore(buildMap(results), []);

      expect(safetyScore.overall).toBeLessThanOrEqual(5);
      expect(safetyScore.tier).toBe("CRITICAL");
      expect(isSafeToExecute).toBe(false);
      expect(auditTrail.confidenceFactor).toBe(0.15);
    });
  });

  // -----------------------------------------------------------------------
  // 11. Determinism
  // -----------------------------------------------------------------------
  describe("determinism guarantee", () => {
    it("should produce identical output for identical input", () => {
      const flag = makeFlag(RiskFlagCode.HIGH_TAX_TOKEN, "medium", "Sell tax 12%");

      const results = [
        makeResult("token-risk-analyzer", 65, [flag]),
        makeResult("tx-simulation-analyzer", 80),
        makeResult("mev-detection-analyzer", 72),
        makeResult("amm-pool-analyzer", 90),
      ];

      const run1 = computeCompositeScore(buildMap(results), [flag]);
      const run2 = computeCompositeScore(buildMap(results), [flag]);

      expect(run1.safetyScore.overall).toBe(run2.safetyScore.overall);
      expect(run1.safetyScore.tier).toBe(run2.safetyScore.tier);
      expect(run1.isSafeToExecute).toBe(run2.isSafeToExecute);
      expect(run1.auditTrail.rawWeightedScore).toBe(run2.auditTrail.rawWeightedScore);
      expect(run1.auditTrail.combinedPenaltyMultiplier).toBe(
        run2.auditTrail.combinedPenaltyMultiplier
      );
      expect(run1.auditTrail.confidenceFactor).toBe(run2.auditTrail.confidenceFactor);
    });
  });

  // -----------------------------------------------------------------------
  // 12. Flag Merging and Deduplication
  // -----------------------------------------------------------------------
  describe("flag merging", () => {
    it("should deduplicate by code+severity, keeping longest message", () => {
      const results: AnalyzerResult[] = [
        makeResult("token-risk-analyzer", 50, [
          makeFlag(RiskFlagCode.HIGH_TAX_TOKEN, "high", "Short message"),
        ]),
        makeResult("tx-simulation-analyzer", 60, [
          makeFlag(
            RiskFlagCode.HIGH_TAX_TOKEN,
            "high",
            "A much longer and more descriptive message about the tax"
          ),
        ]),
      ];

      const merged = mergeFlags(results);

      // Same code + severity → deduplicated to 1
      const taxFlags = merged.filter(
        (f) => f.code === RiskFlagCode.HIGH_TAX_TOKEN && f.severity === "high"
      );
      expect(taxFlags).toHaveLength(1);

      // Kept the longer message
      expect(taxFlags[0]!.message).toContain("much longer");
    });

    it("should keep flags with same code but different severity", () => {
      const results: AnalyzerResult[] = [
        makeResult("a", 50, [
          makeFlag(RiskFlagCode.HIGH_PRICE_IMPACT, "high", "Extreme slippage"),
        ]),
        makeResult("b", 60, [
          makeFlag(RiskFlagCode.HIGH_PRICE_IMPACT, "medium", "Elevated slippage"),
        ]),
      ];

      const merged = mergeFlags(results);
      const impactFlags = merged.filter(
        (f) => f.code === RiskFlagCode.HIGH_PRICE_IMPACT
      );

      // Same code, different severity → BOTH kept
      expect(impactFlags).toHaveLength(2);
    });

    it("should sort merged flags by severity (critical first)", () => {
      const results: AnalyzerResult[] = [
        makeResult("a", 0, [
          makeFlag(RiskFlagCode.LOW_HOLDER_COUNT, "low", "Few holders"),
        ]),
        makeResult("b", 0, [
          makeFlag(RiskFlagCode.HONEYPOT_DETECTED, "critical", "Honeypot"),
        ]),
        makeResult("c", 50, [
          makeFlag(RiskFlagCode.HIGH_TAX_TOKEN, "high", "High tax"),
        ]),
      ];

      const merged = mergeFlags(results);

      expect(merged[0]!.severity).toBe("critical");
      expect(merged[1]!.severity).toBe("high");
      expect(merged[2]!.severity).toBe("low");
    });
  });

  // -----------------------------------------------------------------------
  // 13. Tier Classification Boundaries
  // -----------------------------------------------------------------------
  describe("tier classification", () => {
    it("should classify tiers at exact boundaries", () => {
      const testCases = [
        { score: 0, tier: "CRITICAL" },
        { score: 29, tier: "CRITICAL" },
        { score: 30, tier: "DANGEROUS" },
        { score: 49, tier: "DANGEROUS" },
        { score: 50, tier: "CAUTION" },
        { score: 69, tier: "CAUTION" },
        { score: 70, tier: "MODERATE" },
        { score: 89, tier: "MODERATE" },
        { score: 90, tier: "SAFE" },
        { score: 100, tier: "SAFE" },
      ];

      for (const { score, tier } of testCases) {
        const results = makeFourAnalyzers(score, score, score, score);

        const { safetyScore } = computeCompositeScore(
          buildMap(results),
          []
        );

        expect(safetyScore.overall).toBe(score);
        expect(safetyScore.tier).toBe(tier);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 14. Weight Validation (4-analyzer weights)
  // -----------------------------------------------------------------------
  describe("weight validation", () => {
    it("should throw if weights don't sum to 1.0", () => {
      const results = makeFourAnalyzers(100, 100, 100, 100);

      expect(() =>
        computeCompositeScore(
          buildMap(results),
          [],
          { tokenRisk: 0.3, txSimulation: 0.3, mevSignals: 0.3, ammPool: 0.3 } // Sum = 1.2
        )
      ).toThrow("weights must sum to 1.0");
    });

    it("should accept valid 4-analyzer weights", () => {
      const results = makeFourAnalyzers(100, 100, 100, 100);

      expect(() =>
        computeCompositeScore(
          buildMap(results),
          [],
          { tokenRisk: 0.30, txSimulation: 0.30, mevSignals: 0.15, ammPool: 0.25 }
        )
      ).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // 15. Phase 2: AMM Pool Cross-Analyzer Correlations
  // -----------------------------------------------------------------------
  describe("Phase 2: AMM pool correlations", () => {
    it("should apply penalty when thin AMM liquidity correlates with high slippage", () => {
      const thinLiqFlag = makeFlag(RiskFlagCode.AMM_THIN_LIQUIDITY, "high", "Thin liquidity");
      const slippageFlag = makeFlag(RiskFlagCode.HIGH_PRICE_IMPACT, "high", "High slippage");

      const results = [
        makeResult("token-risk-analyzer", 100),
        makeResult("tx-simulation-analyzer", 50, [slippageFlag]),
        makeResult("mev-detection-analyzer", 100),
        makeResult("amm-pool-analyzer", 40, [thinLiqFlag]),
      ];

      const { auditTrail } = computeCompositeScore(
        buildMap(results),
        [thinLiqFlag, slippageFlag]
      );

      // Should detect AMM+Sim correlation
      const hasAmmCorrelation = auditTrail.penaltyMultipliers.some(
        (p) => p.triggered && p.name.includes("cross_analyzer_correlation")
      );
      expect(hasAmmCorrelation).toBe(true);
    });

    it("should apply penalty when AMM price deviation + MEV sandwich coincide", () => {
      const priceDevFlag = makeFlag(RiskFlagCode.AMM_PRICE_DEVIATION, "high", "Price deviation");
      const sandwichFlag = makeFlag(RiskFlagCode.SANDWICH_ATTACK_LIKELY, "high", "Sandwich risk");

      const results = [
        makeResult("token-risk-analyzer", 100),
        makeResult("tx-simulation-analyzer", 100),
        makeResult("mev-detection-analyzer", 40, [sandwichFlag]),
        makeResult("amm-pool-analyzer", 50, [priceDevFlag]),
      ];

      const { auditTrail } = computeCompositeScore(
        buildMap(results),
        [priceDevFlag, sandwichFlag]
      );

      const hasCoordinatedAttackCorrelation = auditTrail.penaltyMultipliers.some(
        (p) => p.triggered && p.name.includes("cross_analyzer_correlation")
      );
      expect(hasCoordinatedAttackCorrelation).toBe(true);
    });

    it("should apply penalty when one-sided AMM liquidity + mintable token", () => {
      const oneSidedFlag = makeFlag(RiskFlagCode.AMM_ONESIDED_LIQUIDITY, "high", "One-sided");
      const mintFlag = makeFlag(RiskFlagCode.MINT_FUNCTION_PRESENT, "high", "Mintable");

      const results = [
        makeResult("token-risk-analyzer", 60, [mintFlag]),
        makeResult("tx-simulation-analyzer", 100),
        makeResult("mev-detection-analyzer", 100),
        makeResult("amm-pool-analyzer", 50, [oneSidedFlag]),
      ];

      const { auditTrail } = computeCompositeScore(
        buildMap(results),
        [oneSidedFlag, mintFlag]
      );

      const hasRugPullCorrelation = auditTrail.penaltyMultipliers.some(
        (p) => p.triggered && p.name.includes("cross_analyzer_correlation")
      );
      expect(hasRugPullCorrelation).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 16. Phase 2: Audit Trail Includes AMM Pool Data
  // -----------------------------------------------------------------------
  describe("Phase 2: audit trail completeness", () => {
    it("should include ammPool in weighted contributions", () => {
      const results = makeFourAnalyzers(80, 70, 90, 85);

      const { auditTrail } = computeCompositeScore(
        buildMap(results),
        []
      );

      expect(auditTrail.weightedContributions.ammPool).toBeDefined();
      expect(auditTrail.weightedContributions.ammPool.subScore).toBe(85);
      expect(auditTrail.weightedContributions.ammPool.weight).toBe(0.25);
      expect(auditTrail.weightedContributions.ammPool.contribution).toBe(
        Math.round(85 * 0.25 * 100) / 100
      );
    });

    it("should include ammPoolRisk in safety score breakdown", () => {
      const results = makeFourAnalyzers(80, 70, 90, 65);

      const { safetyScore } = computeCompositeScore(
        buildMap(results),
        []
      );

      expect(safetyScore.breakdown.ammPoolRisk).toBe(65);
    });
  });
});
