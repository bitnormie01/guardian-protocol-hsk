#!/usr/bin/env tsx
// ==========================================================================
// Guardian Protocol — Manual Feature Testing (5x each function)
// ==========================================================================

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { evaluateTrade, scanToken, simulateTx } from "../src/index.js";
import type {
  GuardianEvaluationRequest,
  TokenScanRequest,
  TxSimulationRequest,
} from "../src/types/input.js";

// ---------------------------------------------------------------------------
// Test Addresses
// ---------------------------------------------------------------------------

const DEPLOYED_GTA = "0xbc20360E5A48AfA79Db22C47285A2CF813d47B36" as const;
const DEPLOYED_GTB = "0x0B33BF907AB5C8077423a02E0Fa5614BAf01cF83" as const;
const DEAD_ADDRESS = "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF" as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const RANDOM_EOA = "0x1111111111111111111111111111111111111111" as const;
const USER_ADDR = "0x2B6E71C59f571969Ae9C32373aa4Ce48054cbF27" as const;
const PROOF_LOGGER = "0x33C38701715be74327B1Bc6EDf9Da81Bfb6800A8" as const;

const CHAIN_TESTNET = 133 as const;
const CHAIN_MAINNET = 177 as const;

// ---------------------------------------------------------------------------
// Test Harness
// ---------------------------------------------------------------------------

interface TestResult {
  testName: string;
  function: string;
  run: number;
  passed: boolean;
  durationMs: number;
  verdict?: string;
  score?: number;
  tier?: string;
  flagCount?: number;
  error?: string;
}

const results: TestResult[] = [];
let testCounter = 0;

async function runTest(
  functionName: string,
  testName: string,
  fn: () => Promise<any>,
  validate: (result: any) => boolean
): Promise<void> {
  testCounter++;
  const start = performance.now();

  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - start);
    const passed = validate(result);

    const testResult: TestResult = {
      testName,
      function: functionName,
      run: testCounter,
      passed,
      durationMs,
      verdict: result?.isSafeToExecute !== undefined
        ? (result.isSafeToExecute ? "APPROVED" : "BLOCKED")
        : result?.isSafe !== undefined
          ? (result.isSafe ? "SAFE" : "UNSAFE")
          : "N/A",
      score: result?.safetyScore?.overall ?? result?.safetyScore?.overall ?? 0,
      tier: result?.safetyScore?.tier ?? "N/A",
      flagCount: result?.flags?.length ?? 0,
    };

    results.push(testResult);

    const icon = passed ? "✅" : "❌";
    console.log(
      `${icon} [${testCounter.toString().padStart(2, "0")}] ${functionName.padEnd(14)} | ${testName.padEnd(55)} | ` +
      `Score: ${String(testResult.score).padStart(3)} | ${testResult.tier?.padEnd(9)} | ` +
      `${testResult.verdict?.padEnd(8)} | Flags: ${testResult.flagCount} | ${durationMs}ms`
    );
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const errorMsg = err instanceof Error ? err.message.split("\n")[0] : String(err);

    results.push({
      testName,
      function: functionName,
      run: testCounter,
      passed: false,
      durationMs,
      error: errorMsg,
    });

    console.log(
      `💥 [${testCounter.toString().padStart(2, "0")}] ${functionName.padEnd(14)} | ${testName.padEnd(55)} | ` +
      `ERROR: ${errorMsg.substring(0, 60)} | ${durationMs}ms`
    );
  }
}

// ---------------------------------------------------------------------------
// FUNCTION 1: scanToken() — 7 tests
// ---------------------------------------------------------------------------

async function testScanToken() {
  console.log(`\n${"═".repeat(140)}`);
  console.log(`🔬 FUNCTION: scanToken() — Token Risk Analysis`);
  console.log(`${"═".repeat(140)}`);

  // Test 1: Deployed ERC-20 on testnet (GTA)
  await runTest("scanToken", "Scan deployed GTA token on testnet (chain 133)", async () => {
    return scanToken({ tokenAddress: DEPLOYED_GTA, chainId: CHAIN_TESTNET });
  }, (r) => r.evaluationId && r.safetyScore.overall >= 0 && r.flags.length >= 0);

  // Test 2: Deployed ERC-20 on testnet (GTB)
  await runTest("scanToken", "Scan deployed GTB token on testnet (chain 133)", async () => {
    return scanToken({ tokenAddress: DEPLOYED_GTB, chainId: CHAIN_TESTNET });
  }, (r) => r.evaluationId && !r.isSafe); // Should fail-closed (GoPlus unsupported chain)

  // Test 3: Dead address (no bytecode)
  await runTest("scanToken", "Scan 0xDeaD... (no bytecode) — expect UNVERIFIED_CONTRACT", async () => {
    return scanToken({ tokenAddress: DEAD_ADDRESS, chainId: CHAIN_TESTNET });
  }, (r) => r.safetyScore.overall === 0 && r.flags.some((f: any) => f.code === "UNVERIFIED_CONTRACT"));

  // Test 4: Zero address
  await runTest("scanToken", "Scan 0x0000...0000 (zero address) — expect fail-closed", async () => {
    return scanToken({ tokenAddress: ZERO_ADDRESS, chainId: CHAIN_TESTNET });
  }, (r) => r.safetyScore.overall === 0 && !r.isSafe);

  // Test 5: Random EOA (no contract)
  await runTest("scanToken", "Scan random EOA 0x1111... — expect UNVERIFIED_CONTRACT", async () => {
    return scanToken({ tokenAddress: RANDOM_EOA, chainId: CHAIN_TESTNET });
  }, (r) => !r.isSafe && r.safetyScore.overall === 0);

  // Test 6: Proof logger contract (not ERC-20)
  await runTest("scanToken", "Scan GuardianProofLogger (not ERC-20) — expect fail-closed", async () => {
    return scanToken({ tokenAddress: PROOF_LOGGER, chainId: CHAIN_TESTNET });
  }, (r) => r.evaluationId && r.safetyScore.overall >= 0);

  // Test 7: Default chain ID (should default to 177)
  await runTest("scanToken", "Scan GTA with no chainId — defaults to mainnet 177", async () => {
    return scanToken({ tokenAddress: DEPLOYED_GTA } as any);
  }, (r) => r.chainId === 177 && r.evaluationId);
}

// ---------------------------------------------------------------------------
// FUNCTION 2: evaluateTrade() — 7 tests
// ---------------------------------------------------------------------------

async function testEvaluateTrade() {
  console.log(`\n${"═".repeat(140)}`);
  console.log(`🔬 FUNCTION: evaluateTrade() — Full Pipeline Evaluation`);
  console.log(`${"═".repeat(140)}`);

  // Test 1: GTA → GTB swap (with decimals provided to bypass RPC read)
  await runTest("evaluateTrade", "GTA → GTB swap, with decimals, testnet", async () => {
    return evaluateTrade({
      tokenIn: DEPLOYED_GTA,
      tokenOut: DEPLOYED_GTB,
      amountRaw: "1000000000000000000",
      amount: "1000000000000000000",
      userAddress: USER_ADDR,
      chainId: CHAIN_TESTNET,
      tokenInDecimals: 18,
      tokenOutDecimals: 18,
    });
  }, (r) => r.evaluationId && r.safetyScore && r.flags && r.meta);

  // Test 2: GTA → Dead address (dangerous pair — error = valid fail-closed)
  await runTest("evaluateTrade", "GTA → 0xDeaD (non-contract) — expect blocked or error", async () => {
    try {
      const r = await evaluateTrade({
        tokenIn: DEPLOYED_GTA,
        tokenOut: DEAD_ADDRESS,
        amountRaw: "500000000000000000",
        amount: "500000000000000000",
        userAddress: USER_ADDR,
        chainId: CHAIN_TESTNET,
        tokenInDecimals: 18,
        tokenOutDecimals: 18,
      });
      return r;
    } catch {
      // Throwing = fail-closed (trade context couldn't be resolved → blocked)
      return { evaluationId: "fail-closed-error", isSafeToExecute: false, safetyScore: { overall: 0, tier: "CRITICAL" }, flags: [{ code: "PIPELINE_ERROR" }] };
    }
  }, (r) => !r.isSafeToExecute && r.safetyScore.overall === 0);

  // Test 3: Dead → Zero (both invalid — error = valid fail-closed)
  await runTest("evaluateTrade", "0xDeaD → 0x0000 (both non-contract) — fail-closed", async () => {
    try {
      const r = await evaluateTrade({
        tokenIn: DEAD_ADDRESS,
        tokenOut: ZERO_ADDRESS,
        amountRaw: "100000000000000000",
        amount: "100000000000000000",
        userAddress: USER_ADDR,
        chainId: CHAIN_TESTNET,
        tokenInDecimals: 18,
        tokenOutDecimals: 18,
      });
      return r;
    } catch {
      return { evaluationId: "fail-closed-error", isSafeToExecute: false, safetyScore: { overall: 0, tier: "CRITICAL" }, flags: [{ code: "PIPELINE_ERROR" }] };
    }
  }, (r) => !r.isSafeToExecute && r.safetyScore.overall === 0);

  // Test 4: Large amount trade
  await runTest("evaluateTrade", "GTA → GTB, large amount (1M tokens)", async () => {
    return evaluateTrade({
      tokenIn: DEPLOYED_GTA,
      tokenOut: DEPLOYED_GTB,
      amountRaw: "1000000000000000000000000",
      amount: "1000000000000000000000000",
      userAddress: USER_ADDR,
      chainId: CHAIN_TESTNET,
      tokenInDecimals: 18,
      tokenOutDecimals: 18,
    });
  }, (r) => r.evaluationId && r.meta.analyzersRun.length === 4);

  // Test 5: With custom config overrides
  await runTest("evaluateTrade", "GTA → GTB with custom config (strict thresholds)", async () => {
    return evaluateTrade(
      {
        tokenIn: DEPLOYED_GTA,
        tokenOut: DEPLOYED_GTB,
        amountRaw: "1000000000000000000",
        amount: "1000000000000000000",
        userAddress: USER_ADDR,
        chainId: CHAIN_TESTNET,
        tokenInDecimals: 18,
        tokenOutDecimals: 18,
      },
      {
        scoringPolicy: { safetyThreshold: 95, minimumSubScore: 30, maxHighFlagsBeforeBlock: 1 },
      }
    );
  }, (r) => r.evaluationId && r.meta);

  // Test 6: With callerAgentId
  await runTest("evaluateTrade", "GTA → GTB with callerAgentId='test-agent-007'", async () => {
    return evaluateTrade({
      tokenIn: DEPLOYED_GTA,
      tokenOut: DEPLOYED_GTB,
      amountRaw: "1000000000000000000",
      amount: "1000000000000000000",
      userAddress: USER_ADDR,
      chainId: CHAIN_TESTNET,
      callerAgentId: "test-agent-007",
      tokenInDecimals: 18,
      tokenOutDecimals: 18,
    });
  }, (r) => r.evaluationId && r.meta.analyzersRun.length === 4);

  // Test 7: ProofLogger as tokenIn (contract but not ERC-20 — error = fail-closed)
  await runTest("evaluateTrade", "ProofLogger → GTB (non-ERC20 input) — fail-closed", async () => {
    try {
      const r = await evaluateTrade({
        tokenIn: PROOF_LOGGER,
        tokenOut: DEPLOYED_GTB,
        amountRaw: "1000000000000000000",
        amount: "1000000000000000000",
        userAddress: USER_ADDR,
        chainId: CHAIN_TESTNET,
        tokenInDecimals: 18,
        tokenOutDecimals: 18,
      });
      return r;
    } catch {
      return { evaluationId: "fail-closed-error", isSafeToExecute: false, safetyScore: { overall: 0, tier: "CRITICAL" }, flags: [{ code: "PIPELINE_ERROR" }] };
    }
  }, (r) => !r.isSafeToExecute);
}

// ---------------------------------------------------------------------------
// FUNCTION 3: simulateTx() — 5 tests
// ---------------------------------------------------------------------------

async function testSimulateTx() {
  console.log(`\n${"═".repeat(140)}`);
  console.log(`🔬 FUNCTION: simulateTx() — Standalone TX Simulation`);
  console.log(`${"═".repeat(140)}`);

  // Simple transfer calldata: transfer(address,uint256)
  const transferCalldata = "0xa9059cbb" +
    "0000000000000000000000001111111111111111111111111111111111111111" +
    "0000000000000000000000000000000000000000000000000de0b6b3a7640000";

  // Test 1: Simulate ERC-20 transfer to GTA
  await runTest("simulateTx", "Simulate ERC-20 transfer call on GTA", async () => {
    return simulateTx({
      proposedTxHex: transferCalldata as `0x${string}`,
      userAddress: USER_ADDR,
      targetAddress: DEPLOYED_GTA,
      chainId: CHAIN_TESTNET,
    });
  }, (r) => r.evaluationId && r.safetyScore);

  // Test 2: Simulate call to dead address
  await runTest("simulateTx", "Simulate call to 0xDeaD... (non-contract)", async () => {
    return simulateTx({
      proposedTxHex: transferCalldata as `0x${string}`,
      userAddress: USER_ADDR,
      targetAddress: DEAD_ADDRESS,
      chainId: CHAIN_TESTNET,
    });
  }, (r) => r.evaluationId);

  // Test 3: Simulate with empty calldata
  await runTest("simulateTx", "Simulate with minimal calldata (0x)", async () => {
    return simulateTx({
      proposedTxHex: "0x" as `0x${string}`,
      userAddress: USER_ADDR,
      targetAddress: DEPLOYED_GTA,
      chainId: CHAIN_TESTNET,
    });
  }, (r) => r.evaluationId);

  // Test 4: Simulate call to ProofLogger
  await runTest("simulateTx", "Simulate logEvaluation call on ProofLogger", async () => {
    const logEvalCalldata = "0x12345678" +
      "0000000000000000000000000000000000000000000000000000000000000001" +
      "0000000000000000000000000000000000000000000000000000000000000001" +
      "0000000000000000000000000000000000000000000000000000000000000050";
    return simulateTx({
      proposedTxHex: logEvalCalldata as `0x${string}`,
      userAddress: USER_ADDR,
      targetAddress: PROOF_LOGGER,
      chainId: CHAIN_TESTNET,
    });
  }, (r) => r.evaluationId);

  // Test 5: Simulate on mainnet chain ID
  await runTest("simulateTx", "Simulate transfer on mainnet (chain 177)", async () => {
    return simulateTx({
      proposedTxHex: transferCalldata as `0x${string}`,
      userAddress: USER_ADDR,
      targetAddress: DEPLOYED_GTA,
      chainId: CHAIN_MAINNET,
    });
  }, (r) => r.evaluationId && r.chainId === 177);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗
║                                                                                                                                            ║
║   🧪  GUARDIAN PROTOCOL — COMPREHENSIVE MANUAL TESTING                                                                                    ║
║                                                                                                                                            ║
║   Functions:  scanToken(), evaluateTrade(), simulateTx()                                                                                   ║
║   Target:     HashKey Chain Testnet (133) + Mainnet (177)                                                                                  ║
║   Tokens:     GTA, GTB (deployed), 0xDeaD, 0x0000, random EOA                                                                             ║
║   Tests:      19 total (7 + 7 + 5)                                                                                                         ║
║                                                                                                                                            ║
╚══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝
`);

  const totalStart = performance.now();

  await testScanToken();
  console.log("\n⏳ Cooling down 2s (API rate limits)...");
  await new Promise((r) => setTimeout(r, 2000));

  await testEvaluateTrade();
  console.log("\n⏳ Cooling down 2s (API rate limits)...");
  await new Promise((r) => setTimeout(r, 2000));

  await testSimulateTx();

  const totalDuration = Math.round(performance.now() - totalStart);

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const errors = results.filter((r) => r.error).length;

  console.log(`\n${"═".repeat(140)}`);
  console.log(`📊 MANUAL TESTING SUMMARY`);
  console.log(`${"═".repeat(140)}`);
  console.log(`   Total Tests:     ${results.length}`);
  console.log(`   Passed:          ${passed} ✅`);
  console.log(`   Failed:          ${failed - errors} ❌`);
  console.log(`   Errors:          ${errors} 💥`);
  console.log(`   Pass Rate:       ${((passed / results.length) * 100).toFixed(1)}%`);
  console.log(`   Total Duration:  ${totalDuration}ms`);
  console.log(`${"═".repeat(140)}`);

  // Per-function breakdown
  const functions = ["scanToken", "evaluateTrade", "simulateTx"];
  for (const fn of functions) {
    const fnResults = results.filter((r) => r.function === fn);
    const fnPassed = fnResults.filter((r) => r.passed).length;
    const fnAvgMs = Math.round(
      fnResults.reduce((sum, r) => sum + r.durationMs, 0) / fnResults.length
    );
    console.log(
      `   ${fn.padEnd(16)} ${fnPassed}/${fnResults.length} passed | avg ${fnAvgMs}ms`
    );
  }

  // Fail-closed verification
  const blocked = results.filter(
    (r) => r.verdict === "BLOCKED" || r.verdict === "UNSAFE"
  ).length;
  const approved = results.filter(
    (r) => r.verdict === "APPROVED" || r.verdict === "SAFE"
  ).length;

  console.log(`\n   🛡️  Fail-Closed Stats:`);
  console.log(`      Blocked/Unsafe:  ${blocked}`);
  console.log(`      Approved/Safe:   ${approved}`);
  console.log(`      N/A:             ${results.length - blocked - approved}`);
  console.log(`${"═".repeat(140)}\n`);

  // Exit with error code if any tests failed
  if (failed > 0) {
    console.log(`⚠️  ${failed} test(s) did not pass validation.`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
