#!/usr/bin/env tsx
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import { encodeFunctionData, keccak256, stringToHex, type Address } from "viem";

const GUARDIAN_PROOF_LOGGER_ABI = [
  {
    type: "function",
    name: "logEvaluation",
    stateMutability: "nonpayable",
    inputs: [
      { name: "evaluationHash", type: "bytes32" },
      { name: "user", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountRaw", type: "uint256" },
      { name: "score", type: "uint256" },
      { name: "isSafeToExecute", type: "bool" },
      { name: "contextSource", type: "string" },
      { name: "metadataURI", type: "string" },
    ],
    outputs: [],
  },
] as const;

function pingGoogle(): void {
  try {
    execFileSync("ping", ["-c", "1", "google.com"], {
      stdio: "ignore",
    });
  } catch {
    // Best-effort workaround only.
  }
}

function runOnchainos(args: string[]): void {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      pingGoogle();
      execFileSync("onchainos", args, {
        stdio: "inherit",
        env: process.env,
      });
      return;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("onchainos wallet contract-call failed after 5 attempts");
}

const program = new Command();
program
  .requiredOption("--contract <address>")
  .requiredOption("--evaluation-id <id>")
  .requiredOption("--user <address>")
  .requiredOption("--token-in <address>")
  .requiredOption("--token-out <address>")
  .requiredOption("--amount-raw <amountRaw>")
  .requiredOption("--score <score>")
  .requiredOption("--safe <true|false>")
  .option("--context-source <contextSource>", "Context source", "okx-dex")
  .option("--metadata-uri <metadataURI>", "Metadata URI", "")
  .option("--chain <chainId>", "Chain ID", "196");

program.parse();
const options = program.opts<{
  contract: Address;
  evaluationId: string;
  user: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountRaw: string;
  score: string;
  safe: string;
  contextSource: string;
  metadataUri: string;
  chain: string;
}>();

const evaluationHash = keccak256(stringToHex(options.evaluationId));
const inputData = encodeFunctionData({
  abi: GUARDIAN_PROOF_LOGGER_ABI,
  functionName: "logEvaluation",
  args: [
    evaluationHash,
    options.user,
    options.tokenIn,
    options.tokenOut,
    BigInt(options.amountRaw),
    BigInt(options.score),
    options.safe === "true",
    options.contextSource,
    options.metadataUri,
  ],
});

runOnchainos([
  "wallet",
  "contract-call",
  "--to",
  options.contract,
  "--chain",
  options.chain,
  "--amt",
  "0",
  "--input-data",
  inputData,
  "--force",
]);
