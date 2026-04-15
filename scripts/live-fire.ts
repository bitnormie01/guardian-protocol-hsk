#!/usr/bin/env tsx
// ==========================================================================
// Guardian Protocol — Live Fire Test Script (HashKey Chain Testnet)
// ==========================================================================

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Load .env from project root first, then parent directory
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
import { evaluateTrade, scanToken } from "../src/index.js";
import type { GuardianEvaluationRequest, TokenScanRequest } from "../src/types/input.js";
import { execSync } from "child_process";
import { createWalletClient, createPublicClient, http, parseAbi, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ---------------------------------------------------------------------------
// HashKey Chain Testnet Config
// ---------------------------------------------------------------------------

const CHAIN_ID = 133;
const RPC_URL = "https://testnet.hsk.xyz";
const PROOF_LOGGER_ADDRESS = process.env["GUARDIAN_PROOF_LOGGER_ADDRESS"] as `0x${string}` | undefined;
const RAW_KEY = process.env["PRIVATE_KEY"] ?? "";
const PRIVATE_KEY = (RAW_KEY.startsWith("0x") ? RAW_KEY : `0x${RAW_KEY}`) as `0x${string}` | undefined;

// Real ERC-20 tokens deployed on HashKey Chain testnet for live-fire testing.
// GTA (Guardian Test Alpha) and GTB (Guardian Test Beta) — deployed by us.
const TOKENS = {
  GTA: "0xbc20360E5A48AfA79Db22C47285A2CF813d47B36" as `0x${string}`,   // Guardian Test Alpha
  GTB: "0x0B33BF907AB5C8077423a02E0Fa5614BAf01cF83" as `0x${string}`,   // Guardian Test Beta
  UNKNOWN: "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF" as `0x${string}`,
};

const USER_ADDRESS = "0x2B6E71C59f571969Ae9C32373aa4Ce48054cbF27" as `0x${string}`;

// ABI for GuardianProofLogger
const PROOF_LOGGER_ABI = parseAbi([
  "function logEvaluation(bytes32 evaluationId, bool verdict, uint256 score) external",
  "function getEvaluation(bytes32 evaluationId) view returns (bool verdict, uint256 score, uint256 timestamp, bool exists)",
  "function owner() view returns (address)",
]);

// ---------------------------------------------------------------------------
// On-Chain Proof Logging
// ---------------------------------------------------------------------------

interface EvalResult {
  evaluationId: string;
  isSafeToExecute: boolean;
  overallScore: number;
}

// Shared chain definition + clients (created once to avoid nonce races)
const HSK_TESTNET_CHAIN = {
  id: CHAIN_ID,
  name: "HashKey Chain Testnet",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;

const sharedAccount = PRIVATE_KEY ? privateKeyToAccount(PRIVATE_KEY) : null;

const sharedWalletClient = (sharedAccount && PROOF_LOGGER_ADDRESS)
  ? createWalletClient({
      account: sharedAccount,
      chain: HSK_TESTNET_CHAIN,
      transport: http(RPC_URL),
    })
  : null;

const sharedPublicClient = createPublicClient({
  chain: HSK_TESTNET_CHAIN,
  transport: http(RPC_URL),
});

async function logEvaluationOnChain(result: EvalResult): Promise<string | null> {
  if (!PROOF_LOGGER_ADDRESS || !sharedWalletClient) {
    console.log("   ⚠️  No PROOF_LOGGER_ADDRESS or PRIVATE_KEY — skipping on-chain log.");
    return null;
  }

  try {
    const evalIdBytes32 = keccak256(toHex(result.evaluationId));

    const txHash = await sharedWalletClient.writeContract({
      address: PROOF_LOGGER_ADDRESS,
      abi: PROOF_LOGGER_ABI,
      functionName: "logEvaluation",
      args: [evalIdBytes32, result.isSafeToExecute, BigInt(result.overallScore)],
    });

    // Wait for TX to be mined before returning — prevents nonce collisions
    // on subsequent calls.
    await sharedPublicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 30_000,
    });

    console.log(`   📝 On-chain proof logged!`);
    console.log(`   TX Hash: ${txHash}`);
    console.log(`   Explorer: https://testnet-explorer.hsk.xyz/tx/${txHash}`);

    return txHash;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`   ⚠️  On-chain logging failed (non-fatal): ${msg.split("\n")[0]}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test Harness
// ---------------------------------------------------------------------------

function printBanner() {
  const banner = `
╔═══════════════════════════════════════════════════════════════════════╗
║                                                                       ║
║   🛡️  GUARDIAN PROTOCOL — LIVE FIRE TEST                              ║
║                                                                       ║
║   Target:  HashKey Chain Testnet (Chain ID 133)                       ║
║   Engine:  4-Analyzer Parallel Architecture                           ║
║   Mode:    Fail-Closed Security Middleware                            ║
║   Proof:   On-Chain GuardianProofLogger                               ║
║                                                                       ║
║   HashKey Chain Horizon Hackathon — AI Track                          ║
║                                                                       ║
╚═══════════════════════════════════════════════════════════════════════╝
`;
  console.log(banner);
}

function pingTrick() {
  try {
    execSync("ping -c 1 google.com", { stdio: "ignore" });
  } catch {
    // ignore
  }
}

let proofTxHashes: string[] = [];

async function runTest<T>(
  testName: string,
  fn: () => Promise<T>
): Promise<T | null> {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`🔥 TEST: ${testName}`);
  console.log(`${"═".repeat(70)}\n`);

  let lastError: Error | null = null;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const startTime = performance.now();
    try {
      if (attempt > 1) {
        console.log(`   [Attempt ${attempt}/${maxRetries}] Retrying...`);
        pingTrick();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      const result = await fn();
      const durationMs = Math.round(performance.now() - startTime);

      console.log(`\n✅ TEST COMPLETED (${durationMs}ms)`);
      console.log(`\n📦 Result:\n`);
      console.log(JSON.stringify(result, null, 2));

      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const message = lastError.message;

      console.log(`   ❌ Attempt ${attempt} failed: ${message.split("\n")[0]}`);

      // Config errors — don't retry
      if (
        message.includes("GOPLUS_API_KEY") ||
        message.includes("CONFIG_MISSING") ||
        message.includes("not set")
      ) {
        break;
      }
    }
  }

  if (lastError) {
    console.log(`\n❌ TEST FAILED after retries`);
    console.log(`   Error: ${lastError.message}`);
    if (
      lastError.message.includes("GOPLUS_API_KEY") ||
      lastError.message.includes("CONFIG_MISSING") ||
      lastError.message.includes("not set")
    ) {
      console.log(`\n⚠️  This failure is expected if .env credentials are not configured.`);
      console.log(`   The fail-closed behavior (blocking the trade) is the CORRECT response.`);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  printBanner();

  const timestamp = new Date().toISOString();
  console.log(`📅 Timestamp: ${timestamp}`);
  console.log(`🔗 Chain: HashKey Chain Testnet (${CHAIN_ID})`);
  console.log(`🏗️  Guardian Protocol v0.2.1`);
  console.log(`📝 Proof Logger: ${PROOF_LOGGER_ADDRESS ?? "NOT SET"}`);

  let totalTests = 0;
  let passedTests = 0;

  // ---- Test 1: Full Pipeline Evaluation ----
  totalTests++;
  const evalResult = await runTest(
    "Full Pipeline: GTA → GTB swap evaluation (testnet)",
    async () => {
      console.log("   Using testnet real deployed ERC-20 test tokens (GTA & GTB).");
      console.log("   GoPlus may have no data for custom testnet tokens → fail-closed expected.");
      console.log("   This is the CORRECT behavior.\n");

      const request: GuardianEvaluationRequest = {
        tokenIn: TOKENS.GTA,
        tokenOut: TOKENS.GTB,
        amountRaw: "1000000000000000000",
        amount: "1000000000000000000",
        userAddress: USER_ADDRESS,
        chainId: CHAIN_ID,
      };

      return evaluateTrade(request);
    }
  );

  if (evalResult) {
    passedTests++;
    const evalId = (evalResult as any).evaluationId ?? `eval-${Date.now()}-1`;
    const txHash = await logEvaluationOnChain({
      evaluationId: evalId,
      isSafeToExecute: (evalResult as any).isSafeToExecute ?? false,
      overallScore: (evalResult as any).overallScore ?? 0,
    });
    if (txHash) proofTxHashes.push(txHash);
  }

  console.log("Sleeping for 2 seconds to respect API rate limits...");
  await new Promise((r) => setTimeout(r, 2000));

  // ---- Test 2: Token Scan (Token A) ----
  totalTests++;
  const scanResult = await runTest(
    "Token Scan: GTA (Guardian Test Alpha) on HashKey Chain Testnet",
    async () => {
      console.log("   Scanning deployed testnet token (GTA) address.");
      console.log("   GoPlus may flag custom tokens → fail-closed expected.\n");

      const request: TokenScanRequest = {
        tokenAddress: TOKENS.GTA,
        chainId: CHAIN_ID,
      };

      return scanToken(request);
    }
  );

  if (scanResult) {
    passedTests++;
    const evalId = `scan-${Date.now()}-2`;
    const txHash = await logEvaluationOnChain({
      evaluationId: evalId,
      isSafeToExecute: (scanResult as any).isSafe ?? false,
      overallScore: (scanResult as any).score ?? 0,
    });
    if (txHash) proofTxHashes.push(txHash);
  }

  console.log("Sleeping for 2 seconds to respect API rate limits...");
  await new Promise((r) => setTimeout(r, 2000));

  // ---- Test 3: Fail-Closed (Unknown Token) ----
  totalTests++;
  const unknownResult = await runTest(
    "Fail-Closed: Scanning unknown/unindexed token (0xDeaD...)",
    async () => {
      console.log("   Scanning known-bad address.");
      console.log("   Expected: score 0, blocked, fail-closed enforcement.\n");

      const request: TokenScanRequest = {
        tokenAddress: TOKENS.UNKNOWN,
        chainId: CHAIN_ID,
      };

      return scanToken(request);
    }
  );

  if (unknownResult) {
    passedTests++;
    if (!(unknownResult as any).isSafe) {
      console.log("\n🛡️  FAIL-CLOSED VERIFIED: Unknown token correctly blocked.");
    }
    const evalId = `failclose-${Date.now()}-3`;
    const txHash = await logEvaluationOnChain({
      evaluationId: evalId,
      isSafeToExecute: (unknownResult as any).isSafe ?? false,
      overallScore: (unknownResult as any).score ?? 0,
    });
    if (txHash) proofTxHashes.push(txHash);
  }

  // ---- Summary ----
  console.log(`\n${"═".repeat(70)}`);
  console.log(`📊 LIVE FIRE SUMMARY`);
  console.log(`${"═".repeat(70)}`);
  console.log(`   Tests Attempted:      ${totalTests}`);
  console.log(`   Tests Completed:      ${passedTests}`);
  console.log(`   Pipeline Mode:        Fail-Closed`);
  console.log(`   Architecture:         4-Analyzer Parallel + Weighted Scoring`);
  console.log(`   Target Chain:         HashKey Chain Testnet (${CHAIN_ID})`);
  console.log(`   Proof Logger:         ${PROOF_LOGGER_ADDRESS ?? "NOT SET"}`);
  console.log(`   On-Chain Proofs:      ${proofTxHashes.length}`);

  if (proofTxHashes.length > 0) {
    console.log(`\n   📝 Proof Transaction Hashes:`);
    for (const hash of proofTxHashes) {
      console.log(`      • ${hash}`);
      console.log(`        https://testnet-explorer.hsk.xyz/tx/${hash}`);
    }
  }

  console.log(`${"═".repeat(70)}\n`);
}

main().catch((err) => {
  console.error("Fatal error in live-fire script:", err);
  process.exit(1);
});
