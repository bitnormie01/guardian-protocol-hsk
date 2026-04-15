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
      { name: "evaluationId", type: "bytes32" },
      { name: "verdict", type: "bool" },
      { name: "score", type: "uint256" },
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
  .requiredOption("--score <score>")
  .requiredOption("--safe <true|false>")
  .option("--chain <chainId>", "Chain ID", "133");

program.parse();
const options = program.opts<{
  contract: Address;
  evaluationId: string;
  score: string;
  safe: string;
  chain: string;
}>();

const evaluationHash = keccak256(stringToHex(options.evaluationId));
const inputData = encodeFunctionData({
  abi: GUARDIAN_PROOF_LOGGER_ABI,
  functionName: "logEvaluation",
  args: [
    evaluationHash,
    options.safe === "true",
    BigInt(options.score),
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
