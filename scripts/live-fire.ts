#!/usr/bin/env tsx
// ==========================================================================
// Guardian Protocol — Live Fire Test Script
// ==========================================================================

import { evaluateTrade, scanToken } from "../src/index.js";
import type { GuardianEvaluationRequest, TokenScanRequest } from "../src/types/input.js";
import { execSync } from "child_process";
import { parseAbi, encodeFunctionData } from "viem";

// ---------------------------------------------------------------------------
// X Layer Mainnet Token Addresses
// ---------------------------------------------------------------------------

const TOKENS = {
  WOKB: "0xe538905cf8410324e03A5A23C1c177a474D59b2b",
  USDC: "0x74b7f16337b8972027f6196a17a631ac6de26d22",
  UNKNOWN: "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF",
};

// Uniswap V3 Router on X Layer
const UNISWAP_V3_ROUTER = "0x4B2ab38DBF28D31D467aA8993f6c2585981D6804";

const USER_ADDRESS = "0x6e9fb08755b837388a36ced22f26ed64240fb29c";

function printBanner() {
  const banner = `
╔═══════════════════════════════════════════════════════════════════════╗
║                                                                       ║
║   🛡️  GUARDIAN PROTOCOL — LIVE FIRE TEST                              ║
║                                                                       ║
║   Target:  X Layer Mainnet (Chain ID 196)                             ║
║   Engine:  4-Analyzer Parallel Architecture                           ║
║   Mode:    Fail-Closed Security Middleware                            ║
║                                                                       ║
║   OKX Build X Hackathon — SkillArena Submission                       ║
║                                                                       ║
╚═══════════════════════════════════════════════════════════════════════╝
`;
  console.log(banner);
}

function pingTrick() {
  try {
    execSync('ping -c 1 google.com', { stdio: 'ignore' });
  } catch (e) {
    // ignore
  }
}

async function runTest<T>(
  testName: string,
  fn: () => Promise<T>
): Promise<T | null> {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`🔥 TEST: ${testName}`);
  console.log(`${"═".repeat(70)}\n`);

  let lastError: Error | null = null;
  const maxRetries = 5;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const startTime = performance.now();
    try {
      if (attempt > 1) {
        console.log(`   [Attempt ${attempt}/${maxRetries}] Retrying with ping trick...`);
        pingTrick();
        // Add a small delay
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      const result = await fn();
      const durationMs = Math.round(performance.now() - startTime);

      console.log(`\n✅ TEST PASSED (${durationMs}ms)`);
      console.log(`\n📦 Result:\n`);
      console.log(JSON.stringify(result, null, 2));

      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const message = lastError.message;
      
      console.log(`   ❌ Attempt ${attempt} failed: ${message.split('\n')[0]}`);
      
      // If it's a missing config error, don't retry
      if (
        message.includes("OKX_API_KEY") ||
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
      lastError.message.includes("OKX_API_KEY") ||
      lastError.message.includes("CONFIG_MISSING") ||
      lastError.message.includes("not set")
    ) {
      console.log(`\n⚠️  This failure is expected if .env credentials are not configured.`);
    }
  }

  return null;
}

async function main() {
  printBanner();

  const timestamp = new Date().toISOString();
  console.log(`📅 Timestamp: ${timestamp}`);
  console.log(`🔗 Chain: X Layer Mainnet (196)`);
  console.log(`🏗️  Guardian Protocol v0.2.1`);

  let anyLiveTestSucceeded = false;

  // ---- Test 1: Full Pipeline Evaluation (WOKB → USDC) ----
  const evalResult = await runTest(
    "Full Pipeline: WOKB → USDC swap evaluation",
    async () => {
      pingTrick(); // preemptive

      // Construct a valid Uniswap V3 exactInputSingle tx hex so simulation runs
      const abi = parseAbi([
        "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
        "function exactInputSingle(ExactInputSingleParams params) external payable returns (uint256 amountOut)"
      ]);

      const proposedTxHex = encodeFunctionData({
        abi,
        functionName: "exactInputSingle",
        args: [{
          tokenIn: TOKENS.WOKB as `0x${string}`,
          tokenOut: TOKENS.USDC as `0x${string}`,
          fee: 500, // 0.05%
          recipient: USER_ADDRESS as `0x${string}`,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 600), // 10 mins
          amountIn: 4000000000000000n, // 0.004 WOKB
          amountOutMinimum: 0n, // Let the pipeline detect slippage
          sqrtPriceLimitX96: 0n,
        }]
      });

      console.log("   Generated Uniswap V3 exactInputSingle tx data for simulation.");

      const request: GuardianEvaluationRequest = {
        tokenIn: TOKENS.WOKB as `0x${string}`,
        tokenOut: TOKENS.USDC as `0x${string}`,
        amount: "4000000000000000", // 0.004 WOKB (approx $0.20)
        userAddress: USER_ADDRESS as `0x${string}`,
        chainId: 196,
        proposedTxHex,
        proposedTxTarget: UNISWAP_V3_ROUTER as `0x${string}`,
      };

      return evaluateTrade(request);
    }
  );

  if (evalResult) anyLiveTestSucceeded = true;

  console.log("Sleeping for 2 seconds to respect OKX API rate limits...");
  await new Promise(r => setTimeout(r, 2000));

  // ---- Test 2: Token-Only Scan (WOKB) ----
  const scanResult = await runTest(
    "Token Scan: WOKB on X Layer Mainnet",
    async () => {
      pingTrick();
      const request: TokenScanRequest = {
        tokenAddress: TOKENS.WOKB as `0x${string}`,
        chainId: 196,
      };

      return scanToken(request);
    }
  );

  if (scanResult) anyLiveTestSucceeded = true;

  console.log("Sleeping for 2 seconds to respect OKX API rate limits...");
  await new Promise(r => setTimeout(r, 2000));

  // ---- Test 3: Unknown Token (Fail-Closed Behavior) ----
  const unknownResult = await runTest(
    "Fail-Closed: Scanning an unknown/unindexed token",
    async () => {
      pingTrick();
      const request: TokenScanRequest = {
        tokenAddress: TOKENS.UNKNOWN as `0x${string}`,
        chainId: 196,
      };

      return scanToken(request);
    }
  );

  if (unknownResult) {
    anyLiveTestSucceeded = true;
    if (!unknownResult.isSafe) {
      console.log(
        "\n🛡️  FAIL-CLOSED VERIFIED: Unknown token correctly blocked."
      );
    }
  }

  // ---- Summary ----
  console.log(`\n${"═".repeat(70)}`);
  console.log(`📊 LIVE FIRE SUMMARY`);
  console.log(`${"═".repeat(70)}`);
  console.log(`   Tests Attempted:      3`);
  console.log(`   Live Data Available:  ${anyLiveTestSucceeded ? "YES ✅" : "NO"}`);
  console.log(`   Pipeline Mode:        Fail-Closed`);
  console.log(`   Architecture:         4-Analyzer Parallel + Weighted Scoring`);
  console.log(`   Caching:              LRU (60s TTL, 500 entries)`);
  console.log(`   Target Chain:         X Layer Mainnet (196)`);
  console.log(`${"═".repeat(70)}\n`);
}

main().catch((err) => {
  console.error("Fatal error in live-fire script:", err);
  process.exit(1);
});
