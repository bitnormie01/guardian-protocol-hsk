import { describe, expect, it, vi } from "vitest";
import { resolveTradeContext } from "../../../src/services/trade-context.js";
import type { GuardianEvaluationRequest, Address } from "../../../src/types/input.js";
import type { OKXDexQuoteData } from "../../../src/types/okx-api.js";
import type { OKXSecurityClient } from "../../../src/services/okx-security-client.js";
import type { XLayerRPCClient } from "../../../src/services/xlayer-rpc-client.js";

const TOKEN_IN = "0xe538905cf8410324e03A5A23C1c177a474D59b2b" as Address;
const TOKEN_OUT = "0x74b7F16337b8972027F6196A17a631aC6dE26d22" as Address;
const USER = "0x6e9fb08755b837388a36ced22f26ed64240fb29c" as Address;
const POOL = "0x1111111111111111111111111111111111111111" as Address;

function createQuote(): OKXDexQuoteData {
  return {
    chainIndex: "196",
    swapMode: "exactIn",
    fromTokenAmount: "1000000000000000000",
    toTokenAmount: "4200000",
    estimateGasFee: "210000",
    dexRouterList: [
      {
        dexProtocol: {
          dexName: "Uniswap V3",
          percent: "100",
        },
        fromToken: {
          tokenContractAddress: TOKEN_IN,
          tokenSymbol: "WOKB",
          tokenUnitPrice: "52.5",
          decimal: "18",
        },
        toToken: {
          tokenContractAddress: TOKEN_OUT,
          tokenSymbol: "USDC",
          tokenUnitPrice: "1",
          decimal: "6",
        },
      },
    ],
  };
}

describe("resolveTradeContext", () => {
  it("builds quote-backed trade context without guessing", async () => {
    const request: GuardianEvaluationRequest = {
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountRaw: "1000000000000000000",
      tokenInDecimals: 18,
      tokenOutDecimals: 6,
      poolAddress: POOL,
      userAddress: USER,
    };

    const okx = {
      getDexQuote: vi.fn().mockResolvedValue(createQuote()),
    } as unknown as OKXSecurityClient;

    const rpc = {
      readContract: vi.fn(),
    } as unknown as XLayerRPCClient;

    const context = await resolveTradeContext(request, 196, 500, okx, rpc);

    expect(context.contextSource).toBe("okx-dex");
    expect(context.hasQuoteData).toBe(true);
    expect(context.poolAddress).toBe(POOL);
    expect(context.tokenInDecimals).toBe(18);
    expect(context.tokenOutDecimals).toBe(6);
    expect(context.estimatedTradeUsd).toBe(52.5);
    expect(context.expectedOutputRaw).toBe(4200000n);
    expect(context.optimizedRouting?.aggregator).toBe("OKX DEX API");
    expect(context.optimizedRouting?.expectedOutputAmount).toBe("4.2");
    expect(context.optimizedRouting?.path[0]?.protocol).toBe("Uniswap V3");
  });

  it("falls back to on-chain pool discovery when quote data is unavailable", async () => {
    const discoveredPool = "0x2222222222222222222222222222222222222222" as Address;
    const request: GuardianEvaluationRequest = {
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountRaw: "1000000000000000000",
      tokenInDecimals: 18,
      tokenOutDecimals: 6,
      userAddress: USER,
    };

    const okx = {
      getDexQuote: vi.fn().mockRejectedValue(new Error("rate limited")),
    } as unknown as OKXSecurityClient;

    const rpc = {
      readContract: vi.fn().mockImplementation(async (args: {
        functionName: string;
        args?: readonly unknown[];
      }) => {
        if (args.functionName === "getPool") {
          const feeTier = Number(args.args?.[2] ?? 0);
          return feeTier === 3000
            ? discoveredPool
            : "0x0000000000000000000000000000000000000000";
        }

        if (args.functionName === "liquidity") {
          return 1_000_000n;
        }

        throw new Error(`Unexpected readContract call: ${args.functionName}`);
      }),
    } as unknown as XLayerRPCClient;

    const context = await resolveTradeContext(request, 196, 500, okx, rpc);

    expect(context.contextSource).toBe("fallback");
    expect(context.hasQuoteData).toBe(false);
    expect(context.poolAddress).toBe(discoveredPool);
    expect(context.optimizedRouting).toBeNull();
    expect(context.estimatedTradeUsd).toBe(1);
  });
});
