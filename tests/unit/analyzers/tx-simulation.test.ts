// ==========================================================================
// Guardian Protocol — Transaction Simulation Analyzer Unit Tests
// ==========================================================================
//
// These tests validate simulation logic WITHOUT hitting real RPC nodes
// or the OKX API. We mock both the XLayerRPCClient and OKXSecurityClient
// to return controlled data and verify:
//
//   1. Successful simulation → high score, no critical flags
//   2. Reverted transaction → score 0, wasted gas calculated
//   3. High slippage → flagged via eth_call return data (not OKX balance changes)
//   4. OKX action:block cross-validation → additional flags ("DANGER")
//   5. OKX API timeout → graceful degradation (RPC-only result)
//   6. RPC failure → fail closed with score 0
//   7. OKX action:warn → medium UNEXPECTED_STATE_CHANGE flag  
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
import type { XLayerRPCClient } from "../../../src/services/xlayer-rpc-client.js";
import type { OKXSecurityClient } from "../../../src/services/okx-security-client.js";
import type { OKXTxSimulationData } from "../../../src/types/okx-api.js";

// ---------------------------------------------------------------------------
// Test Constants
// ---------------------------------------------------------------------------

const USER_ADDRESS = "0x1234567890AbCdEf1234567890AbCdEf12345678" as Address;
const ROUTER_ADDRESS = "0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57" as Address;
const TOKEN_OUT = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const PROPOSED_TX = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234" as HexString;

// Hex representation of 1_000_000_000 (1000 USDC raw with 6 decimals):
// 1000000000 = 0x3B9ACA00 → padded to 32 bytes
const RETURN_DATA_1000_USDC = "0x" + (1_000_000_000n).toString(16).padStart(64, "0");

// ---------------------------------------------------------------------------
// Mock Factories
// ---------------------------------------------------------------------------

/**
 * Creates a mock XLayerRPCClient.
 * Default simulateCall returns 1000 USDC (matching the expectedOutputRaw used
 * in most tests so slippage = 0 by default).
 */
function createMockRPCClient(overrides: {
  simulateCall?: ReturnType<typeof vi.fn>;
  getTokenBalance?: ReturnType<typeof vi.fn>;
  getGasPrice?: ReturnType<typeof vi.fn>;
  getLatestBlockNumber?: ReturnType<typeof vi.fn>;
  getNativeBalance?: ReturnType<typeof vi.fn>;
}): XLayerRPCClient {
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
  } as unknown as XLayerRPCClient;
}

/**
 * Creates a mock OKXSecurityClient.
 * The default result uses the OKX API v6 schema: action + riskItemDetail.
 * action: "" = safe, action: "warn" = warning, action: "block" = danger.
 */
function createMockOKXClient(
  simulationResult: OKXTxSimulationData | null = null,
  shouldFail: boolean = false,
): OKXSecurityClient {
  const defaultResult: OKXTxSimulationData = {
    action: "",           // Empty string = safe in OKX v6
    riskItemDetail: [],   // No risk items
  };

  return {
    simulateTransaction: shouldFail
      ? vi.fn().mockRejectedValue(new Error("OKX API unavailable"))
      : vi.fn().mockResolvedValue(simulationResult ?? defaultResult),
    scanTokenRisk: vi.fn(),
  } as unknown as OKXSecurityClient;
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
      const okxClient = createMockOKXClient();

      // expectedOutputRaw = 1_000_000_000n (1000 USDC), mock returns same → 0% slippage
      const result = await simulateTransaction(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        196,
        "0",
        {},
        rpcClient,
        okxClient,
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
      const okxClient = createMockOKXClient();

      const result = await simulateTransaction(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        196,
        "0",
        {},
        rpcClient,
        okxClient,
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
      const okxClient = createMockOKXClient();

      // Expected 1000 USDC, actual (from eth_call) = 900 USDC → 10% slippage
      const result = await simulateTransaction(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n, // 1000 USDC expected
        6,
        196,
        "0",
        { maxSlippageBps: 500 }, // 5% max
        rpcClient,
        okxClient,
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
      const okxClient = createMockOKXClient();

      const result = await simulateTransaction(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        196,
        "0",
        { slippageWarningBps: 200, maxSlippageBps: 500 },
        rpcClient,
        okxClient,
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
  // 4. OKX Danger Cross-Validation (action: "block")
  // -----------------------------------------------------------------------
  describe("OKX cross-validation", () => {
    it("should flag when OKX returns action:block (danger level)", async () => {
      const rpcClient = createMockRPCClient({});
      // OKX v6 schema: action:"block" + riskItemDetail array
      const okxClient = createMockOKXClient({
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
        196,
        "0",
        {},
        rpcClient,
        okxClient,
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
      expect(report["okxRiskLevel"]).toBe("danger");
    });

    it("should flag warning when OKX returns action:warn (medium severity)", async () => {
      const rpcClient = createMockRPCClient({});
      const okxClient = createMockOKXClient({
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
        196,
        "0",
        {},
        rpcClient,
        okxClient,
      );

      const warningFlag = result.flags.find(
        (f) =>
          f.code === RiskFlagCode.UNEXPECTED_STATE_CHANGE &&
          f.severity === "medium",
      );
      expect(warningFlag).toBeDefined();
      expect(warningFlag!.message).toContain("WARNING");

      const report = result.data as Record<string, unknown>;
      expect(report["okxRiskLevel"]).toBe("warning");
    });
  });

  // -----------------------------------------------------------------------
  // 5. OKX API Failure — Graceful Degradation
  // -----------------------------------------------------------------------
  describe("OKX API failure — graceful degradation", () => {
    it("should continue with RPC-only results when OKX fails", async () => {
      const rpcClient = createMockRPCClient({});
      const okxClient = createMockOKXClient(null, true); // OKX will fail

      const result = await simulateTransaction(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        196,
        "0",
        {},
        rpcClient,
        okxClient,
      );

      // Should still get a valid result — RPC worked even though OKX failed
      expect(result.score).toBeGreaterThan(0);

      const report = result.data as Record<string, unknown>;
      expect(report["simulationSuccess"]).toBe(true);
      expect(report["okxRiskLevel"]).toBeNull();
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
      const okxClient = createMockOKXClient();

      const result = await simulateTransaction(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        1_000_000_000n,
        6,
        196,
        "0",
        {},
        rpcClient,
        okxClient,
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
        196,
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
        196,
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
        196,
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
      const okxClient = createMockOKXClient();

      // expectedOutputRaw = 0n — edge case: division by zero protection
      const result = await simulateTransaction(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        0n,
        6,
        196,
        "0",
        {},
        rpcClient,
        okxClient,
      );

      // Should not crash, simulation should succeed
      expect(result.score).toBeGreaterThan(0);
      const report = result.data as Record<string, unknown>;
      expect(report["simulationSuccess"]).toBe(true);
    });

    it("should handle null expected output (skip slippage calc entirely)", async () => {
      const rpcClient = createMockRPCClient({});
      const okxClient = createMockOKXClient();

      const result = await simulateTransaction(
        PROPOSED_TX,
        USER_ADDRESS,
        ROUTER_ADDRESS,
        TOKEN_OUT,
        null, // No expected output provided by agent
        6,
        196,
        "0",
        {},
        rpcClient,
        okxClient,
      );

      const report = result.data as Record<string, unknown>;
      expect(report["slippageBps"]).toBeNull();
      expect(report["simulationSuccess"]).toBe(true);
    });
  });
});
