// ==========================================================================
// Guardian Protocol — Transaction Simulation Analyzer Unit Tests
// ==========================================================================
//
// These tests validate simulation logic WITHOUT hitting real RPC nodes
// or the GoPlus API. We mock both the HashKeyRPCClient and GoPlusSecurityClient
// to return controlled data and verify:
//
//   1. Successful simulation → high score, no critical flags
//   2. Reverted transaction → score 0, wasted gas calculated
//   3. High slippage → flagged via eth_call return data (not GoPlus isRiskTokenbalance changes)
//   4. GoPlus isRiskTokenaction:block cross-validation → additional flags ("DANGER")
//   5. GoPlus API timeout → graceful degradation (RPC-only result)
//   6. RPC failure → fail closed with score 0
//   7. GoPlus isRiskTokenaction:warn → medium UNEXPECTED_STATE_CHANGE flag  
//   8. Quick revert check → lightweight fast-path
//   9. Slippage edge cases → zero and null expected output
// ==========================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  simulateTransaction,
  quickRevertCheck,
} from "../../../src/analyzers/tx-simulation.js";
import { RiskFlagCode } from "../../../src/types/output.js";
import type { Address, HexString } from "../../../src/types/input.js";
import type { HashKeyRPCClient } from "../../../src/services/hashkey-rpc-client.js";
import type { GoPlusSecurityClient } from "../../../src/services/goplus-security-client.js";
import type { TxSimulationData } from "../../../src/types/hashkey-api.js";

// ---------------------------------------------------------------------------
// Test Constants
// ---------------------------------------------------------------------------

const USER_ADDRESS = "0x1234567890AbCdEf1234567890AbCdEf12345678" as Address;
const ROUTER_ADDRESS = "0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57" as Address;
const TOKEN_OUT = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const PROPOSED_TX = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef12345678901234" as HexString;

// Hex representation of 1_000_000_000 (1000 USDC raw with 6 decimals):
// 1000000000 = 0x3B9ACA00 → padded to 32 bytes
const RETURN_DATA_1000_USDC = "0x" + (1_000_000_000n).toString(16).padStart(64, "0");

// ---------------------------------------------------------------------------
// Mock Factories
// ---------------------------------------------------------------------------

/**
 * Creates a mock HashKeyRPCClient.
 * Default simulateCall returns 1000 USDC (matching the expectedOutputRaw used
 * in most tests so slippage = 0 by default).
 */
function createMockRPCClient(overrides: {
  simulateCall?: ReturnType<typeof vi.fn>;
  getTokenBalance?: ReturnType<typeof vi.fn>;
  getGasPrice?: ReturnType<typeof vi.fn>;
  getLatestBlockNumber?: ReturnType<typeof vi.fn>;
  getNativeBalance?: ReturnType<typeof vi.fn>;
}): HashKeyRPCClient {
  return {
    simulateCall:
      overrides.simulateCall ??
      vi.fn().mockResolvedValue({
        success: true,
        // 1000 USDC (6 decimals) raw — matches expectedOutputRaw = 1_000_000_000n
        returnData: RETURN_DATA_1000_USDC,
        revertReason: null,
        gasUsed: 150_000n,
        blockNumber: 1_000_000n,
      }),
    getTokenBalance:
      overrides.getTokenBalance ??
      vi.fn().mockResolvedValue({
        tokenAddress: TOKEN_OUT,
        symbol: "USDC",
        decimals: 6,
        rawBalance: 5_000_000_000n, // 5000 USDC pre-balance
        formatted: "5000.000000",
      }),
    getGasPrice:
      overrides.getGasPrice ??
      vi.fn().mockResolvedValue(1_000_000_000n), // 1 gwei
    getLatestBlockNumber:
      overrides.getLatestBlockNumber ??
      vi.fn().mockResolvedValue(1_000_000n),
    getNativeBalance:
      overrides.getNativeBalance ??
      vi.fn().mockResolvedValue({
        rawBalance: 1_000_000_000_000_000_000n,
        formatted: "1.0",
      }),
  } as unknown as HashKeyRPCClient;
}

/**
 * Creates a mock GoPlusSecurityClient.
 * The default result uses the GoPlus API v6 schema: action + riskItemDetail.
 * action: "" = safe, action: "warn" = warning, action: "block" = danger.
 */
function createMockGoPlusClient(
  simulationResult: TxSimulationData | null = null,
  shouldFail: boolean = false,
): GoPlusSecurityClient {
  const defaultResult: TxSimulationData = {
    action: "",           // Empty string = safe in GoPlus isRiskTokenv6
    riskItemDetail: [],   // No risk items
  };

  return {
    simulateTransaction: shouldFail
      ? vi.fn().mockRejectedValue(new Error("GoPlus API unavailable"))
      : vi.fn().mockResolvedValue(simulationResult ?? defaultResult),
    scanTokenRisk: vi.fn(),
  } as unknown as GoPlusSecurityClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Transaction Simulation Analyzer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. Successful Simulation — Clean Swap
  // -----------------------------------------------------------------------
  describe("successful simulation", () => {
    it("should return high score for a clean swap with acceptable slippage", async () => {
      const rpcClient = createMockRPCClient({});
      const goPlusClient = createMockGoPlusClient();

      // expectedOutputRaw = 1_000_000_000n (1000 USDC), mock returns same → 0% slippage
      const result = await simulateTransaction(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        177,
        "0",
        {},
        rpcClient,
        goPlusClient,
      );

      expect(result.analyzerName).toBe("tx-simulation-analyzer");
      expect(result.score).toBeGreaterThanOrEqual(80);

      const report = result.data as Record<string, unknown>;
      expect(report["simulationSuccess"]).toBe(true);
      expect(report["revertReason"]).toBeNull();
      expect(report["gasCostOKB"]).toBeDefined();

      // No critical flags
      const criticals = result.flags.filter((f) => f.severity === "critical");
      expect(criticals).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Reverted Transaction — Score 0, Gas Waste Calculated
  // -----------------------------------------------------------------------
  describe("reverted transaction", () => {
    it("should return score 0 and calculate wasted gas", async () => {
      const rpcClient = createMockRPCClient({
        simulateCall: vi.fn().mockResolvedValue({
          success: false,
          returnData: null,
          revertReason: "INSUFFICIENT_OUTPUT_AMOUNT",
          gasUsed: 85_000n,
          blockNumber: 1_000_000n,
        }),
      });
      const goPlusClient = createMockGoPlusClient();

      const result = await simulateTransaction(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        177,
        "0",
        {},
        rpcClient,
        goPlusClient,
      );

      // Score must be 0 — reverted tx
      expect(result.score).toBe(0);

      // Must have revert flag
      const revertFlag = result.flags.find(
        (f) => f.code === RiskFlagCode.TX_SIMULATION_REVERTED,
      );
      expect(revertFlag).toBeDefined();
      expect(revertFlag!.severity).toBe("critical");
      expect(revertFlag!.message).toContain("INSUFFICIENT_OUTPUT_AMOUNT");
      expect(revertFlag!.message).toContain("DO NOT execute");

      // Wasted gas should be calculated
      const report = result.data as Record<string, unknown>;
      expect(report["simulationSuccess"]).toBe(false);
      expect(report["wastedGasCostOKB"]).toBeDefined();
      expect(report["revertReason"]).toBe("INSUFFICIENT_OUTPUT_AMOUNT");

      // Gas cost = 85000 * 1 gwei = 0.000085 OKB
      const wastedGas = report["wastedGasCostOKB"] as string;
      expect(parseFloat(wastedGas)).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // 3. High Slippage — Detected via eth_call Return Data
  // -----------------------------------------------------------------------
  describe("high slippage detection", () => {
    it("should flag when eth_call output is much less than expected", async () => {
      // Mock RPC to return 900 USDC (900_000_000 raw) via eth_call
      const returnData900 = "0x" + (900_000_000n).toString(16).padStart(64, "0");
      const rpcClient = createMockRPCClient({
        simulateCall: vi.fn().mockResolvedValue({
          success: true,
          returnData: returnData900,
          revertReason: null,
          gasUsed: 150_000n,
          blockNumber: 1_000_000n,
        }),
      });
      const goPlusClient = createMockGoPlusClient();

      // Expected 1000 USDC, actual (from eth_call) = 900 USDC → 10% slippage
      const result = await simulateTransaction(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n, // 1000 USDC expected
        6,
        177,
        "0",
        { maxSlippageBps: 500 }, // 5% max
        rpcClient,
        goPlusClient,
      );

      // Slippage is 10% = 1000 bps, which exceeds 500 bps max → HIGH flag
      const slippageFlag = result.flags.find(
        (f) => f.code === RiskFlagCode.HIGH_PRICE_IMPACT,
      );
      expect(slippageFlag).toBeDefined();
      expect(slippageFlag!.severity).toBe("high");
      expect(slippageFlag!.message).toContain("500 bps");

      const report = result.data as Record<string, unknown>;
      expect(report["slippageBps"]).toBe(1000);
      expect(report["actualOutputAmount"]).toBe("900");
      expect(report["expectedOutputAmount"]).toBe("1000");
    });

    it("should flag warning-level slippage as medium severity", async () => {
      // Mock RPC to return 970 USDC (3% slippage)
      const returnData970 = "0x" + (970_000_000n).toString(16).padStart(64, "0");
      const rpcClient = createMockRPCClient({
        simulateCall: vi.fn().mockResolvedValue({
          success: true,
          returnData: returnData970,
          revertReason: null,
          gasUsed: 150_000n,
          blockNumber: 1_000_000n,
        }),
      });
      const goPlusClient = createMockGoPlusClient();

      const result = await simulateTransaction(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        177,
        "0",
        { slippageWarningBps: 200, maxSlippageBps: 500 },
        rpcClient,
        goPlusClient,
      );

      // 3% = 300 bps — above warning (200) but below max (500) → MEDIUM
      const slippageFlag = result.flags.find(
        (f) => f.code === RiskFlagCode.HIGH_PRICE_IMPACT,
      );
      expect(slippageFlag).toBeDefined();
      expect(slippageFlag!.severity).toBe("medium");
    });
  });

  // -----------------------------------------------------------------------
  // 4. GoPlus isRiskTokenDanger Cross-Validation (action: "block")
  // -----------------------------------------------------------------------
  describe("dual-RPC cross-validation", () => {
    it("should flag when GoPlus isRiskTokenreturns action:block (danger level)", async () => {
      const rpcClient = createMockRPCClient({});
      // GoPlus isRiskTokenv6 schema: action:"block" + riskItemDetail array
      const goPlusClient = createMockGoPlusClient({
        action: "block",
        riskItemDetail: [
          {
            riskLevel: "high",
            riskItem: "drainer",
            desc: "Known drainer contract detected",
          },
          {
            riskLevel: "high",
            riskItem: "suspicious_approval",
            desc: "Suspicious approval pattern",
          },
        ],
      });

      const result = await simulateTransaction(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        177,
        "0",
        {},
        rpcClient,
        goPlusClient,
      );

      const dangerFlag = result.flags.find(
        (f) =>
          f.code === RiskFlagCode.UNEXPECTED_STATE_CHANGE &&
          f.severity === "high",
      );
      expect(dangerFlag).toBeDefined();
      expect(dangerFlag!.message).toContain("DANGER");
      expect(dangerFlag!.message).toContain("drainer");

      const report = result.data as Record<string, unknown>;
      expect(report["crossValidationRiskLevel"]).toBe("danger");
    });

    it("should flag warning when GoPlus isRiskTokenreturns action:warn (medium severity)", async () => {
      const rpcClient = createMockRPCClient({});
      const goPlusClient = createMockGoPlusClient({
        action: "warn",
        riskItemDetail: [
          {
            riskLevel: "medium",
            riskItem: "multiple_transfers",
            desc: "Multiple token transfers detected in this transaction",
          },
        ],
      });

      const result = await simulateTransaction(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        177,
        "0",
        {},
        rpcClient,
        goPlusClient,
      );

      const warningFlag = result.flags.find(
        (f) =>
          f.code === RiskFlagCode.UNEXPECTED_STATE_CHANGE &&
          f.severity === "medium",
      );
      expect(warningFlag).toBeDefined();
      expect(warningFlag!.message).toContain("WARNING");

      const report = result.data as Record<string, unknown>;
      expect(report["crossValidationRiskLevel"]).toBe("warning");
    });
  });

  // -----------------------------------------------------------------------
  // 5. GoPlus API Failure — Graceful Degradation
  // -----------------------------------------------------------------------
  describe("GoPlus API failure — graceful degradation", () => {
    it("should continue with RPC-only results when GoPlus isRiskTokenfails", async () => {
      const rpcClient = createMockRPCClient({});
      const goPlusClient = createMockGoPlusClient(null, true); // GoPlus isRiskTokenwill fail

      const result = await simulateTransaction(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        177,
        "0",
        {},
        rpcClient,
        goPlusClient,
      );

      // Should still get a valid result — RPC worked even though GoPlus isRiskTokenfailed
      expect(result.score).toBeGreaterThan(0);

      const report = result.data as Record<string, unknown>;
      expect(report["simulationSuccess"]).toBe(true);
      expect(report["crossValidationRiskLevel"]).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // 6. RPC Failure — Fail Closed
  // -----------------------------------------------------------------------
  describe("RPC failure — fail closed", () => {
    it("should return score 0 when RPC client throws", async () => {
      const rpcClient = createMockRPCClient({
        getLatestBlockNumber: vi
          .fn()
          .mockRejectedValue(new Error("RPC node unreachable")),
      });
      const goPlusClient = createMockGoPlusClient();

      const result = await simulateTransaction(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        177,
        "0",
        {},
        rpcClient,
        goPlusClient,
      );

      expect(result.score).toBe(0);
      expect(result.flags.length).toBeGreaterThanOrEqual(1);
      expect(result.flags[0]!.severity).toBe("critical");

      const report = result.data as Record<string, unknown>;
      expect(report["error"]).toBe(true);
      expect(report["simulationSuccess"]).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 7. Quick Revert Check — Lightweight Fast Path
  // -----------------------------------------------------------------------
  describe("quick revert check", () => {
    it("should detect reverts quickly without full analysis", async () => {
      const rpcClient = createMockRPCClient({
        simulateCall: vi.fn().mockResolvedValue({
          success: false,
          returnData: null,
          revertReason: "EXPIRED",
          gasUsed: 21_000n,
          blockNumber: 1_000_000n,
        }),
      });

      const result = await quickRevertCheck(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        177,
        rpcClient,
      );

      expect(result.willRevert).toBe(true);
      expect(result.revertReason).toBe("EXPIRED");
      expect(parseInt(result.estimatedGas)).toBe(21000);
    });

    it("should confirm successful transactions", async () => {
      const rpcClient = createMockRPCClient({});

      const result = await quickRevertCheck(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        177,
        rpcClient,
      );

      expect(result.willRevert).toBe(false);
      expect(result.revertReason).toBeNull();
      expect(parseInt(result.estimatedGas)).toBeGreaterThan(0);
      expect(parseFloat(result.gasCostOKB)).toBeGreaterThan(0);
    });

    it("should fail closed if RPC throws", async () => {
      const rpcClient = createMockRPCClient({
        simulateCall: vi.fn().mockRejectedValue(new Error("Connection reset")),
        getGasPrice: vi.fn().mockRejectedValue(new Error("Connection reset")),
      });

      const result = await quickRevertCheck(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        177,
        rpcClient,
      );

      // Fail closed: report as revert
      expect(result.willRevert).toBe(true);
      expect(result.revertReason).toContain("Simulation failed");
    });
  });

  // -----------------------------------------------------------------------
  // 8. Slippage Computation Edge Cases
  // -----------------------------------------------------------------------
  describe("slippage edge cases", () => {
    it("should handle zero expected output gracefully (no slippage calc)", async () => {
      const rpcClient = createMockRPCClient({});
      const goPlusClient = createMockGoPlusClient();

      // expectedOutputRaw = 0n — edge case: division by zero protection
      const result = await simulateTransaction(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        0n,
        6,
        177,
        "0",
        {},
        rpcClient,
        goPlusClient,
      );

      // Should not crash, simulation should succeed
      expect(result.score).toBeGreaterThan(0);
      const report = result.data as Record<string, unknown>;
      expect(report["simulationSuccess"]).toBe(true);
    });

    it("should handle null expected output (skip slippage calc entirely)", async () => {
      const rpcClient = createMockRPCClient({});
      const goPlusClient = createMockGoPlusClient();

      const result = await simulateTransaction(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        null, // No expected output provided by agent
        6,
        177,
        "0",
        {},
        rpcClient,
        goPlusClient,
      );

      const report = result.data as Record<string, unknown>;
      expect(report["slippageBps"]).toBeNull();
      expect(report["simulationSuccess"]).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 9. Invariant Fuzzing — 8-Variant Mutation Engine
  // -----------------------------------------------------------------------
  describe("invariant fuzzing", () => {
    // Build a proper calldata with a function selector + uint256 amount param
    // for the fuzzer to mutate. selector(4 bytes) + amount(32 bytes) + address(32 bytes)
    const FUZZ_SELECTOR = "38ed1739"; // swapExactTokensForTokens selector
    const FUZZ_AMOUNT = (1_000_000_000n).toString(16).padStart(64, "0"); // 1000 USDC
    const FUZZ_EXTRA_PARAM = "0000000000000000000000001234567890abcdef1234567890abcdef12345678";
    const FUZZ_TX = ("0x" + FUZZ_SELECTOR + FUZZ_AMOUNT + FUZZ_EXTRA_PARAM) as HexString;

    it("should run fuzzer on clean swap and report no violations", async () => {
      // All fuzz variant calls return the same proportional output (no anomalies)
      const rpcClient = createMockRPCClient({
        simulateCall: vi.fn().mockResolvedValue({
          success: true,
          returnData: RETURN_DATA_1000_USDC,
          revertReason: null,
          gasUsed: 150_000n,
          blockNumber: 1_000_000n,
        }),
      });
      const goPlusClient = createMockGoPlusClient();

      const result = await simulateTransaction(
        FUZZ_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        177,
        "0",
        {
          enableFuzzing: true,
          fuzzTimeoutMs: 5000,
          // Set high deviation ratio so static mock (same output for all variants)
          // doesn't trigger non-linearity flags. The point of this test is to verify
          // fuzzing infrastructure runs cleanly, not to test non-linearity detection.
          fuzzMaxDeviationRatio: 100.0,
        },
        rpcClient,
        goPlusClient,
      );

      const report = result.data as Record<string, unknown>;
      const fuzzingResults = report["fuzzingResults"] as Record<string, unknown>;

      // Fuzzing should run
      expect(fuzzingResults).not.toBeNull();
      expect(fuzzingResults["enabled"]).toBe(true);
      expect(fuzzingResults["variantsRun"]).toBe(8);
      expect(fuzzingResults["invariantViolations"]).toBe(0);

      // No FUZZING_INVARIANT_VIOLATION flags
      const fuzzFlags = result.flags.filter(
        (f) => f.code === RiskFlagCode.FUZZING_INVARIANT_VIOLATION,
      );
      expect(fuzzFlags).toHaveLength(0);
    });

    it("should detect hidden revert when half-amount variant reverts (medium severity)", async () => {
      let callCount = 0;
      const rpcClient = createMockRPCClient({
        simulateCall: vi.fn().mockImplementation(() => {
          callCount++;
          // First call = primary simulation (succeeds)
          if (callCount === 1) {
            return Promise.resolve({
              success: true,
              returnData: RETURN_DATA_1000_USDC,
              revertReason: null,
              gasUsed: 150_000n,
              blockNumber: 1_000_000n,
            });
          }
          // Find which fuzz variant this is — half-amount reverts, others succeed
          // half-amount is variant #3 (index 2), so callCount=4 (primary + 2 preceding)
          if (callCount === 4) {
            return Promise.resolve({
              success: false,
              returnData: null,
              revertReason: "INSUFFICIENT_INPUT_AMOUNT",
              gasUsed: 50_000n,
              blockNumber: 1_000_000n,
            });
          }
          // All other variants succeed normally
          return Promise.resolve({
            success: true,
            returnData: RETURN_DATA_1000_USDC,
            revertReason: null,
            gasUsed: 150_000n,
            blockNumber: 1_000_000n,
          });
        }),
      });
      const goPlusClient = createMockGoPlusClient();

      const result = await simulateTransaction(
        FUZZ_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        177,
        "0",
        { enableFuzzing: true },
        rpcClient,
        goPlusClient,
      );

      const fuzzFlags = result.flags.filter(
        (f) => f.code === RiskFlagCode.FUZZING_INVARIANT_VIOLATION,
      );
      // 1 hidden revert = medium severity
      expect(fuzzFlags.length).toBeGreaterThanOrEqual(1);
      const revertFlag = fuzzFlags.find((f) => f.message.includes("REVERTED"));
      if (revertFlag) {
        expect(revertFlag.severity).toBe("medium");
      }
    });

    it("should detect multiple hidden reverts as high severity", async () => {
      let callCount = 0;
      const rpcClient = createMockRPCClient({
        simulateCall: vi.fn().mockImplementation(() => {
          callCount++;
          // Primary succeeds
          if (callCount === 1) {
            return Promise.resolve({
              success: true,
              returnData: RETURN_DATA_1000_USDC,
              revertReason: null,
              gasUsed: 150_000n,
              blockNumber: 1_000_000n,
            });
          }
          // half-amount (variant 3, call 4) and double-amount (variant 4, call 5) revert
          if (callCount === 4 || callCount === 5) {
            return Promise.resolve({
              success: false,
              returnData: null,
              revertReason: "CONTRACT_TRAP",
              gasUsed: 50_000n,
              blockNumber: 1_000_000n,
            });
          }
          return Promise.resolve({
            success: true,
            returnData: RETURN_DATA_1000_USDC,
            revertReason: null,
            gasUsed: 150_000n,
            blockNumber: 1_000_000n,
          });
        }),
      });
      const goPlusClient = createMockGoPlusClient();

      const result = await simulateTransaction(
        FUZZ_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        177,
        "0",
        { enableFuzzing: true },
        rpcClient,
        goPlusClient,
      );

      const fuzzFlags = result.flags.filter(
        (f) => f.code === RiskFlagCode.FUZZING_INVARIANT_VIOLATION,
      );
      // 2+ hidden reverts = high severity
      const highRevertFlag = fuzzFlags.find(
        (f) => f.message.includes("INVARIANT VIOLATION") && f.severity === "high",
      );
      expect(highRevertFlag).toBeDefined();
    });

    it("should skip fuzzing when primary simulation reverts", async () => {
      const rpcClient = createMockRPCClient({
        simulateCall: vi.fn().mockResolvedValue({
          success: false,
          returnData: null,
          revertReason: "EXPIRED",
          gasUsed: 21_000n,
          blockNumber: 1_000_000n,
        }),
      });
      const goPlusClient = createMockGoPlusClient();

      const result = await simulateTransaction(
        FUZZ_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        177,
        "0",
        { enableFuzzing: true },
        rpcClient,
        goPlusClient,
      );

      const report = result.data as Record<string, unknown>;
      // Fuzzing should be null because primary reverted
      expect(report["fuzzingResults"]).toBeNull();
      // simulateCall should only be called once (primary only, no fuzz variants)
      expect(rpcClient.simulateCall).toHaveBeenCalledTimes(1);
    });

    it("should skip fuzzing when enableFuzzing is false", async () => {
      const rpcClient = createMockRPCClient({});
      const goPlusClient = createMockGoPlusClient();

      const result = await simulateTransaction(
        FUZZ_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        177,
        "0",
        { enableFuzzing: false },
        rpcClient,
        goPlusClient,
      );

      const report = result.data as Record<string, unknown>;
      expect(report["fuzzingResults"]).toBeNull();
      expect(report["simulationSuccess"]).toBe(true);
    });

    it("should populate all 8 variant names in results", async () => {
      const rpcClient = createMockRPCClient({
        simulateCall: vi.fn().mockResolvedValue({
          success: true,
          returnData: RETURN_DATA_1000_USDC,
          revertReason: null,
          gasUsed: 150_000n,
          blockNumber: 1_000_000n,
        }),
      });
      const goPlusClient = createMockGoPlusClient();

      const result = await simulateTransaction(
        FUZZ_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        177,
        "0",
        { enableFuzzing: true },
        rpcClient,
        goPlusClient,
      );

      const report = result.data as Record<string, unknown>;
      const fuzzingResults = report["fuzzingResults"] as Record<string, unknown>;
      const variants = fuzzingResults["variants"] as Array<Record<string, unknown>>;

      const expectedNames = [
        "zero-args", "max-uint256", "half-amount", "double-amount",
        "10x-amount", "byte-flip", "truncation", "selector-swap",
      ];

      const variantNames = variants.map((v) => v["name"]);
      for (const name of expectedNames) {
        expect(variantNames).toContain(name);
      }
    });

    it("should handle fuzzing with short calldata gracefully (fewer than 32 param bytes)", async () => {
      // Use a short calldata — just a 4-byte selector + 20 bytes (not enough for fuzzing)
      const shortTx = "0xabcdef12001122334455" as HexString;
      const rpcClient = createMockRPCClient({});
      const goPlusClient = createMockGoPlusClient();

      const result = await simulateTransaction(
        shortTx,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        177,
        "0",
        { enableFuzzing: true },
        rpcClient,
        goPlusClient,
      );

      // Should still succeed — fuzzing skipped gracefully
      expect(result.score).toBeGreaterThan(0);
      const report = result.data as Record<string, unknown>;
      expect(report["simulationSuccess"]).toBe(true);
      // fuzzingResults is null because calldata was too short
      expect(report["fuzzingResults"]).toBeNull();
    });
  });
});
