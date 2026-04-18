#!/usr/bin/env tsx
// ==========================================================================
// Guardian Protocol — On-Chain Proof Logger (HashKey Testnet 133)
// ==========================================================================
//
// Logs a Guardian evaluation verdict on-chain to the GuardianProofLogger
// contract deployed on HashKey Chain Testnet (chain ID 133).
//
// Uses viem for direct contract interaction. Requires PRIVATE_KEY env var
// for the deployer wallet (contract owner).
//
// Usage:
//   npx tsx scripts/log-proof.ts \
//     --contract 0x7384cbB4dC7dE54d49DdA4E44731003413D17D7F \
//     --evaluation-id <id> \
//     --score 36 \
//     --safe false \
//     --chain 133
//
// ==========================================================================

import "dotenv/config";
import { Command } from "commander";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  keccak256,
  stringToHex,
  defineChain,
  formatEther,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ---------------------------------------------------------------------------
// HashKey Chain Testnet Definition
// ---------------------------------------------------------------------------

const HSK_TESTNET = defineChain({
  id: 133,
  name: "HashKey Chain Testnet",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet.hsk.xyz"] } },
  blockExplorers: {
    default: {
      name: "HashKey Explorer",
      url: "https://testnet-explorer.hsk.xyz",
    },
  },
});

// ---------------------------------------------------------------------------
// GuardianProofLogger ABI (minimal — only functions we need)
// ---------------------------------------------------------------------------

const PROOF_LOGGER_ABI = parseAbi([
  "function logEvaluation(bytes32 evaluationId, bool verdict, uint256 score) external",
  "function getEvaluation(bytes32 evaluationId) view returns (bool verdict, uint256 score, uint256 timestamp, bool exists)",
  "function owner() view returns (address)",
]);

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

const program = new Command();
program
  .requiredOption("--contract <address>", "GuardianProofLogger contract address")
  .requiredOption("--evaluation-id <id>", "Evaluation UUID to log")
  .requiredOption("--score <score>", "Safety score (0-100)")
  .requiredOption("--safe <true|false>", "Whether the trade was deemed safe")
  .option("--chain <chainId>", "Chain ID", "133")
  .option("--rpc <url>", "RPC URL", "https://testnet.hsk.xyz");

program.parse();
const options = program.opts<{
  contract: string;
  evaluationId: string;
  score: string;
  safe: string;
  chain: string;
  rpc: string;
}>();

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const contractAddress = options.contract as Address;
  const rpcUrl = options.rpc;
  const chainId = Number(options.chain);
  const score = BigInt(options.score);
  const verdict = options.safe === "true";
  const evaluationIdRaw = options.evaluationId;
  const evaluationHash = keccak256(stringToHex(evaluationIdRaw));

  // --- Validate PRIVATE_KEY ---
  const rawKey = process.env["PRIVATE_KEY"];
  if (!rawKey) {
    console.error("❌ PRIVATE_KEY env var is not set. Cannot sign transactions.");
    process.exit(1);
  }
  const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
  const account = privateKeyToAccount(privateKey);

  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  🛡️  Guardian Protocol — On-Chain Proof Logger            ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`  Chain:          HashKey Testnet (${chainId})`);
  console.log(`  RPC:            ${rpcUrl}`);
  console.log(`  Contract:       ${contractAddress}`);
  console.log(`  Signer:         ${account.address}`);
  console.log(`  Evaluation ID:  ${evaluationIdRaw}`);
  console.log(`  Eval Hash:      ${evaluationHash}`);
  console.log(`  Score:          ${score}`);
  console.log(`  Verdict:        ${verdict ? "APPROVE" : "BLOCK"}`);
  console.log();

  // --- Build chain config (support custom chain IDs) ---
  const chain = chainId === 133 ? HSK_TESTNET : defineChain({
    id: chainId,
    name: `HashKey Chain ${chainId}`,
    nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });

  // --- Pre-flight: check balance ---
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`  Balance:        ${formatEther(balance)} HSK`);
  if (balance === 0n) {
    console.error("❌ Deployer wallet has zero balance. Need testnet HSK for gas.");
    process.exit(1);
  }

  // --- Pre-flight: verify contract owner ---
  const owner = await publicClient.readContract({
    address: contractAddress,
    abi: PROOF_LOGGER_ABI,
    functionName: "owner",
  });
  console.log(`  Contract Owner: ${owner}`);
  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    console.error(`❌ Signer ${account.address} is NOT the contract owner (${owner}). Transaction will revert.`);
    process.exit(1);
  }
  console.log("  ✅ Signer matches contract owner");
  console.log();

  // --- Send transaction ---
  console.log("  📝 Sending logEvaluation transaction...");
  const txHash = await walletClient.writeContract({
    address: contractAddress,
    abi: PROOF_LOGGER_ABI,
    functionName: "logEvaluation",
    args: [evaluationHash, verdict, score],
  });
  console.log(`  TX Hash:        ${txHash}`);

  // --- Wait for receipt ---
  console.log("  ⏳ Waiting for confirmation...");
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 60_000,
  });
  console.log(`  Block Number:   ${receipt.blockNumber}`);
  console.log(`  Gas Used:       ${receipt.gasUsed}`);
  console.log(`  Status:         ${receipt.status === "success" ? "✅ SUCCESS" : "❌ REVERTED"}`);
  console.log(`  Explorer:       https://testnet-explorer.hsk.xyz/tx/${txHash}`);
  console.log();

  if (receipt.status !== "success") {
    console.error("❌ Transaction reverted on-chain.");
    process.exit(1);
  }

  // --- Verify on-chain data ---
  console.log("  🔍 Verifying on-chain data...");
  const [loggedVerdict, loggedScore, loggedTimestamp, exists] = await publicClient.readContract({
    address: contractAddress,
    abi: PROOF_LOGGER_ABI,
    functionName: "getEvaluation",
    args: [evaluationHash],
  });

  console.log(`  On-Chain Verdict:   ${loggedVerdict ? "APPROVE" : "BLOCK"}`);
  console.log(`  On-Chain Score:     ${loggedScore}`);
  console.log(`  On-Chain Timestamp: ${loggedTimestamp} (${new Date(Number(loggedTimestamp) * 1000).toISOString()})`);
  console.log(`  Record Exists:      ${exists}`);
  console.log();

  if (!exists) {
    console.error("❌ Verification failed — record does not exist on-chain.");
    process.exit(1);
  }

  if (loggedScore !== score || loggedVerdict !== verdict) {
    console.error("❌ Verification failed — on-chain data does not match submitted values.");
    process.exit(1);
  }

  console.log("  ✅ On-chain verification PASSED — logged data matches submitted values.");
  console.log();
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  ✅ Proof logged and verified successfully!               ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
}

main().catch((err) => {
  console.error("❌ Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
