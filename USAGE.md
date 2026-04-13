# 📖 Guardian Protocol — Integration & Usage Guide

<div align="center">

*The complete guide to deploying fail-closed security in your autonomous agent.*

</div>

---

## Table of Contents

1. [What Guardian Protects You From](#1-what-guardian-protects-you-from)
2. [Quick Orientation: How It Works](#2-quick-orientation-how-it-works)
3. [Prerequisites & Installation](#3-prerequisites--installation)
4. [Configuration](#4-configuration)
5. [CLI Usage](#5-cli-usage)
   - [evaluate — Full Pipeline](#51-evaluate--full-4-analyzer-pipeline)
   - [scan-token — Token Safety Screen](#52-scan-token--token-safety-screen)
   - [simulate-tx — TX Pre-flight](#53-simulate-tx--transaction-pre-flight)
6. [Library API (TypeScript / JavaScript)](#6-library-api-typescript--javascript)
   - [evaluateTrade()](#61-evaluatetrade--the-main-event)
   - [scanToken()](#62-scantoken--lightweight-pre-screen)
   - [simulateTx()](#63-simulatetx--standalone-simulation)
7. [Understanding the Response](#7-understanding-the-response)
   - [The Verdict Field](#the-verdict-field-issafetoexecute)
   - [Safety Score & Tiers](#safety-score--tiers)
   - [Risk Flags Anatomy](#risk-flags-anatomy)
   - [Complete Flag Catalog](#complete-flag-catalog)
   - [Score Breakdown & Weights](#score-breakdown--weights)
8. [Real-World Integration Patterns](#8-real-world-integration-patterns)
   - [Pattern 1: Trading Bot Guard](#pattern-1-trading-bot-guard)
   - [Pattern 2: Token Pre-screener](#pattern-2-token-pre-screener)
   - [Pattern 3: Arbitrage Safety Gate](#pattern-3-arbitrage-safety-gate)
   - [Pattern 4: Portfolio Risk Monitor](#pattern-4-portfolio-risk-monitor)
9. [Agent Workflow Diagrams](#9-agent-workflow-diagrams)
10. [Advanced Configuration](#10-advanced-configuration)
11. [Troubleshooting & FAQ](#11-troubleshooting--faq)

---

## 1. What Guardian Protects You From

Every threat category below represents **real money lost by real agents and traders** on EVM chains. Guardian Protocol detects all of them before you execute.

### 🍯 Honeypot Contracts
The most dangerous DeFi trap. The contract allows you to buy the token, but the sell function is disabled, gated behind a whitelist, or designed to always revert. Your funds are permanently trapped.

**How Guardian catches it:** OKX Security API classifies the contract using bytecode pattern matching and historical transaction analysis. GoPlus Security provides an independent second opinion. If either oracle flags it as a honeypot, the verdict is `CRITICAL` → blocked.

### 💸 Predatory Tax Tokens
"Tax tokens" extract a percentage of every buy and sell. A 25% sell tax means you lose a quarter of your position every time you exit. Legitimate projects cap taxes at 5%. Extraction schemes run 25–90%.

**How Guardian catches it:** Token Risk Analyzer reads buy and sell tax percentages from the OKX API and flags anything above configurable thresholds (default: 10% warning, 30% critical).

### 🔒 Wallet Blacklisting
The contract owner can call a function to permanently freeze any wallet address, blocking all transfers out. Increasingly common in "rug in slow motion" schemes where the deployer waits until liquidity accumulates before freezing early buyers.

**How Guardian catches it:** Detects the presence of `blacklist`, `blocklist`, `blockAddress`, and equivalent functions in the contract ABI.

### 🪙 Unlimited Minting
The deployer retains a `mint()` function. After your purchase drives up the price, they mint billions of new tokens and dump them — diluting your position to near-zero. This is the DeFi equivalent of a central bank printing money.

**How Guardian catches it:** `MINT_FUNCTION_PRESENT` flag is raised whenever the contract ABI includes a mint function not controlled by a fixed supply cap.

### 🥪 Sandwich Attacks (MEV)
A bot sees your pending transaction in the mempool, buys the same token before you (driving the price up), lets your transaction execute at the now-inflated price, then immediately sells (driving the price back down). Net effect: you paid more, the bot profited.

**How Guardian catches it:** MEV Detection Analyzer models whether your trade size and the current pool depth create a profitable sandwich window. It also estimates private MEV flow from builder toxicity data — because sophisticated sandwichers no longer use the public mempool.

### 🏔️ Liquidity Cliff Manipulation (Tick Gap Attacks)
Specific to concentrated liquidity pools (Uniswap V3 / forks). A sophisticated attacker removes their liquidity from the ticks adjacent to the current price, creating a "cliff." Your trade executes, crosses the tick boundary, and the price drops dramatically with no liquidity to absorb it. The attacker re-adds liquidity after the dump.

**How Guardian catches it:** AMM Pool Analyzer reads the raw `ticks()` mapping on-chain and detects artificial gaps between initialized ticks near the current price.

### 📉 Pool Price Manipulation
The pool's reported `sqrtPriceX96` doesn't match the theoretical price implied by the current tick. This means someone — likely via a flash loan — has manipulated the pool oracle without restoring equilibrium. A trade at this price is a trade at a wrong price.

**How Guardian catches it:** Guardian computes the theoretical price from the current tick and compares it against the stored `sqrtPriceX96`. Deviations above 5% (configurable) trigger `AMM_PRICE_DEVIATION`.

### 📡 Unverified Contracts
No source code verified on the block explorer. You cannot audit what you cannot read. Unverified contracts are a non-starter for any serious trading infrastructure.

**How Guardian catches it:** OKX Security API reports verification status. Unverified → `HIGH` severity flag → score reduction.

---

## 2. Quick Orientation: How It Works

When you call `evaluateTrade()`, Guardian does this in **parallel**:

```
Your call ──▶ Guardian Orchestrator
                    │
       ┌────────────┼────────────┬────────────┐
       ▼            ▼            ▼            ▼
  Token Risk    TX Sim +     MEV Detect   AMM Pool
  (OKX + GPS)  Fuzzing      (Private     (On-chain
                (8-variant)  Flow)        Tick Reads)
       │            │            │            │
       └────────────┴────────────┴────────────┘
                         │
                    Risk Engine
               (Weighted Aggregation +
                Penalty Cascades +
                sub-score floor check)
                         │
                  { isSafeToExecute,
                    safetyScore,
                    flags,
                    meta }
```

Total time: **< 2 seconds** because all four analyzers run concurrently.

The result is not a suggestion. `isSafeToExecute: false` means the trade must not proceed. No "proceed at risk" mode exists.

---

## 3. Prerequisites & Installation

**Requirements:**
- Node.js ≥ 20.0.0
- OKX API credentials from [OKX Developer Portal](https://www.okx.com/web3/build/dev-portal) — requires: API Key, Secret Key, Passphrase, Project ID

**Install:**

```bash
git clone https://github.com/anujkumar2o/guardian-protocol.git
cd guardian-protocol
npm install
```

**Verify:**

```bash
npm test
# Expected: 72/72 tests passing ✅
```

**Live fire against X Layer Testnet:**

```bash
npm run live-fire
# Runs 3 end-to-end tests against X Layer Chain ID 195
# Outputs structured results to stdout + saves to LIVE_FIRE_LOG.txt
```

---

## 4. Configuration

### 4.1 Environment Variables

```bash
cp .env.example .env
```

Edit `.env`:

```env
# ─── REQUIRED: OKX API Credentials ────────────────────────────────────
# Obtain from: https://www.okx.com/web3/build/dev-portal
# All four are required. Missing any one → fail-closed on token scans.
OKX_API_KEY=your_okx_api_key
OKX_SECRET_KEY=your_okx_secret_key
OKX_PASSPHRASE=your_okx_passphrase
OKX_PROJECT_ID=your_okx_project_id

# ─── RECOMMENDED: RPC Endpoint Redundancy ──────────────────────────────
# Guardian rotates through these with 500ms timeout each.
# If endpoint 1 is slow → instantly tries endpoint 2 → then 3.
# If ALL THREE fail → trade blocked (fail-closed).
XLAYER_RPC_URL=https://rpc.xlayer.tech
XLAYER_RPC_URL_2=https://xlayerrpc.okx.com
XLAYER_RPC_URL_3=https://rpc.xlayer.tech

# ─── OPTIONAL: Thresholds & Tuning ─────────────────────────────────────
GUARDIAN_SAFETY_THRESHOLD=70           # Score below this → trade blocked (0–100)
GUARDIAN_MAX_SLIPPAGE_BPS=500          # Max acceptable slippage in basis points (500 = 5%)
GUARDIAN_TX_SIMULATION_TIMEOUT_MS=10000  # Simulation + fuzzing timeout in ms
GUARDIAN_RPC_ENDPOINT_TIMEOUT_MS=500   # Per-endpoint failover timeout in ms
```

### 4.2 Environment Variable Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OKX_API_KEY` | ✅ | — | OKX OnchainOS API key |
| `OKX_SECRET_KEY` | ✅ | — | HMAC-SHA256 signing secret |
| `OKX_PASSPHRASE` | ✅ | — | OKX account passphrase |
| `OKX_PROJECT_ID` | ✅ | — | OKX project identifier |
| `XLAYER_RPC_URL` | ➖ | `https://rpc.xlayer.tech` | Primary RPC endpoint |
| `XLAYER_RPC_URL_2` | ➖ | — | Secondary RPC for failover |
| `XLAYER_RPC_URL_3` | ➖ | — | Tertiary RPC for failover |
| `GUARDIAN_SAFETY_THRESHOLD` | ➖ | `70` | Minimum score to allow execution |
| `GUARDIAN_MAX_SLIPPAGE_BPS` | ➖ | `500` | Max acceptable slippage |
| `GUARDIAN_TX_SIMULATION_TIMEOUT_MS` | ➖ | `10000` | Simulation timeout |
| `GUARDIAN_RPC_ENDPOINT_TIMEOUT_MS` | ➖ | `500` | Per-endpoint failover budget |

---

## 5. CLI Usage

All Guardian CLI commands output **pure JSON to stdout**. Structured logs go to stderr. This separation is deliberate — agents can safely pipe stdout without filtering noise.

```bash
# Pipe into jq for pretty-printing
npx tsx src/cli.ts evaluate ... | jq .

# Pipe into a script
npx tsx src/cli.ts evaluate ... | node ./my-trading-bot.js

# Check just the verdict
npx tsx src/cli.ts evaluate ... | jq '.isSafeToExecute'
```

### 5.1 `evaluate` — Full 4-Analyzer Pipeline

**The primary command.** Runs all four analyzers and returns the full safety assessment.

```bash
npx tsx src/cli.ts evaluate <tokenIn> <tokenOut> <amount> [options]
```

| Argument | Type | Description | Example |
|----------|------|-------------|---------|
| `tokenIn` | address | Token you are **selling** | `0xe538905cf8410324e03A5A23C1c177a474D59b2b` |
| `tokenOut` | address | Token you are **buying** | `0x1E4a5963aBFD975d8c9021ce480b42188849D41d` |
| `amount` | uint256 string | Amount of tokenIn in wei/smallest unit | `1000000000000000000` (= 1 token, 18 decimals) |

| Option | Default | Description |
|--------|---------|-------------|
| `-u, --user <addr>` | `0x000...001` | Your wallet address |
| `-c, --chain <id>` | `196` | Chain ID: `196` = mainnet, `195` = testnet |
| `-t, --tx <hex>` | _(none)_ | Pre-built transaction hex for simulation |
| `--threshold <score>` | `70` | Override safety threshold (0–100) |

**Example — Is swapping 1 WOKB for USDC on X Layer Mainnet safe?**

```bash
npx tsx src/cli.ts evaluate \
  0xe538905cf8410324e03A5A23C1c177a474D59b2b \
  0x1E4a5963aBFD975d8c9021ce480b42188849D41d \
  1000000000000000000 \
  --chain 196 \
  --user 0xYourWalletAddress
```

**Response — Trade Approved:**

```json
{
  "evaluationId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "timestamp": "2026-04-09T13:15:00.000Z",
  "chainId": 196,
  "safetyScore": {
    "overall": 91,
    "tier": "SAFE",
    "breakdown": {
      "tokenRisk": 95,
      "txSimulation": 88,
      "mevRisk": 82,
      "ammPoolRisk": 96
    }
  },
  "isSafeToExecute": true,
  "flags": [],
  "optimizedRouting": null,
  "meta": {
    "guardianVersion": "0.2.1",
    "evaluationDurationMs": 1247,
    "analyzersRun": [
      { "name": "token-risk-analyzer", "status": "success", "durationMs": 412 },
      { "name": "tx-simulation-analyzer", "status": "success", "durationMs": 380 },
      { "name": "mev-detection-analyzer", "status": "success", "durationMs": 22 },
      { "name": "amm-pool-analyzer", "status": "success", "durationMs": 1247 }
    ]
  }
}
```

**Response — Trade Blocked (Honeypot Detected):**

```json
{
  "evaluationId": "9b2c4e18-...",
  "safetyScore": {
    "overall": 8,
    "tier": "CRITICAL",
    "breakdown": {
      "tokenRisk": 0,
      "txSimulation": 75,
      "mevRisk": 60,
      "ammPoolRisk": 55
    }
  },
  "isSafeToExecute": false,
  "flags": [
    {
      "code": "HONEYPOT_DETECTED",
      "severity": "critical",
      "message": "Token 0x... has been classified as a honeypot by OKX Security API and confirmed by GoPlus Security. The sell function is disabled post-purchase. You will NOT be able to sell this token after buying. Funds will be permanently trapped.",
      "source": "token-risk-analyzer"
    }
  ],
  "meta": { "evaluationDurationMs": 843 }
}
```

> **Read `isSafeToExecute` first, always.** If it's `false`, the trade must not proceed. Then read `flags` to understand the reason and whether it's recoverable.

---

### 5.2 `scan-token` — Token Safety Screen

Lightweight command. Runs only the Token Risk Analyzer against a single token address. No simulation, no MEV analysis, no pool reads. Useful for pre-screening a token before you've even built a swap transaction.

```bash
npx tsx src/cli.ts scan-token <tokenAddress> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-c, --chain <id>` | `196` | Chain ID |

**Example:**

```bash
npx tsx src/cli.ts scan-token 0xSomeSuspiciousToken --chain 196
```

**Response — Dangerous Token:**

```json
{
  "evaluationId": "...",
  "tokenAddress": "0xSomeSuspiciousToken",
  "safetyScore": {
    "overall": 22,
    "tier": "CRITICAL",
    "tokenRisk": 22
  },
  "flags": [
    {
      "code": "HIGH_TAX_TOKEN",
      "severity": "high",
      "message": "Sell tax is 45%. You lose 45% of your position value on every sell transaction. This is extraction, not a fee."
    },
    {
      "code": "MINT_FUNCTION_PRESENT",
      "severity": "high",
      "message": "The contract deployer retains a mint() function. They can print unlimited tokens at any time, diluting your holdings to near-zero."
    },
    {
      "code": "LOW_HOLDER_COUNT",
      "severity": "medium",
      "message": "Only 8 unique addresses hold this token. Extreme concentration — single entity exit can crash the price."
    }
  ],
  "isSafe": false
}
```

---

### 5.3 `simulate-tx` — Transaction Pre-flight

Takes a raw transaction hex and runs it through Guardian's simulation + fuzzing engine. Useful when you have a pre-built transaction (from a DEX router API, for example) and want to confirm it won't revert or contain hidden traps before broadcasting.

```bash
npx tsx src/cli.ts simulate-tx <txHex> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-u, --user <addr>` | `0x000...001` | Sender address |
| `-c, --chain <id>` | `196` | Chain ID |

**Example:**

```bash
npx tsx src/cli.ts simulate-tx \
  0x095ea7b30000000000000000000000006b3... \
  --user 0xYourWallet \
  --chain 196
```

**Response — Simulation Passed:**

```json
{
  "evaluationId": "...",
  "simulationSuccess": true,
  "gasUsed": "147500",
  "stateChanges": [
    { "address": "0xYourWallet", "tokenAddress": "0xUSDC", "delta": "-100000000" },
    { "address": "0xYourWallet", "tokenAddress": "0xWOKB", "delta": "+987000000000000000" }
  ],
  "flags": []
}
```

**Response — Hidden Revert Trap Found:**

```json
{
  "simulationSuccess": false,
  "flags": [
    {
      "code": "FUZZING_INVARIANT_VIOLATION",
      "severity": "high",
      "message": "8-variant invariant fuzzer detected a state-dependent revert. Mutation variant 'DOUBLE_AMOUNT' triggered a revert not present in the base call. The contract likely has a trade-size-dependent trap. This trade is not safe to execute."
    }
  ]
}
```

---

## 6. Library API (TypeScript / JavaScript)

Import Guardian directly into your trading bot, agent, or DeFi application.

```typescript
import { evaluateTrade, scanToken, simulateTx } from "@guardian-protocol/skill";
import type { GuardianConfig } from "@guardian-protocol/skill";
```

All three functions are async and return typed responses. Full TypeScript support with strict mode types.

---

### 6.1 `evaluateTrade()` — The Main Event

Runs the full four-analyzer pipeline. Use this before every swap execution.

**Signature:**
```typescript
async function evaluateTrade(
  request: GuardianEvaluationRequest,
  config?: Partial<GuardianConfig>
): Promise<GuardianEvaluationResponse>
```

**Request shape:**
```typescript
interface GuardianEvaluationRequest {
  tokenIn:        string;  // Address of the token being sold
  tokenOut:       string;  // Address of the token being bought
  amount:         string;  // Amount of tokenIn in wei (uint256 as string)
  userAddress:    string;  // Caller's wallet address
  chainId?:       196 | 195;  // X Layer mainnet (196) or testnet (195), default: 196
  proposedTxHex?: string;  // Optional: pre-built tx hex for simulation
  callerAgentId?: string;  // Optional: agent identifier for audit logs
}
```

**Usage:**

```typescript
import { evaluateTrade } from "@guardian-protocol/skill";

async function executeGuardedSwap(
  tokenIn: string,
  tokenOut: string,
  amountWei: string,
  walletAddress: string
): Promise<{ success: boolean; reason?: string }> {

  // ── Step 1: Guardian evaluation ──────────────────────────────────────
  const verdict = await evaluateTrade({
    tokenIn,
    tokenOut,
    amount:      amountWei,
    userAddress: walletAddress,
    chainId:     196,  // X Layer Mainnet
  });

  // ── Step 2: Hard gate. No bypass. No "proceed anyway". ───────────────
  if (!verdict.isSafeToExecute) {
    const primaryFlag = verdict.flags[0];
    console.error(`⛔ BLOCKED [${verdict.safetyScore.tier}] — ${primaryFlag?.code}`);
    console.error(`   ${primaryFlag?.message}`);

    // Return without executing
    return {
      success: false,
      reason: primaryFlag?.code ?? "GUARDIAN_BLOCKED",
    };
  }

  // ── Step 3: Execute only after Guardian clearance ────────────────────
  console.log(`✅ APPROVED — Score: ${verdict.safetyScore.overall}/100 (${verdict.safetyScore.tier})`);
  console.log(`   Evaluated in ${verdict.meta.evaluationDurationMs}ms`);

  await yourDEXRouter.executeSwap({ tokenIn, tokenOut, amount: amountWei });
  return { success: true };
}
```

---

### 6.2 `scanToken()` — Lightweight Pre-screen

Runs only the token risk analyzer. Use this before even building a swap transaction, as a first-pass filter.

**Signature:**
```typescript
async function scanToken(
  request: TokenScanRequest,
  config?: Partial<GuardianConfig>
): Promise<TokenScanResponse>
```

```typescript
import { scanToken } from "@guardian-protocol/skill";

// Pre-screen a token before constructing any transaction
async function isTokenTradeable(tokenAddress: string): Promise<boolean> {
  const scan = await scanToken({ tokenAddress, chainId: 196 });

  if (!scan.isSafe) {
    console.log(`Token ${tokenAddress} flagged: ${scan.safetyScore.tier}`);
    for (const flag of scan.flags) {
      console.log(`  [${flag.severity.toUpperCase()}] ${flag.code}: ${flag.message}`);
    }
    return false;
  }

  return true;
}

// Use in token discovery pipeline
const candidates = await discoverNewTokens();
const safe = await Promise.all(
  candidates.map(async (addr) => ({
    address: addr,
    safe: await isTokenTradeable(addr),
  }))
);
const tradeable = safe.filter((t) => t.safe).map((t) => t.address);
```

---

### 6.3 `simulateTx()` — Standalone Simulation

Useful when you have a transaction hex from an external source (OKX DEX API, custom router, etc.) and want to validate it before broadcast.

**Signature:**
```typescript
async function simulateTx(
  request: TxSimulationRequest,
  config?: Partial<GuardianConfig>
): Promise<TxSimulationResponse>
```

```typescript
import { simulateTx } from "@guardian-protocol/skill";

// Build tx from OKX DEX API, then validate before sending
const dexQuote = await okxDEX.getSwapTx({ ... });

const sim = await simulateTx({
  proposedTxHex: dexQuote.tx.data,
  userAddress:   walletAddress,
  chainId:       196,
});

if (!sim.simulationSuccess) {
  console.error("Transaction would revert. Flags:", sim.flags);
  return;  // Don't send
}

console.log(`Simulation passed. Estimated gas: ${sim.gasUsed}`);
// Now safe to sign and broadcast
await wallet.sendTransaction({ data: dexQuote.tx.data, ... });
```

---

## 7. Understanding the Response

### The Verdict Field: `isSafeToExecute`

This is the only field that matters for the execution decision.

```
isSafeToExecute: true  → All criteria met. Execute the swap.
isSafeToExecute: false → Criteria not met. DO NOT execute. See flags.
```

The logic behind `false`:
- Score < safety threshold (default 70), OR
- Any single analyzer score < 20 (sub-score floor), OR
- Any `CRITICAL` severity flag present, OR
- 3 or more `HIGH` severity flags present

### Safety Score & Tiers

| Tier | Score Range | `isSafeToExecute` | What To Do |
|------|------------|-------------------|-----------| 
| ✅ **SAFE** | 90–100 | `true` | Execute. All clear. |
| ⚠️ **MODERATE** | 70–89 | `true` | Execute. Review flags for context. |
| 🔶 **CAUTION** | 50–69 | `false` | Do NOT execute. Significant risks. |
| 🟠 **DANGEROUS** | 30–49 | `false` | Do NOT execute. Multiple serious signals. |
| 🔴 **CRITICAL** | 0–29 | `false` | Do NOT execute. Fatal risk or system error. |

### Risk Flags Anatomy

Every entry in the `flags` array has this shape:

```json
{
  "code": "HONEYPOT_DETECTED",
  "severity": "critical",
  "message": "Token 0x1E4a... has been classified as a honeypot by OKX Security API and confirmed by GoPlus Security. The sell function is disabled post-purchase. You will NOT be able to sell this token after buying.",
  "source": "token-risk-analyzer"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `code` | string | Machine-readable identifier. Use this in your agent's logic. |
| `severity` | `critical` \| `high` \| `medium` \| `low` \| `info` | Risk severity level. `critical` and `high` cause blocks. |
| `message` | string | Human-readable explanation of the specific risk with context. |
| `source` | string | Which analyzer detected this flag. |

**Severity hierarchy:**
- `critical` — Confirmed fatal risk. Trade will fail or funds will be lost. Always blocks.
- `high` — Strong risk signal. Three or more block the trade.
- `medium` — Notable signal. Monitored but not individually decisive.
- `low` — Minor concern. Informational.
- `info` — Contextual data. Not risk-indicative.

### Complete Flag Catalog

#### 🔍 Token Risk Flags

| Flag Code | Severity | Trigger Condition |
|-----------|----------|-------------------|
| `HONEYPOT_DETECTED` | 🔴 CRITICAL | OKX API or GoPlus classifies this as a honeypot contract |
| `BLACKLIST_FUNCTION` | 🔴 CRITICAL | Contract ABI includes wallet freezing capability |
| `HIGH_TAX_TOKEN` | 🟠 HIGH | Buy or sell tax exceeds configured threshold (default: 10% warn, 30% danger) |
| `MINT_FUNCTION_PRESENT` | 🟠 HIGH | Unlimited mint function present and not renounced |
| `UNVERIFIED_CONTRACT` | 🟠 HIGH | Source code not verified on block explorer |
| `OWNERSHIP_NOT_RENOUNCED` | 🟡 MEDIUM | Owner address ≠ zero address (admin controls active) |
| `LOW_HOLDER_COUNT` | 🟡 MEDIUM | Fewer than `minHolderCount` unique holders (default: 50) |

#### 📡 Transaction Simulation Flags

| Flag Code | Severity | Trigger Condition |
|-----------|----------|-------------------|
| `TX_SIMULATION_REVERTED` | 🔴 CRITICAL | `eth_call` returns a revert — transaction would fail on-chain |
| `HIGH_PRICE_IMPACT` | 🟠 HIGH | Simulated slippage exceeds `maxSlippageBps` threshold |
| `FUZZING_INVARIANT_VIOLATION` | 🟠 HIGH | One of the 8 fuzzing variants triggered a revert not in the base call |
| `UNEXPECTED_STATE_CHANGE` | 🟡 MEDIUM | Simulated balance changes don't match expected token transfer patterns |
| `GAS_ESTIMATION_FAILED` | 🟡 MEDIUM | Gas estimation returned a value far outside normal range |

#### 🥪 MEV Detection Flags

| Flag Code | Severity | Trigger Condition |
|-----------|----------|-------------------|
| `SANDWICH_ATTACK_LIKELY` | 🟠 HIGH | Trade size vs. pool depth ratio creates profitable sandwich window |
| `FRONTRUN_RISK_HIGH` | 🟠 HIGH | Frontrunning is profitable for bots at this trade size |
| `PRIVATE_MEV_FLOW_HIGH` | 🟡 MEDIUM | Builder toxicity score indicates high private MEV flow on this pair |

#### 💧 AMM Pool Flags

| Flag Code | Severity | Trigger Condition |
|-----------|----------|-------------------|
| `AMM_THIN_LIQUIDITY` | 🔴 CRITICAL or 🟠 HIGH | Near-zero liquidity at the current execution tick |
| `AMM_TICK_GAP_MANIPULATION` | 🟠 HIGH | Tick gap ratio exceeds `maxTickGapMultiplier` × tick spacing |
| `AMM_PRICE_DEVIATION` | 🟡 MEDIUM | `sqrtPriceX96` deviates > `maxPriceDeviationRatio` from theoretical tick price |
| `AMM_ONESIDED_LIQUIDITY` | 🟡 MEDIUM | Liquidity asymmetry ratio exceeds `liquidityAsymmetryThreshold` |

### Score Breakdown & Weights

The `safetyScore.breakdown` gives you per-analyzer sub-scores:

```json
"breakdown": {
  "tokenRisk":    95,   // 30% weight — OKX + GoPlus dual-oracle verdict
  "txSimulation": 88,   // 30% weight — eth_call + OKX cross-validation + fuzzing
  "mevRisk":      71,   // 15% weight — mempool + private flow + builder toxicity
  "ammPoolRisk":  92    // 25% weight — on-chain concentrated liquidity state
}
```

The overall score is not a simple average:

```
weighted = (tokenRisk × 0.30) + (txSim × 0.30) + (mev × 0.15) + (amm × 0.25)

finalScore = weighted × confidenceFactor × (1 - correlationPenalty)
```

Where:
- `confidenceFactor` degrades with each failed analyzer (1.0 → 0.95 → 0.85 → 0.70 → 0.50)
- `correlationPenalty` is applied when correlated risk patterns are detected:
  - Thin AMM liquidity + high slippage = `−60%` (confirmed pool manipulation)
  - AMM price deviation + sandwich = `−40%` (coordinated attack)
  - One-sided liquidity + mintable token = `−30%` (rug-pull signature)

---

## 8. Real-World Integration Patterns

### Pattern 1: Trading Bot Guard

The canonical integration. Every trade opportunity goes through Guardian before execution.

```typescript
import { evaluateTrade } from "@guardian-protocol/skill";

interface TradeOpportunity {
  tokenIn:  string;
  tokenOut: string;
  amount:   string;
  expectedProfit: number;
}

async function processOpportunities(
  opportunities: TradeOpportunity[],
  walletAddress: string
): Promise<void> {

  for (const opp of opportunities) {
    console.log(`\n[Guardian] Evaluating ${opp.tokenIn.slice(0, 8)}→${opp.tokenOut.slice(0, 8)}`);

    const verdict = await evaluateTrade({
      tokenIn:     opp.tokenIn,
      tokenOut:    opp.tokenOut,
      amount:      opp.amount,
      userAddress: walletAddress,
      chainId:     196,
    });

    if (!verdict.isSafeToExecute) {
      // Log the block for analysis
      const primaryFlag = verdict.flags[0];
      console.log(`⛔ SKIPPED — [${verdict.safetyScore.tier}] ${primaryFlag?.code}`);
      console.log(`   Score: ${verdict.safetyScore.overall}/100`);
      console.log(`   Reason: ${primaryFlag?.message?.slice(0, 100)}...`);
      continue;  // Move to next opportunity
    }

    // Check if profit still makes sense given MEV context
    const mevScore = verdict.safetyScore.breakdown?.mevRisk ?? 100;
    if (mevScore < 60 && opp.expectedProfit < 50) {
      console.log(`⚠️ SKIPPED — MEV risk outweighs thin margin ($${opp.expectedProfit} profit, MEV score: ${mevScore})`);
      continue;
    }

    // Execute the trade
    console.log(`✅ EXECUTING — Score: ${verdict.safetyScore.overall}/100 (${verdict.safetyScore.tier})`);
    await executeTrade(opp, walletAddress);
  }
}
```

---

### Pattern 2: Token Pre-screener

Build a token watchlist with Guardian as the filter. Run before constructing any transaction.

```typescript
import { scanToken } from "@guardian-protocol/skill";

async function buildSafeWatchlist(
  candidateAddresses: string[]
): Promise<{ safe: string[]; flagged: Map<string, string> }> {

  const safe: string[] = [];
  const flagged = new Map<string, string>();

  // Parallel scan — Guardian is fast enough to batch
  const results = await Promise.allSettled(
    candidateAddresses.map(async (addr) => ({
      address: addr,
      scan: await scanToken({ tokenAddress: addr, chainId: 196 }),
    }))
  );

  for (const result of results) {
    if (result.status === "rejected") continue;

    const { address, scan } = result.value;

    if (scan.isSafe) {
      safe.push(address);
    } else {
      // Store the primary reason for logging/analytics
      const primaryFlag = scan.flags[0];
      flagged.set(address, `[${scan.safetyScore.tier}] ${primaryFlag?.code ?? "UNKNOWN"}`);
    }
  }

  console.log(`Screened ${candidateAddresses.length} tokens: ${safe.length} safe, ${flagged.size} flagged`);
  return { safe, flagged };
}
```

---

### Pattern 3: Arbitrage Safety Gate

For arbitrage bots where speed matters. Use `scanToken` first as a cheap pre-filter, full `evaluateTrade` only if the token passes.

```typescript
import { scanToken, evaluateTrade } from "@guardian-protocol/skill";

async function checkArbitrageOpportunity(
  tokenA: string,
  tokenB: string,
  amount: string,
  walletAddress: string
): Promise<boolean> {

  // ── Phase 1: Fast token pre-screen (< 500ms) ───────────────────────
  // Run both token scans in parallel
  const [scanA, scanB] = await Promise.all([
    scanToken({ tokenAddress: tokenA, chainId: 196 }),
    scanToken({ tokenAddress: tokenB, chainId: 196 }),
  ]);

  if (!scanA.isSafe || !scanB.isSafe) {
    const blocked = !scanA.isSafe ? tokenA : tokenB;
    console.log(`Pre-screen failed: ${blocked.slice(0, 8)} → ${(!scanA.isSafe ? scanA : scanB).flags[0]?.code}`);
    return false;
  }

  // ── Phase 2: Full evaluation (< 2s) ────────────────────────────────
  const verdict = await evaluateTrade({
    tokenIn:     tokenA,
    tokenOut:    tokenB,
    amount:      amount,
    userAddress: walletAddress,
    chainId:     196,
  });

  return verdict.isSafeToExecute;
}
```

---

### Pattern 4: Portfolio Risk Monitor

Continuously monitor held tokens for emerging risk signals.

```typescript
import { scanToken } from "@guardian-protocol/skill";
import type { RiskFlag } from "@guardian-protocol/skill";

interface TokenPosition {
  address:     string;
  symbol:      string;
  valueUsd:    number;
  lastScanned: Date;
}

async function monitorPortfolioRisk(
  portfolio: TokenPosition[],
  alertCallback: (token: TokenPosition, flags: RiskFlag[]) => void
): Promise<void> {

  for (const token of portfolio) {
    const scan = await scanToken({ tokenAddress: token.address, chainId: 196 });

    if (!scan.isSafe) {
      const highFlags = scan.flags.filter(f => f.severity === "critical" || f.severity === "high");

      if (highFlags.length > 0) {
        console.warn(`⚠️ Risk alert: ${token.symbol} (${token.address.slice(0, 8)}...)`);
        console.warn(`   Position value: $${token.valueUsd.toFixed(2)}`);
        console.warn(`   Score: ${scan.safetyScore.overall}/100 (${scan.safetyScore.tier})`);

        for (const flag of highFlags) {
          console.warn(`   [${flag.severity.toUpperCase()}] ${flag.code}: ${flag.message.slice(0, 100)}...`);
        }

        // Trigger external alert
        alertCallback(token, highFlags);
      }
    }

    // Rate-limit: scan one token per second to avoid API limits
    await new Promise(r => setTimeout(r, 1000));
  }
}
```

---

## 9. Agent Workflow Diagrams

### Full Swap Decision Flow

```
Agent has a swap opportunity
           │
           ▼
    ┌─────────────┐
    │ Is tokenOut │
    │ pre-screened│ NO → scanToken(tokenOut)
    │ already?    │           │
    └──────┬──────┘           ▼
           │            isSafe? ──NO──▶ Skip opportunity
           │YES              │YES
           └──────────────── ▼
                    evaluateTrade(tokenIn, tokenOut, amount)
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
         Token Risk      TX Sim         MEV + AMM
         (OKX+GPS)      + Fuzzing      Analyzers
              │              │              │
              └──────────────┴──────────────┘
                             │
                       Risk Engine
                    (Score 0–100 + flags)
                             │
                ┌────────────┴────────────┐
                │                         │
         isSafeToExecute?           isSafeToExecute?
              YES                         NO
                │                         │
         Execute swap              Log block reason
                                   Skip opportunity
```

### Fail-Closed Decision Logic

```
                   evaluateTrade() called
                           │
            ┌──────────────┼──────────────────┐
            │              │                  │
            ▼              ▼                  ▼
       API timeout?   Any score < 20?   CRITICAL flag?
            │              │                  │
           YES            YES               YES
            │              │                  │
            ▼              ▼                  ▼
        Score = 0      BLOCK trade       BLOCK trade
        BLOCK trade
            │
            ▼
     Overall score < 70?  ──YES──▶  BLOCK trade
            │NO
            ▼
     3+ HIGH flags?  ──YES──▶  BLOCK trade
            │NO
            ▼
     isSafeToExecute: true ✅
```

---

## 10. Advanced Configuration

Pass a configuration object as the second argument to any Guardian function to override defaults:

```typescript
import { evaluateTrade } from "@guardian-protocol/skill";
import type { GuardianConfig } from "@guardian-protocol/skill";

const strictConfig: Partial<GuardianConfig> = {

  // ── Scoring Weights (must sum to 1.0) ───────────────────────────────
  scoringWeights: {
    tokenRisk:    0.35,  // Higher if trading unknown tokens
    txSimulation: 0.30,
    mevSignals:   0.10,  // Lower if using private mempool
    ammPool:      0.25,
  },

  // ── Blocking Policy ─────────────────────────────────────────────────
  scoringPolicy: {
    safetyThreshold:       80,  // Stricter: require score ≥ 80 (default: 70)
    minimumSubScore:       25,  // Stricter: floor 25 instead of 20
    maxHighFlagsBeforeBlock: 2, // Stricter: block on 2 HIGH flags (default: 3)
  },

  // ── Token Risk Sensitivity ───────────────────────────────────────────
  tokenRisk: {
    buyTaxWarningPercent:  5,   // Flag above 5% (default: 10%)
    buyTaxDangerPercent:   15,  // Critical above 15% (default: 30%)
    sellTaxWarningPercent: 5,
    sellTaxDangerPercent:  15,
    minHolderCount:        100, // Require 100+ holders (default: 50)
  },

  // ── Transaction Simulation ───────────────────────────────────────────
  txSimulation: {
    maxSlippageBps: 300,         // 3% max slippage (default: 500 = 5%)
    slippageWarningBps: 100,     // Warn at 1% (default: 200)
  },

  // ── AMM Pool Analysis ────────────────────────────────────────────────
  ammPool: {
    minLiquidityDepthUsd:      25000,  // Require $25k minimum (default: $10k)
    maxTickGapMultiplier:      15,     // Stricter gap tolerance (default: 20)
    maxPriceDeviationRatio:    0.03,   // 3% max deviation (default: 5%)
    liquidityAsymmetryThreshold: 3.0, // Stricter asymmetry (default: 5.0)
    tickScanRange:             30,     // Scan 30 ticks each direction (default: 20)
  },
};

const verdict = await evaluateTrade(
  { tokenIn, tokenOut, amount, userAddress, chainId: 196 },
  strictConfig
);
```

### Configuration for High-Frequency Agents

If your agent runs at high frequency (many evaluations per minute), the LRU cache already handles OKX API rate limiting. But you should also tune:

```typescript
// For high-frequency loops: accept slightly more risk on MEV (mitigable via private mempool)
// but be absolute on token risk and simulation
const hfConfig: Partial<GuardianConfig> = {
  scoringWeights: {
    tokenRisk:    0.40,   // Critical — never compromise on honeypot detection
    txSimulation: 0.35,   // Critical — never trade a reverting transaction
    mevSignals:   0.10,   // MEV is handled via private mempool
    ammPool:      0.15,   // Reduce if trading only top-tier established pools
  },
};
```

---

## 11. Troubleshooting & FAQ

### Errors & Common Issues

**`"OKX_API_KEY is required but not set"`**

Your `.env` file is missing OKX credentials. Follow [Section 4.1](#41-environment-variables). Getting credentials from the [OKX Developer Portal](https://www.okx.com/web3/build/dev-portal) is free.

After adding credentials, re-run `npm test` — all 72 tests should pass.

---

**`"All RPC endpoints failed"`**

All three configured RPCs timed out (500ms each). Guardian blocks the trade (fail-closed). Check:
1. Internet connectivity
2. `.env` RPC URL values are correct
3. X Layer RPC status at https://www.okx.com/xlayer

Avoid using the same URL for all three endpoints — the whole point of redundancy is using different servers.

---

**`"Score is 0 but I'm confident the token is safe"`**

Score 0 with `UNVERIFIED_CONTRACT` or `HONEYPOT_DETECTED` usually means either:

- Your OKX API credentials are not configured (the API call fails, Guardian fails closed → score 0)
- The token is too new to be indexed by OKX Security API
- The token is on a chain not yet fully supported

This is by design. Guardian does not assume safety. If it cannot verify with confidence, it blocks. Configure your credentials correctly and retry.

---

**Tests failing after clone**

```bash
# Ensure dependencies are all installed
npm install

# Check TypeScript compiles cleanly
npx tsc --noEmit

# Run with full verbosity to see which test is failing
npx vitest run --reporter=verbose

# If tests pass but live-fire fails, that's a credentials issue — not a code issue
npm run live-fire  # requires OKX API credentials in .env
```

---

### FAQ

**Q: Does Guardian execute any transactions?**
> No. Guardian is 100% read-only. It calls `eth_call` (simulation only), reads contract state, and calls security APIs. It never signs, constructs, or broadcasts any transaction. The signing key never touches Guardian.

**Q: Does Guardian work on mainnet and testnet?**
> Yes. Use `chainId: 196` for X Layer Mainnet, `chainId: 195` for X Layer Testnet. The OKX Security API and RPC client both support both chain IDs.

**Q: How does guardian handle chains other than X Layer?**
> Currently, Guardian is optimized and tuned for X Layer (Chain IDs 196/195). The architecture is chain-agnostic in design, but the OKX API integration scope and RPC configuration are X Layer-specific.

**Q: What happens if OKX Security API is down?**
> Guardian **blocks the trade** (score 0, `isSafeToExecute: false`). This is the fail-closed contract: uncertain safety = blocked. Your agent should treat this as a temporary outage and retry — not as a signal to proceed anyway.

**Q: Can I use Guardian in production?**
> Yes. v0.2.1 includes: 3-endpoint RPC redundancy, 8-variant state fuzzing, dual-oracle token scanning, private MEV flow detection, AMM tick analysis, and cross-analyzer penalty cascading. It was explicitly designed for adversarial mainnet conditions. The 72-test suite validates all failure modes. The live fire log shows it running against X Layer Mainnet.

**Q: What's the difference between `evaluate` and `scan-token`?**
> `evaluate` runs the **full pipeline** (all 4 analyzers: token risk, simulation, MEV, AMM pool) and returns a full verdict with optimized routing meta. `scan-token` runs **only the token risk analyzer** — faster and cheaper, useful for pre-screening before constructing a transaction. If you don't have a transaction hex yet, `scan-token` is the right tool.

**Q: Can I increase the safety threshold for higher-stakes trades?**
> Yes. Set `GUARDIAN_SAFETY_THRESHOLD=85` in `.env` for a stricter threshold, or pass `{ scoringPolicy: { safetyThreshold: 85 } }` as the config argument to `evaluateTrade()`.

**Q: How does Guardian handle concentrated liquidity vs. traditional AMM pools?**
> The AMM Pool Analyzer reads Uniswap V3-compatible ABI functions (`slot0`, `liquidity`, `ticks`, `tickSpacing`). For traditional constant-product pools (Uniswap V2 style), the pool read will fail gracefully — returning a cautious score of 60 rather than blocking — because the manipulation vectors specific to concentrated liquidity (tick gaps, price deviation) don't apply to constant-product pools.

**Q: What is the `GoPlus Security` integration?**
> GoPlus Security is a secondary security oracle that provides independent honeypot classification. Guardian's Token Risk Analyzer calls both OKX Security API and GoPlus Security for every token scan, then cross-validates the results. If the two disagree (one says clean, one says honeypot), a penalty is applied. Two independent honeypot confirmations are far more reliable than one.

---

<div align="center">

---

**Guardian Protocol** — *The security oracle autonomous agents have been waiting for.*

[README](./README.md) · [SKILL.md](./SKILL.md) · [CHANGELOG](./CHANGELOG.md) · [CONTRIBUTING](./CONTRIBUTING.md)

*Built for OKX Build X Hackathon — Skill Arena Track*

---

</div>
