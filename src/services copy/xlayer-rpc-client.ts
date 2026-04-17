// ==========================================================================
// Guardian Protocol — BACKWARD COMPATIBILITY SHIM
// ==========================================================================
//
// This file re-exports everything from hashkey-rpc-client.ts so that
// existing imports throughout the codebase continue to work.
//
// The canonical module is now ./hashkey-rpc-client.ts.
// ==========================================================================

export {
  hashkeyMainnet,
  hashkeyTestnet,
  RoundRobinRPCManager,
  HashKeyRPCClient,
} from "./hashkey-rpc-client.js";

export type {
  EndpointHealth,
  RoundRobinConfig,
  SimulationCallParams,
  EthCallResult,
  TokenBalanceSnapshot,
} from "./hashkey-rpc-client.js";
