#!/usr/bin/env tsx
import "dotenv/config";
import { spawnSync } from "node:child_process";

function requiredEnv(keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }

  throw new Error(
    `Missing required environment variable. Tried: ${keys.join(", ")}`,
  );
}

function main(): void {
  const rpcUrl = requiredEnv(["XLAYER_RPC_URL", "RPC_URL", "OKX_RPC_URL"]);
  const privateKey = requiredEnv([
    "XLAYER_PRIVATE_KEY",
    "PRIVATE_KEY",
    "DEPLOYER_PRIVATE_KEY",
  ]);

  const result = spawnSync(
    "forge",
    [
      "create",
      "contracts/GuardianProofLogger.sol:GuardianProofLogger",
      "--rpc-url",
      rpcUrl,
      "--private-key",
      privateKey,
      "--broadcast",
    ],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `forge create failed with exit code ${result.status ?? "unknown"}`,
    );
  }
}

main();
