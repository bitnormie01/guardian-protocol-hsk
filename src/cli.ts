#!/usr/bin/env node
import "dotenv/config";
// ==========================================================================
// Guardian Protocol — Agent CLI
// ==========================================================================
//
// The primary interface for other agents and human operators to invoke
// Guardian Protocol from the terminal. Designed for machine consumption:
// all output is parseable JSON on stdout.
//
// COMMANDS:
//   guardian evaluate <tokenIn> <tokenOut> <amount>
//     Full pipeline: Token Risk + TX Simulation + MEV Detection → SafetyScore
//
//   guardian scan-token <tokenAddress>
//     Lightweight token-only risk scan
//
//   guardian simulate-tx <txHex>
//     Standalone transaction simulation
//
// DESIGN PRINCIPLES:
//   • stdout = machine-readable JSON (ONLY)
//   • stderr = human-readable logs (via Guardian logger)
//   • Exit code 0 = evaluation succeeded (check isSafeToExecute in output)
//   • Exit code 1 = Guardian itself failed (infra error, not a risk verdict)
//
// ==========================================================================

import { Command } from "commander";
import { evaluateTrade, scanToken, simulateTx } from "./index.js";
import type {
  GuardianEvaluationRequest,
  TokenScanRequest,
  TxSimulationRequest,
  Address,
  HexString,
} from "./types/input.js";
import { logger } from "./utils/logger.js";

// ---------------------------------------------------------------------------
// Version & Program Setup
// ---------------------------------------------------------------------------

const program = new Command();

// ---------------------------------------------------------------------------
// Input Validation Helpers
// ---------------------------------------------------------------------------

/** Validates an EVM address (0x-prefixed, 42 chars). */
function validateAddress(addr: string, label: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error(
      `Invalid ${label}: "${addr}" is not a valid EVM address. ` +
      `Must be 0x-prefixed and 40 hex characters long.`,
    );
  }
}

/** Validates trade amount — must be a positive integer string. */
function validateAmount(amount: string): void {
  const num = BigInt(amount.split(".")[0]!);
  if (num <= 0n) {
    throw new Error(
      `Invalid amount: "${amount}". Trade amount must be a positive integer in token raw units. ` +
      `For example, 1 USDC (6 decimals) is "1000000".`,
    );
  }
}

/** Validates that tokenIn !== tokenOut. */
function validateDistinctTokens(tokenIn: string, tokenOut: string): void {
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    throw new Error(
      `Invalid token pair: tokenIn and tokenOut cannot be the same address (${tokenIn}). ` +
      `A swap requires two distinct tokens.`,
    );
  }
}

/** Validates chainId is a supported X Layer chain. */
function validateChainId(chainId: number): void {
  if (chainId !== 196 && chainId !== 195) {
    throw new Error(
      `Unsupported chainId: ${chainId}. Guardian Protocol supports X Layer Mainnet (196) ` +
      `and X Layer Testnet (195) only.`,
    );
  }
}

/** Validates hex data (0x-prefixed). */
function validateHex(hex: string, label: string): void {
  if (!/^0x[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(
      `Invalid ${label}: "${hex.slice(0, 20)}...". Must be a valid 0x-prefixed hex string.`,
    );
  }
}

/** Validates safety threshold (must be between 20 and 100 inclusive). */
function validateThreshold(threshold: number): void {
  if (threshold < 20 || threshold > 100) {
    throw new Error(
      `Invalid safety threshold: ${threshold}. ` +
      `Threshold must be between 20 and 100. ` +
      `Values below 20 would bypass Guardian's minimum security invariants. ` +
      `If you need a lower threshold, use GUARDIAN_SAFETY_THRESHOLD env var with appropriate justification.`,
    );
  }
}

program
  .name("guardian")
  .description(
    "Guardian Protocol — Fail-closed security middleware for autonomous agents on X Layer",
  )
  .version("0.2.1");

// ---------------------------------------------------------------------------
// Command: evaluate
// ---------------------------------------------------------------------------

program
  .command("evaluate")
  .description(
    "Run the full Guardian evaluation pipeline (token risk + tx simulation + MEV detection)",
  )
  .argument("<tokenIn>", "Address of the token being sold")
  .argument("<tokenOut>", "Address of the token being bought")
  .argument("<amount>", "Trade amount in raw token units")
  .option(
    "-u, --user <address>",
    "User wallet address",
    "0x0000000000000000000000000000000000000001",
  )
  .option("-c, --chain <chainId>", "Chain ID (196=mainnet, 195=testnet)", "196")
  .option("-t, --tx <hex>", "Proposed transaction hex for simulation")
  .option("--tx-to <address>", "Target contract address for --tx simulation")
  .option("--token-in-decimals <decimals>", "Decimal precision for tokenIn")
  .option("--token-out-decimals <decimals>", "Decimal precision for tokenOut")
  .option("--pool <address>", "Resolved concentrated liquidity pool address")
  .option("--threshold <score>", "Custom safety threshold (0-100)", "70")
  .action(
    async (
      tokenIn: string,
      tokenOut: string,
      amount: string,
      options: {
        user: string;
        chain: string;
        tx?: string;
        txTo?: string;
        tokenInDecimals?: string;
        tokenOutDecimals?: string;
        pool?: string;
        threshold: string;
      },
    ) => {
      try {
        // --- Input Validation ---
        const chainId = Number(options.chain);
        validateChainId(chainId);
        validateAddress(tokenIn, "tokenIn");
        validateAddress(tokenOut, "tokenOut");
        validateDistinctTokens(tokenIn, tokenOut);
        validateAddress(options.user, "user address");
        validateAmount(amount);
        const threshold = Number(options.threshold);
        validateThreshold(threshold);
        if (options.tx) validateHex(options.tx, "transaction hex");
        if (options.txTo) validateAddress(options.txTo, "transaction target");
        if (options.pool) validateAddress(options.pool, "pool address");

        const request: GuardianEvaluationRequest = {
          tokenIn: tokenIn as Address,
          tokenOut: tokenOut as Address,
          amountRaw: amount,
          amount,
          userAddress: options.user as Address,
          chainId: chainId as 196 | 195,
          proposedTxHex: options.tx ? (options.tx as HexString) : undefined,
          proposedTxTarget: options.txTo ? (options.txTo as Address) : undefined,
          tokenInDecimals: options.tokenInDecimals
            ? Number(options.tokenInDecimals)
            : undefined,
          tokenOutDecimals: options.tokenOutDecimals
            ? Number(options.tokenOutDecimals)
            : undefined,
          poolAddress: options.pool ? (options.pool as Address) : undefined,
        };

        const response = await evaluateTrade(request, {
          scoringPolicy: {
            safetyThreshold: threshold,
            minimumSubScore: 20,
            maxHighFlagsBeforeBlock: 3,
          },
        });

        // Machine-readable JSON to stdout
        process.stdout.write(JSON.stringify(response, null, 2) + "\n");
        process.exit(0);
      } catch (err) {
        const errorOutput = {
          error: true,
          message: err instanceof Error ? err.message : String(err),
          command: "evaluate",
          timestamp: new Date().toISOString(),
        };
        process.stdout.write(JSON.stringify(errorOutput, null, 2) + "\n");
        process.exit(1);
      }
    },
  );

// ---------------------------------------------------------------------------
// Command: scan-token
// ---------------------------------------------------------------------------

program
  .command("scan-token")
  .description("Scan a single token for security risks (honeypot, tax, etc.)")
  .argument("<tokenAddress>", "Token contract address to scan")
  .option("-c, --chain <chainId>", "Chain ID (196=mainnet, 195=testnet)", "196")
  .action(async (tokenAddress: string, options: { chain: string }) => {
    try {
      // --- Input Validation ---
      const chainId = Number(options.chain);
      validateChainId(chainId);
      validateAddress(tokenAddress, "tokenAddress");

      const request: TokenScanRequest = {
        tokenAddress: tokenAddress as Address,
        chainId: chainId as 196 | 195,
      };

      const response = await scanToken(request);

      process.stdout.write(JSON.stringify(response, null, 2) + "\n");
      process.exit(0);
    } catch (err) {
      const errorOutput = {
        error: true,
        message: err instanceof Error ? err.message : String(err),
        command: "scan-token",
        timestamp: new Date().toISOString(),
      };
      process.stdout.write(JSON.stringify(errorOutput, null, 2) + "\n");
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Command: simulate-tx
// ---------------------------------------------------------------------------

program
  .command("simulate-tx")
  .description("Simulate a transaction to check for reverts and slippage")
  .argument("<txHex>", "Raw transaction hex data to simulate")
  .option(
    "-u, --user <address>",
    "User wallet address",
    "0x0000000000000000000000000000000000000001",
  )
  .option("--to <address>", "Target contract address")
  .option("-c, --chain <chainId>", "Chain ID (196=mainnet, 195=testnet)", "196")
  .action(async (txHex: string, options: { user: string; to?: string; chain: string }) => {
    try {
      // --- Input Validation ---
      const chainId = Number(options.chain);
      validateChainId(chainId);
      validateAddress(options.user, "user address");
      validateHex(txHex, "transaction hex");
      if (options.to) validateAddress(options.to, "target address");

      const request: TxSimulationRequest = {
        proposedTxHex: txHex as HexString,
        userAddress: options.user as Address,
        targetAddress: options.to as Address | undefined,
        chainId: chainId as 196 | 195,
      };

      const response = await simulateTx(request);

      process.stdout.write(JSON.stringify(response, null, 2) + "\n");
      process.exit(0);
    } catch (err) {
      const errorOutput = {
        error: true,
        message: err instanceof Error ? err.message : String(err),
        command: "simulate-tx",
        timestamp: new Date().toISOString(),
      };
      process.stdout.write(JSON.stringify(errorOutput, null, 2) + "\n");
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Parse & Execute
// ---------------------------------------------------------------------------

program.parse();
