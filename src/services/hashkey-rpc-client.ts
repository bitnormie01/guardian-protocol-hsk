// ==========================================================================
// Guardian Protocol — HashKey Chain JSON-RPC Client (Phase 2: RPC Redundancy)
// ==========================================================================
//
// This module provides a typed client for interacting with HashKey Chain's
// EVM-compatible JSON-RPC interface. It's the backbone of our
// transaction simulation engine.
//
// HashKey Chain (chain ID 177) is an Ethereum L2 built by HashKey Group.
// It supports standard Ethereum JSON-RPC methods including the critical
// ones we need for simulation:
//
//   • eth_call           — Execute a call without creating a tx
//   • eth_estimateGas    — Estimate gas for a tx
//   • eth_getBalance     — Get native token balance
//   • eth_getCode        — Check if address is a contract
//   • eth_blockNumber    — Get latest block number
//   • debug_traceCall    — Full EVM execution trace (if node supports)
//
// WHY A CUSTOM CLIENT (NOT JUST VIEM):
//   We wrap viem's transport layer to add:
//   1. Guardian-specific error handling (fail-closed semantics)
//   2. ROUND-ROBIN RPC FAILOVER with 1500ms per-endpoint timeout
//   3. Request tracing for the Guardian audit log
//   4. Block-pinned execution for deterministic simulation results
//   5. Per-endpoint health tracking and smart rotation
//
// PHASE 2 UPGRADE — RPC REDUNDANCY:
//   Mainnet environments are adversarial. A single RPC endpoint is a
//   single point of failure. We now maintain 3+ endpoints and rotate
//   through them on failure. Each endpoint gets a 1500ms timeout budget.
//   Total worst-case: ~4.5s across 3 endpoints (within 10s sim budget).
//
// FORKED STATE SIMULATION:
//   We don't actually fork the chain ourselves (that requires an
//   Anvil/Hardhat node). Instead, we use eth_call with a specific
//   block number ("state override" at a pinned block), which gives
//   us a deterministic snapshot of chain state.
// ==========================================================================

import {
  createPublicClient,
  http,
  type PublicClient,
  type Chain,
  type HttpTransport,
  defineChain,
  formatEther,
  formatUnits,
  parseAbi,
} from "viem";
import { GuardianError, ErrorCode } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { Address, HexString } from "../types/input.js";

// ---------------------------------------------------------------------------
// HashKey Chain Definitions
// ---------------------------------------------------------------------------

/**
 * HashKey Chain Mainnet chain definition for viem.
 * Chain ID 177, HSK as native gas token.
 */
export const hashkeyMainnet: Chain = defineChain({
  id: 177,
  name: "HashKey Chain Mainnet",
  nativeCurrency: {
    name: "HSK",
    symbol: "HSK",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://mainnet.hsk.xyz"],
    },
  },
  blockExplorers: {
    default: {
      name: "HashKey Explorer",
      url: "https://explorer.hsk.xyz",
    },
  },
});

/**
 * HashKey Chain Testnet chain definition for viem.
 */
export const hashkeyTestnet: Chain = defineChain({
  id: 133,
  name: "HashKey Chain Testnet",
  nativeCurrency: {
    name: "HSK",
    symbol: "HSK",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://testnet.hsk.xyz"],
    },
  },
  blockExplorers: {
    default: {
      name: "HashKey Explorer",
      url: "https://testnet-explorer.hsk.xyz",
    },
  },
});

// ---------------------------------------------------------------------------
// Default RPC Endpoint Lists
// ---------------------------------------------------------------------------

/**
 * Default mainnet RPC endpoints for round-robin failover.
 * Ordered by expected reliability.
 * Users can extend/override via HASHKEY_RPC_URL, HASHKEY_RPC_URL_2, HASHKEY_RPC_URL_3 env vars.
 */
const DEFAULT_MAINNET_ENDPOINTS: string[] = [
  "https://mainnet.hsk.xyz",
  "https://hashkey.drpc.org",
  "https://rpc.hashkeychain.com",
];

const DEFAULT_TESTNET_ENDPOINTS: string[] = [
  "https://testnet.hsk.xyz",
  "https://testnet.hsk.xyz", // Duplicate as final fallback (retried with fresh connection)
  "https://testnet.hsk.xyz",
];

// ---------------------------------------------------------------------------
// Round-Robin RPC Manager
// ---------------------------------------------------------------------------

/**
 * Per-endpoint health tracking metrics.
 *
 * WHY WE TRACK THIS:
 *   Smart rotation. If endpoint A has 80% failure rate in the last
 *   minute, we should try endpoint B first — not blindly round-robin.
 *   This gives us adaptive failover without manual configuration.
 */
export interface EndpointHealth {
  /** The RPC URL. */
  url: string;
  /** Total requests sent to this endpoint in the tracking window. */
  totalRequests: number;
  /** Total failures (timeouts + errors) in the tracking window. */
  totalFailures: number;
  /** Moving average latency in ms. */
  avgLatencyMs: number;
  /** Timestamp of last successful request. */
  lastSuccessAt: number;
  /** Timestamp of last failure. */
  lastFailureAt: number;
  /** Whether this endpoint is currently considered healthy. */
  isHealthy: boolean;
}

/**
 * Configuration for the round-robin RPC manager.
 */
export interface RoundRobinConfig {
  /** Timeout per individual endpoint in ms. Default: 500. */
  perEndpointTimeoutMs: number;
  /** Maximum consecutive failures before marking unhealthy. Default: 3. */
  maxConsecutiveFailures: number;
  /** Window in ms for health metric tracking. Default: 60000 (1 min). */
  healthWindowMs: number;
}

const DEFAULT_ROUND_ROBIN_CONFIG: RoundRobinConfig = {
  perEndpointTimeoutMs: Math.max(
    5000,
    Number(process.env["GUARDIAN_RPC_ENDPOINT_TIMEOUT_MS"] ?? "5000"),
  ),
  maxConsecutiveFailures: 3,
  healthWindowMs: 60_000,
};

/**
 * RoundRobinRPCManager provides transparent failover across multiple
 * HashKey Chain RPC endpoints. It wraps viem PublicClient instances and
 * rotates through them on failure.
 *
 * DESIGN PRINCIPLES:
 *   - SEAMLESS: Callers don't know which endpoint is being used
 *   - FAST FAIL: 500ms timeout per endpoint — a slow node doesn't
 *     block the pipeline, we just move to the next one
 *   - SMART ORDER: Endpoints are tried in health-score order, not
 *     just round-robin. Healthy endpoints go first.
 *   - TOTAL BUDGET: With 3 endpoints at 500ms each, worst case is
 *     ~1.5s before we declare total failure. Acceptable for mainnet.
 *   - OBSERVABLE: All rotations are logged for audit trail
 */
export class RoundRobinRPCManager {
  private readonly endpoints: string[];
  private readonly clients: Map<string, PublicClient<HttpTransport, Chain>>;
  private readonly health: Map<string, EndpointHealth>;
  private readonly config: RoundRobinConfig;
  private readonly chain: Chain;
  private currentIndex: number = 0;
  private consecutiveFailures: Map<string, number> = new Map();

  constructor(
    chain: Chain,
    endpoints: string[],
    config: Partial<RoundRobinConfig> = {},
  ) {
    if (endpoints.length === 0) {
      throw new GuardianError(
        ErrorCode.CONFIG_MISSING,
        "RoundRobinRPCManager requires at least 1 endpoint",
      );
    }

    this.chain = chain;
    // Deduplicate while preserving order, then re-add duplicates at the end
    // for retry resilience (a "failed" endpoint might work on second try
    // due to transient issues)
    this.endpoints = endpoints;
    this.config = { ...DEFAULT_ROUND_ROBIN_CONFIG, ...config };
    this.clients = new Map();
    this.health = new Map();

    // Pre-create viem clients for each unique endpoint
    const seen = new Set<string>();
    for (const url of this.endpoints) {
      if (seen.has(url)) continue;
      seen.add(url);

      const client = createPublicClient({
        chain,
        transport: http(url, {
          timeout: this.config.perEndpointTimeoutMs,
          retryCount: 0, // We handle retries ourselves via rotation
          retryDelay: 0,
        }),
      });
      this.clients.set(url, client);

      this.health.set(url, {
        url,
        totalRequests: 0,
        totalFailures: 0,
        avgLatencyMs: 0,
        lastSuccessAt: 0,
        lastFailureAt: 0,
        isHealthy: true,
      });

      this.consecutiveFailures.set(url, 0);
    }

    logger.info("[rpc-manager] RoundRobinRPCManager initialized", {
      chainId: chain.id,
      endpointCount: this.endpoints.length,
      uniqueEndpoints: seen.size,
      perEndpointTimeoutMs: this.config.perEndpointTimeoutMs,
    });
  }

  /**
   * Execute an RPC operation with automatic failover.
   *
   * Tries each endpoint in health-priority order. If the current
   * endpoint times out (500ms) or errors, seamlessly moves to the next.
   * Only throws if ALL endpoints fail.
   *
   * @param operation  - A function that receives a viem PublicClient and returns a promise
   * @param opName     - Human-readable name for logging (e.g., "getBlockNumber")
   */
  async execute<T>(
    operation: (client: PublicClient<HttpTransport, Chain>) => Promise<T>,
    opName: string = "rpc-call",
  ): Promise<T> {
    const orderedEndpoints = this.getHealthSortedEndpoints();
    const errors: Array<{ url: string; error: string }> = [];

    for (const url of orderedEndpoints) {
      const client = this.clients.get(url);
      if (!client) continue;

      const health = this.health.get(url)!;
      health.totalRequests++;
      const startTime = performance.now();

      try {
        // Race the operation against a per-endpoint timeout
        const result = await Promise.race([
          operation(client),
          this.createEndpointTimeout(url),
        ]);

        // Success — update health metrics
        const latency = Math.round(performance.now() - startTime);
        health.avgLatencyMs =
          health.avgLatencyMs === 0
            ? latency
            : Math.round(health.avgLatencyMs * 0.7 + latency * 0.3);
        health.lastSuccessAt = Date.now();
        health.isHealthy = true;
        this.consecutiveFailures.set(url, 0);

        return result as T;
      } catch (err) {
        // Failure — record and rotate
        const latency = Math.round(performance.now() - startTime);
        const errorMsg = err instanceof Error ? err.message : String(err);

        health.totalFailures++;
        health.lastFailureAt = Date.now();
        health.avgLatencyMs =
          health.avgLatencyMs === 0
            ? latency
            : Math.round(health.avgLatencyMs * 0.7 + latency * 0.3);

        const consecutiveFails = (this.consecutiveFailures.get(url) ?? 0) + 1;
        this.consecutiveFailures.set(url, consecutiveFails);

        if (consecutiveFails >= this.config.maxConsecutiveFailures) {
          health.isHealthy = false;
        }

        errors.push({ url, error: errorMsg });

        logger.debug(
          `[rpc-manager] Endpoint failed for ${opName}, rotating to next`,
          {
            failedUrl: url,
            error: errorMsg,
            latencyMs: latency,
            consecutiveFailures: consecutiveFails,
            remainingEndpoints: orderedEndpoints.length - errors.length,
          },
        );
      }
    }

    // ALL endpoints failed
    logger.error(
      `[rpc-manager] ALL ${orderedEndpoints.length} endpoints failed for ${opName}`,
      { errors },
    );

    throw new GuardianError(
      ErrorCode.API_ERROR,
      `All ${orderedEndpoints.length} HashKey Chain RPC endpoints failed for ` +
      `operation "${opName}". Errors: ${errors.map((e) => `[${e.url}] ${e.error}`).join(" | ")}`,
    );
  }

  /**
   * Returns health status of all endpoints for observability.
   */
  getHealthStatus(): EndpointHealth[] {
    return Array.from(this.health.values());
  }

  /**
   * Returns the chain definition being used.
   */
  getChain(): Chain {
    return this.chain;
  }

  /**
   * Returns endpoints sorted by health score (healthy first, then by
   * lowest latency). This ensures we always try the most reliable
   * endpoint first, reducing average latency.
   */
  private getHealthSortedEndpoints(): string[] {
    // Use a unique set of endpoints for sorting, then map back
    const uniqueUrls = [...new Set(this.endpoints)];

    const sorted = uniqueUrls.sort((a, b) => {
      const healthA = this.health.get(a)!;
      const healthB = this.health.get(b)!;

      // Healthy endpoints first
      if (healthA.isHealthy && !healthB.isHealthy) return -1;
      if (!healthA.isHealthy && healthB.isHealthy) return 1;

      // Among equally healthy, sort by failure rate
      const failRateA =
        healthA.totalRequests > 0
          ? healthA.totalFailures / healthA.totalRequests
          : 0;
      const failRateB =
        healthB.totalRequests > 0
          ? healthB.totalFailures / healthB.totalRequests
          : 0;

      if (failRateA !== failRateB) return failRateA - failRateB;

      // Tie-break by latency
      return healthA.avgLatencyMs - healthB.avgLatencyMs;
    });

    return sorted;
  }

  /**
   * Creates a timeout promise for a single endpoint.
   * Rejects after perEndpointTimeoutMs with a descriptive error.
   */
  private createEndpointTimeout(url: string): Promise<never> {
    return new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `RPC endpoint ${url} timed out after ${this.config.perEndpointTimeoutMs}ms`,
          ),
        );
      }, this.config.perEndpointTimeoutMs);
    });
  }
}

// ---------------------------------------------------------------------------
// ERC-20 ABI Fragment (for balance reads)
// ---------------------------------------------------------------------------

/**
 * Minimal ERC-20 ABI — just what we need for balance snapshots.
 * We read balanceOf before and after simulation to compute
 * actual token transfers.
 */
const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimulationCallParams {
  /** The sender address. */
  from: Address;
  /** The target contract address. */
  to: Address;
  /** The calldata (encoded function call). */
  data: HexString;
  /** Value in wei (hex-encoded or decimal string). */
  value?: string;
  /** Gas limit override — if omitted, we estimate first. */
  gas?: bigint;
}

export interface EthCallResult {
  /** Whether the call succeeded (did not revert). */
  success: boolean;
  /** Raw return data (hex) if successful. */
  returnData: HexString | null;
  /** Revert reason string if the call reverted. */
  revertReason: string | null;
  /** Estimated gas used. */
  gasUsed: bigint;
  /** The block number the simulation was pinned to. */
  blockNumber: bigint;
}

export interface TokenBalanceSnapshot {
  /** Token contract address. */
  tokenAddress: Address;
  /** Token symbol. */
  symbol: string;
  /** Token decimals. */
  decimals: number;
  /** Balance in raw units (bigint). */
  rawBalance: bigint;
  /** Balance in human-readable decimal string. */
  formatted: string;
}

// ---------------------------------------------------------------------------
// Client Class (with Round-Robin RPC Redundancy)
// ---------------------------------------------------------------------------

/**
 * HashKeyRPCClient — Primary RPC client for HashKey Chain.
 * Provides eth_call simulation, token balance reads, and contract interaction
 * via round-robin RPC failover.
 */
export class HashKeyRPCClient {
  private readonly rpcManager: RoundRobinRPCManager;

  constructor(
    chainId: 177 | 133 = 177,
    rpcUrlOverride?: string,
    additionalEndpoints?: string[],
  ) {
    const chain = chainId === 177 ? hashkeyMainnet : hashkeyTestnet;
    const defaultEndpoints =
      chainId === 177 ? DEFAULT_MAINNET_ENDPOINTS : DEFAULT_TESTNET_ENDPOINTS;

    // Build endpoint list: user overrides take priority, then env vars, then defaults.
    // CRITICAL: if the user has configured env vars, do NOT backfill with
    // hardcoded URLs. Doing so silently bypasses fail-closed behaviour
    // when the user intentionally (or accidentally) misconfigures RPCs.
    const endpoints: string[] = [];

    if (rpcUrlOverride) {
      endpoints.push(rpcUrlOverride);
    }

    // Read env-configured endpoints
    const envUrl1 = process.env["HASHKEY_RPC_URL"];
    const envUrl2 = process.env["HASHKEY_RPC_URL_2"];
    const envUrl3 = process.env["HASHKEY_RPC_URL_3"];

    if (envUrl1 && !endpoints.includes(envUrl1)) endpoints.push(envUrl1);
    if (envUrl2 && !endpoints.includes(envUrl2)) endpoints.push(envUrl2);
    if (envUrl3 && !endpoints.includes(envUrl3)) endpoints.push(envUrl3);

    // Add any programmatically-provided additional endpoints
    if (additionalEndpoints) {
      for (const ep of additionalEndpoints) {
        if (!endpoints.includes(ep)) endpoints.push(ep);
      }
    }

    // Only fall back to hardcoded defaults when NO endpoints were configured
    // at all (fresh install with no .env). Once the user sets any
    // HASHKEY_RPC_URL* env var, they own the endpoint list entirely.
    if (endpoints.length === 0) {
      for (const def of defaultEndpoints) {
        if (!endpoints.includes(def)) endpoints.push(def);
      }
    }

    this.rpcManager = new RoundRobinRPCManager(chain, endpoints);

    logger.debug("HashKeyRPCClient initialized with round-robin RPC", {
      chainId,
      endpointCount: endpoints.length,
      endpoints: endpoints.map((e) => e.replace(/\/\/.*@/, "//***@")),
    });
  }

  /**
   * Expose the RPC manager for direct access if needed (e.g., health checks).
   */
  getRPCManager(): RoundRobinRPCManager {
    return this.rpcManager;
  }

  /**
   * Returns the health status of all RPC endpoints.
   */
  getHealthStatus(): EndpointHealth[] {
    return this.rpcManager.getHealthStatus();
  }

  // -----------------------------------------------------------------------
  // Block Info
  // -----------------------------------------------------------------------

  /**
   * Gets the latest block number. Used to "pin" simulations to a
   * specific block for deterministic results.
   */
  async getLatestBlockNumber(): Promise<bigint> {
    return this.rpcManager.execute(
      (client) => client.getBlockNumber(),
      "getBlockNumber",
    );
  }

  // -----------------------------------------------------------------------
  // eth_call Simulation
  // -----------------------------------------------------------------------

  /**
   * Executes a transaction via eth_call against a pinned block.
   *
   * This is the core simulation primitive. eth_call:
   *   - Executes the transaction in a read-only context
   *   - Does NOT broadcast to the mempool
   *   - Does NOT cost gas (it's a local node computation)
   *   - Returns the raw return data or revert reason
   *
   * We pin to a specific block number to ensure the simulation
   * is deterministic — if the agent re-runs the check a second
   * later, it gets the same result (unless a new block arrived).
   *
   * PHASE 2: Now uses round-robin RPC failover. Each sub-call
   * (estimateGas, call) goes through the manager independently.
   * A single slow endpoint doesn't block the simulation.
   */
  async simulateCall(
    params: SimulationCallParams,
    blockNumber?: bigint,
  ): Promise<EthCallResult> {
    const pinnedBlock = blockNumber ?? (await this.getLatestBlockNumber());

    logger.debug("Executing eth_call simulation", {
      from: params.from,
      to: params.to,
      dataLength: params.data.length,
      value: params.value ?? "0",
      pinnedBlock: pinnedBlock.toString(),
    });

    // Step 1: Estimate gas first (this also catches reverts)
    let gasEstimate: bigint;
    let revertReason: string | null = null;

    try {
      gasEstimate = await this.rpcManager.execute(
        (client) =>
          client.estimateGas({
            account: params.from as `0x${string}`,
            to: params.to as `0x${string}`,
            data: params.data as `0x${string}`,
            value: params.value ? BigInt(params.value) : 0n,
            blockNumber: pinnedBlock,
          }),
        "estimateGas",
      );
    } catch (err) {
      // estimateGas reverts = the transaction WOULD revert on-chain.
      // This is EXACTLY what we want to catch.
      revertReason = this.extractRevertReason(err);

      logger.warn("Transaction simulation REVERTED during gas estimation", {
        from: params.from,
        to: params.to,
        revertReason,
      });

      return {
        success: false,
        returnData: null,
        revertReason,
        gasUsed: 0n,
        blockNumber: pinnedBlock,
      };
    }

    // Step 2: Execute the actual eth_call
    try {
      const returnData = await this.rpcManager.execute(
        (client) =>
          client.call({
            account: params.from as `0x${string}`,
            to: params.to as `0x${string}`,
            data: params.data as `0x${string}`,
            value: params.value ? BigInt(params.value) : 0n,
            gas: params.gas ?? gasEstimate * 2n, // 2x headroom
            blockNumber: pinnedBlock,
          }),
        "eth_call",
      );

      return {
        success: true,
        returnData: (returnData.data as HexString) ?? null,
        revertReason: null,
        gasUsed: gasEstimate,
        blockNumber: pinnedBlock,
      };
    } catch (err) {
      revertReason = this.extractRevertReason(err);

      return {
        success: false,
        returnData: null,
        revertReason,
        gasUsed: gasEstimate, // Gas was estimated but call still reverted
        blockNumber: pinnedBlock,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Token Balance Snapshots
  // -----------------------------------------------------------------------

  /**
   * Reads the ERC-20 balance of an address at a specific block.
   *
   * WHY THIS IS CRITICAL FOR SIMULATION:
   *   To compute exact slippage, we need to know the user's token
   *   balance BEFORE the swap and what it WOULD be AFTER. We read
   *   the "before" balance at the pinned block. The "after" balance
   *   comes from decoding the swap's return data or from the
   *   simulation endpoint's balance-change output.
   */
  async getTokenBalance(
    tokenAddress: Address,
    walletAddress: Address,
    blockNumber?: bigint,
  ): Promise<TokenBalanceSnapshot> {
    const pinnedBlock = blockNumber ?? (await this.getLatestBlockNumber());

    try {
      // Read balance, decimals, and symbol in parallel — each through round-robin
      const [rawBalance, decimals, symbol] = await Promise.all([
        this.rpcManager.execute(
          (client) =>
            client.readContract({
              address: tokenAddress as `0x${string}`,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [walletAddress as `0x${string}`],
              blockNumber: pinnedBlock,
            }) as Promise<bigint>,
          "balanceOf",
        ),

        this.rpcManager.execute(
          (client) =>
            client.readContract({
              address: tokenAddress as `0x${string}`,
              abi: ERC20_ABI,
              functionName: "decimals",
              blockNumber: pinnedBlock,
            }) as Promise<number>,
          "decimals",
        ),

        this.rpcManager.execute(
          (client) =>
            client.readContract({
              address: tokenAddress as `0x${string}`,
              abi: ERC20_ABI,
              functionName: "symbol",
              blockNumber: pinnedBlock,
            }) as Promise<string>,
          "symbol",
        ),
      ]);

      return {
        tokenAddress,
        symbol,
        decimals,
        rawBalance,
        formatted: formatUnits(rawBalance, decimals),
      };
    } catch (err) {
      throw new GuardianError(
        ErrorCode.ANALYZER_ERROR,
        `Failed to read token balance for ${tokenAddress} at block ${pinnedBlock}: ${err instanceof Error ? err.message : String(err)
        }`,
        { tokenAddress, walletAddress, blockNumber: pinnedBlock.toString() },
      );
    }
  }

  /**
   * Gets the native HSK balance of an address.
   */
  async getNativeBalance(
    walletAddress: Address,
    blockNumber?: bigint,
  ): Promise<{ rawBalance: bigint; formatted: string }> {
    const pinnedBlock = blockNumber ?? (await this.getLatestBlockNumber());

    try {
      const balance = await this.rpcManager.execute(
        (client) =>
          client.getBalance({
            address: walletAddress as `0x${string}`,
            blockNumber: pinnedBlock,
          }),
        "getBalance",
      );

      return {
        rawBalance: balance,
        formatted: formatEther(balance),
      };
    } catch (err) {
      throw new GuardianError(
        ErrorCode.ANALYZER_ERROR,
        `Failed to read native balance for ${walletAddress}: ${err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Gas Price
  // -----------------------------------------------------------------------

  /**
   * Gets the current gas price on HashKey Chain.
   * Used to calculate the cost of wasted gas when a tx reverts.
   */
  async getGasPrice(): Promise<bigint> {
    return this.rpcManager.execute(
      (client) => client.getGasPrice(),
      "getGasPrice",
    );
  }

  // -----------------------------------------------------------------------
  // Generic Contract Read (for AMM pool state reading)
  // -----------------------------------------------------------------------

  /**
   * Reads an arbitrary contract function via the round-robin manager.
   * Used by the AMM pool analyzer to read concentrated liquidity state.
   */
  async readContract<T>(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }): Promise<T> {
    return this.rpcManager.execute(
      (client) =>
        client.readContract({
          address: args.address as `0x${string}`,
          abi: args.abi as any,
          functionName: args.functionName,
          args: args.args as any,
          blockNumber: args.blockNumber,
        }) as Promise<T>,
      `readContract:${args.functionName}`,
    );
  }

  // -----------------------------------------------------------------------
  // Revert Reason Extraction
  // -----------------------------------------------------------------------

  private extractRevertReason(err: unknown): string {
    if (err instanceof Error) {
      const msg = err.message;
      // Try to extract a clean revert reason from viem's error messages
      const revertMatch = msg.match(/reverted with reason string '(.+?)'/);
      if (revertMatch?.[1]) return revertMatch[1];

      const customMatch = msg.match(
        /reverted with the following reason:\n(.+)/,
      );
      if (customMatch?.[1]) return customMatch[1].trim();

      const panicMatch = msg.match(/reverted with panic code (\w+)/);
      if (panicMatch?.[1]) return `Panic: ${panicMatch[1]}`;

      if (msg.includes("execution reverted")) return "execution reverted";

      return msg;
    }
    return String(err);
  }
}

