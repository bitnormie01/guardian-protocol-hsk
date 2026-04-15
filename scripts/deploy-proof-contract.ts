#!/usr/bin/env tsx
import { config as loadEnv } from "dotenv";
import { spawnSync } from "node:child_process";

loadEnv();
loadEnv({
  path: "/home/benevolencia/hackathon/hashkeyHackathon/.env",
  override: false,
});

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
  const rpcUrl =
    process.env["HASHKEY_TESTNET_RPC_URL"] ??
    process.env["HASHKEY_RPC_URL"] ??
    process.env["RPC_URL"] ??
    "https://testnet.hsk.xyz";
  const privateKey = requiredEnv([
    "DEPLOYER_KEY",
    "HASHKEY_PRIVATE_KEY",
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
      "--chain-id",
      "133",
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
