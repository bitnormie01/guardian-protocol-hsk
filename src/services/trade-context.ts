import { formatUnits, parseAbi } from "viem";
import type {
  Address,
  GuardianEvaluationRequest,
  SupportedChainId,
} from "../types/input.js";
import type { ResolvedTradeContext } from "../types/internal.js";
import type { DexQuoteData } from "../types/hashkey-api.js";
import type { OptimizedRouting } from "../types/output.js";
import { HashKeyRPCClient } from "./hashkey-rpc-client.js";
import { GoPlusSecurityClient } from "./goplus-security-client.js";
import { GuardianError, ErrorCode } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const ERC20_METADATA_ABI = parseAbi([
  "function decimals() view returns (uint8)",
]);

const UNISWAP_V3_FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);

const UNISWAP_V3_POOL_LIQUIDITY_ABI = parseAbi([
  "function liquidity() view returns (uint128)",
]);

const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as Address;
const COMMON_V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

const UNISWAP_V3_FACTORY_BY_CHAIN: Partial<Record<SupportedChainId, Address>> = {
  // HashKey Chain mainnet — verified live V3-compatible factory.
  177: "0xD136e36610f35E0Cc3cAd40de858c151f2AA65D4" as Address,
};

function requireAmountRaw(request: GuardianEvaluationRequest): string {
  const amountRaw = request.amountRaw ?? request.amount;
  if (!amountRaw) {
    throw new GuardianError(
      ErrorCode.ANALYZER_ERROR,
      "GuardianEvaluationRequest requires amountRaw (preferred) or amount",
    );
  }

  try {
    const value = BigInt(amountRaw);
    if (value <= 0n) {
      throw new Error("must be positive");
    }
  } catch {
    throw new GuardianError(
      ErrorCode.ANALYZER_ERROR,
      `Invalid amountRaw "${amountRaw}". Guardian expects raw token units as a positive integer string.`,
    );
  }

  return amountRaw;
}

async function readTokenDecimals(
  rpcClient: HashKeyRPCClient,
  tokenAddress: Address,
): Promise<number> {
  return rpcClient.readContract<number>({
    address: tokenAddress,
    abi: ERC20_METADATA_ABI,
    functionName: "decimals",
  });
}

function parseTokenUnitPrice(raw?: string | null): number | null {
  if (!raw || raw === "null") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatAmount(amountRaw: bigint, decimals: number): string {
  return formatUnits(amountRaw, decimals);
}

function buildOptimizedRouting(
  quote: DexQuoteData,
  tokenOutDecimals: number,
  maxSlippageBps: number,
  routerAddress: Address | null,
): OptimizedRouting {
  return {
    aggregator: "DEX API",
    path: quote.dexRouterList.map((route) => ({
      poolAddress: null,
      protocol:
        route.dexProtocol?.dexName ??
        route.dexName ??
        "Unknown protocol",
      tokenIn: route.fromToken.tokenContractAddress as Address,
      tokenOut: route.toToken.tokenContractAddress as Address,
      fee: null,
      percent: Number(route.dexProtocol?.percent ?? route.percent ?? "100"),
    })),
    expectedOutputAmount: formatAmount(
      BigInt(quote.toTokenAmount),
      tokenOutDecimals,
    ),
    expectedOutputAmountRaw: quote.toTokenAmount,
    slippageBps: maxSlippageBps,
    estimatedGas: quote.estimateGasFee ?? null,
    txHex: null,
    routerAddress,
    quoteOnly: true,
  };
}

async function resolvePoolAddress(
  rpcClient: HashKeyRPCClient,
  chainId: SupportedChainId,
  tokenIn: Address,
  tokenOut: Address,
): Promise<Address | null> {
  const factory = UNISWAP_V3_FACTORY_BY_CHAIN[chainId];
  if (!factory) {
    return null;
  }

  const candidatePools = await Promise.all(
    COMMON_V3_FEE_TIERS.map(async (feeTier) => {
      const poolAddress = await rpcClient.readContract<Address>({
        address: factory,
        abi: UNISWAP_V3_FACTORY_ABI,
        functionName: "getPool",
        args: [tokenIn, tokenOut, feeTier],
      });

      if (!poolAddress || poolAddress === ZERO_ADDRESS) {
        return null;
      }

      try {
        const liquidity = await rpcClient.readContract<bigint>({
          address: poolAddress,
          abi: UNISWAP_V3_POOL_LIQUIDITY_ABI,
          functionName: "liquidity",
        });

        return {
          poolAddress,
          feeTier,
          liquidity,
        };
      } catch {
        return null;
      }
    }),
  );

  const viablePools = candidatePools.filter(
    (pool): pool is NonNullable<typeof pool> => pool !== null,
  );

  if (viablePools.length === 0) {
    return null;
  }

  viablePools.sort((a, b) => {
    if (a.liquidity === b.liquidity) {
      return a.feeTier - b.feeTier;
    }
    return a.liquidity > b.liquidity ? -1 : 1;
  });

  return viablePools[0]!.poolAddress;
}

export async function resolveTradeContext(
  request: GuardianEvaluationRequest,
  chainId: SupportedChainId,
  maxSlippageBps: number,
  goPlusClient?: GoPlusSecurityClient,
  rpcClient?: HashKeyRPCClient,
): Promise<ResolvedTradeContext> {
  const amountRaw = requireAmountRaw(request);
  const amountRawBigInt = BigInt(amountRaw);
  const goPlus = goPlusClient ?? new GoPlusSecurityClient();
  const rpc = rpcClient ?? new HashKeyRPCClient(chainId);

  let liveQuote: DexQuoteData | null = null;

  try {
    liveQuote = await goPlus.getDexQuote({
      chainId,
      fromTokenAddress: request.tokenIn,
      toTokenAddress: request.tokenOut,
      amountRaw,
      swapMode: "exactIn",
      singleRouteOnly: true,
      singlePoolPerHop: true,
      priceImpactProtectionPercent: 90,
    });
  } catch (err) {
    logger.warn("[trade-context] Failed to fetch DEX quote; falling back", {
      error: err instanceof Error ? err.message : String(err),
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      chainId,
    });
  }

  const quoteRoute = liveQuote?.dexRouterList[0];

  const tokenInDecimalsPromise =
    request.tokenInDecimals !== undefined
      ? Promise.resolve(request.tokenInDecimals)
      : liveQuote?.dexRouterList[0]?.fromToken.decimal
        ? Promise.resolve(Number(liveQuote.dexRouterList[0]!.fromToken.decimal))
        : readTokenDecimals(rpc, request.tokenIn);

  const tokenOutDecimalsPromise =
    request.tokenOutDecimals !== undefined
      ? Promise.resolve(request.tokenOutDecimals)
      : request.quoteContext?.tokenOutDecimals !== undefined
        ? Promise.resolve(request.quoteContext.tokenOutDecimals)
        : quoteRoute?.toToken.decimal
          ? Promise.resolve(Number(quoteRoute.toToken.decimal))
          : readTokenDecimals(rpc, request.tokenOut);

  const [tokenInDecimals, tokenOutDecimals, resolvedPoolAddress] =
    await Promise.all([
      tokenInDecimalsPromise,
      tokenOutDecimalsPromise,
      request.poolAddress
        ? Promise.resolve(request.poolAddress)
        : resolvePoolAddress(rpc, chainId, request.tokenIn, request.tokenOut),
    ]);

  const quoteSource =
    request.quoteContext !== undefined
      ? "caller"
      : liveQuote !== null
        ? "dex-api"
        : "fallback";

  const expectedOutputRawString =
    request.quoteContext?.expectedOutputAmountRaw ?? liveQuote?.toTokenAmount;
  const expectedOutputRaw =
    expectedOutputRawString !== undefined
      ? BigInt(expectedOutputRawString)
      : null;

  const fromTokenPrice =
    parseTokenUnitPrice(quoteRoute?.fromToken.tokenUnitPrice) ?? null;
  const humanAmount = Number(formatAmount(amountRawBigInt, tokenInDecimals));
  const estimatedTradeUsd =
    request.quoteContext?.estimatedUsd ??
    (fromTokenPrice !== null ? humanAmount * fromTokenPrice : humanAmount);

  const routerAddress = request.quoteContext?.routerAddress ?? null;
  const optimizedRouting =
    liveQuote !== null
      ? buildOptimizedRouting(
          liveQuote,
          tokenOutDecimals,
          maxSlippageBps,
          routerAddress,
        )
      : null;

  return {
    chainId,
    tokenIn: request.tokenIn,
    tokenOut: request.tokenOut,
    amountRaw,
    amountRawBigInt,
    tokenInDecimals,
    tokenOutDecimals,
    amountInDecimal: formatAmount(amountRawBigInt, tokenInDecimals),
    userAddress: request.userAddress,
    proposedTxHex: request.proposedTxHex,
    expectedOutputRaw,
    estimatedTradeUsd,
    targetAddress: request.proposedTxTarget ?? routerAddress,
    poolAddress: resolvedPoolAddress,
    optimizedRouting,
    contextSource: quoteSource,
    hasQuoteData:
      request.quoteContext !== undefined || liveQuote !== null,
  };
}
