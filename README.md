<div align="center">

<br/>

```
  ╔══════════════════════════════════════════════════════════════════╗
  ║                                                                  ║
  ║   ██████╗ ██╗   ██╗ █████╗ ██████╗ ██████╗ ██╗ █████╗ ███╗  ██╗ ║
  ║  ██╔════╝ ██║   ██║██╔══██╗██╔══██╗██╔══██╗██║██╔══██╗████╗ ██║ ║
  ║  ██║  ███╗██║   ██║███████║██████╔╝██║  ██║██║███████║██╔██╗██║ ║
  ║  ██║   ██║██║   ██║██╔══██║██╔══██╗██║  ██║██║██╔══██║██║╚████║ ║
  ║  ╚██████╔╝╚██████╔╝██║  ██║██║  ██║██████╔╝██║██║  ██║██║ ╚███║ ║
  ║   ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝╚═╝  ╚═╝╚═╝  ╚══╝ ║
  ║                                                                  ║
  ║   P  R  O  T  O  C  O  L                                        ║
  ║                                                                  ║
  ╚══════════════════════════════════════════════════════════════════╝
```

# 🛡️ Guardian Protocol

### *The Security Oracle That Lets Agents Trade Without Fear*

> **Fail-Closed. Paranoid by Design. Built for Autonomous Agents on X Layer.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/72%2F72_Tests-PASSING-22c55e?style=for-the-badge&logo=vitest)](./tests)
[![X Layer](https://img.shields.io/badge/X_Layer-196_Mainnet-7B61FF?style=for-the-badge)](https://www.okx.com/xlayer)
[![OKX OnchainOS](https://img.shields.io/badge/OKX-OnchainOS_Integrated-000000?style=for-the-badge&logo=okx)](https://www.okx.com/web3)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](./LICENSE)
[![Version](https://img.shields.io/badge/Version-0.2.1_Security_Hardened-orange?style=for-the-badge)](./CHANGELOG.md)

<br/>

**An autonomous AI agent can't smell a honeypot. It can't sense a sandwich attack forming in the mempool. It can't read a manipulated liquidity pool. Guardian Protocol can — and it answers in under 2 seconds.**

<br/>

</div>

---

## ⚡ The Problem No One Is Solving

Autonomous AI agents are executing real trades on real chains with real money. They're doing it faster than any human ever could. But they're doing it **blind.**

Every other DeFi security tool is built for humans: visual dashboards, browser extensions, manual lookups. When an agent needs to know *right now* whether a trade is safe, those tools are useless.

Worse: most security tools fail **open**. If the scan returns nothing — no result, timeout, unknown token — they say *"probably fine, proceed."* For an autonomous agent running thousands of trade evaluations, that's not a safety policy. That's Russian roulette.

**Guardian Protocol is different. We fail closed.**

> *If we cannot confirm it's safe with high confidence — the trade is blocked. Full stop.*

---

## 🎯 What Guardian Protocol Is

Guardian Protocol is a **reusable Agent Skill** — a drop-in security middleware that any autonomous agent can call before executing an on-chain swap on X Layer.

One function call. One JSON verdict. No ambiguity.

```typescript
const verdict = await evaluateTrade({ tokenIn, tokenOut, amount, chainId: 196 });

if (verdict.isSafeToExecute) {
  executeSwap();   // ✅ Guardian cleared this trade
} else {
  abort();         // ⛔ Guardian blocked it — reasons in verdict.flags
}
```

That's the entire integration. Behind those two lines: a four-engine security pipeline running in parallel, powered by OKX's infrastructure, designed to withstand adversarial mainnet conditions.

**Sample CLI Evaluation Output:**
```json
{
  "isSafeToExecute": false,
  "safetyScore": { "overall": 0, "tier": "CRITICAL" },
  "flags": [
    { "code": "HONEYPOT_DETECTED", "severity": "CRITICAL", "message": "Contract code matches known honeypot pattern: sell function disabled post-buy." }
  ]
}
```

---

## 🏗️ Architecture: Four Engines. One Verdict. Under 2 Seconds.

```
  +--------------------------------------------------------------+
  |                                                              |
  |  Agent --> evaluateTrade(request) --> GUARDIAN ORCHESTRATOR   |
  |                                                              |
  |  +--------------+ +--------------+ +-------------+ +--------+|
  |  | TOKEN RISK   | | TX SIM       | | MEV         | | AMM    ||
  |  | (30%)        | | + FUZZING    | | DETECTION   | | POOL   ||
  |  |              | | (30%)        | | (15%)       | | (25%)  ||
  |  | Honeypot     | | eth_call     | | Sandwich    | | Thin   ||
  |  | Tax scan     | | dry-run      | | Frontrun    | | liq.   ||
  |  | Blacklist    | | OKX cross-   | | Private     | | Tick   ||
  |  | Mint fn      | | validation   | | MEV flow    | | gap    ||
  |  | Holders      | | 8-variant    | | Builder     | | Price  ||
  |  | GoPlus API   | | invariant    | | toxicity    | | dev.   ||
  |  | OKX API      | | fuzzer       | | Dyn. slip   | | 1-side ||
  |  +------+-------+ +------+-------+ +------+------+ +---+----+|
  |         |                |                |             |     |
  |         +----------------+----------------+-------------+     |
  |                          |                                    |
  |              +-----------v-----------------+                  |
  |              |        RISK ENGINE          |                  |
  |              | Weights: 30 / 30 / 15 / 25  |                  |
  |              | Penalty cascades            |                  |
  |              | Cross-analyzer correlation  |                  |
  |              | Sub-score floor enforcement |                  |
  |              | Confidence degradation      |                  |
  |              +-----------+-----------------+                  |
  |                          |                                    |
  |         +----------------v---------------------+              |
  |         | { isSafeToExecute, safetyScore, flags }             |
  |         +------------------------------------------+          |
  |                                                              |
  +--------------------------------------------------------------+
```

### Engine 1 — Token Risk Analyzer (`30% weight`)
*Powered by OKX Security API + GoPlus Security (dual-oracle)*

Calls **two independent security oracles** for every token. Not one — two. The OKX Security API is the primary source; GoPlus Security provides a cross-validated second opinion on every honeypot classification. If they disagree, the score takes a penalty. If either times out, the trade is blocked.

What it detects: **honeypots, hidden sell taxes, blacklist wallet functions, unlimited mint capabilities, unverified contracts, low holder counts (rug-pull indicators), ownership not renounced.**

### Engine 2 — TX Simulation + Fuzzing (`30% weight`)
*eth_call → OKX cross-validation → 8-variant invariant fuzzer*

Simulates the transaction **three times over**: first with `eth_call` on X Layer's RPC, then cross-validated against OKX's independent pre-execution scanner. If they produce different results — the trade is blocked. Then comes the **invariant fuzzer**: 8 calldata mutation variants (zero-args, max-uint256, half/double/10x amounts, byte-flip, truncation) are thrown at the contract to find state-dependent traps that only trigger under specific conditions. Static analysis misses these. We don't.

### Engine 3 — MEV Detection (`15% weight`)
*Private flow awareness + builder toxicity tracking*

Mempool analysis isn't enough anymore. Private MEV via Flashbots-style bundles is **invisible to standard mempool scans**. Guardian tracks builder toxicity per-block using an LRU cache (256 builders, 1hr TTL), estimates private MEV flow exposure, and computes a **dynamic slippage cap** that automatically tightens under volatile or toxic conditions. An agent running with a static 0.5% slippage in a MEV-toxic environment is an agent getting extracted from.

### Engine 4 — AMM Pool Analyzer (`25% weight`)
*On-chain concentrated liquidity state reads*

This is the analyzer that no other tool has. It reads the **raw on-chain state** of the concentrated liquidity pool directly — `slot0()`, `liquidity()`, `ticks()`, `tickSpacing()` — using a Uniswap V3-compatible ABI. It detects liquidity manipulation that is completely invisible to traditional constant-product analysis:

- **Tick gap manipulation** — Liquidity withdrawn near the current price creates a price cliff. The trade executes; the price dumps.
- **sqrtPriceX96 deviation** — The reported pool price doesn't match the theoretical price implied by the current tick. Someone is lying.
- **One-sided liquidity** — 90% of liquidity concentrated above or below the current price is the fingerprint of a coordinated extraction setup.
- **Thin liquidity at tick** — Zero active liquidity at the execution tick means your trade walks off a cliff.

---

## 🔩 The Fail-Closed Security Model

```
   ┌─── CAN WE CONFIRM SAFETY WITH HIGH CONFIDENCE? ───┐
   │                                                    │
   │   YES, all analyzers succeeded                     │
   │   AND score ≥ 70                                   │
   │   AND no sub-score < 20                            │
   │   AND no CRITICAL flags                            │
   │          ↓                                         │
   │      ✅ APPROVE                                    │
   │                                                    │
   │   ANYTHING ELSE → ⛔ BLOCK                         │
   │                                                    │
   │   Examples:                                        │
   │   • API timeout         → Score 0   → BLOCK        │
   │   • RPC unreachable     → Failover  → BLOCK if all │
   │   • Unknown token       → Score 0   → BLOCK        │
   │   • OKX ≠ eth_call      → Penalty   → Likely BLOCK │
   │   • Fuzzer finds trap   → Flag      → BLOCK        │
   │   • Zero tick liquidity → CRITICAL  → BLOCK        │
   │   • Builder toxicity ↑  → Slippage ↓→ May BLOCK   │
   └────────────────────────────────────────────────────┘
```

This is not a "show the user a warning" design. This is a **gate**. Agents don't get warnings — they get `true` or `false`. A value of `false` means the swap function never gets called. Period.

---

## 📡 OKX OnchainOS Integration

Guardian Protocol is not bolted onto OKX infrastructure — it is *built from it*. Every security judgment passes through OKX's APIs.

| OKX Component | Guardian's Usage |
|---|---|
| **OKX Security API — Token Scan** | Primary oracle: honeypot classification, buy/sell tax, blacklist detection, holder analysis |
| **OKX Security API — TX Pre-execution** | Independent cross-validator: our `eth_call` result is verified against OKX's external simulation. Disagreements trigger a penalty. |
| **OKX DEX API** | Supported architecture for Phase 3 optimized execution routing post-verdict |
| **HMAC-SHA256 Auth** | Full OKX API v5 authentication: `OK-ACCESS-KEY`, `OK-ACCESS-SIGN`, `OK-ACCESS-TIMESTAMP`, `OK-ACCESS-PASSPHRASE` |
| **X Layer RPC** (`xlayerrpc.okx.com`) | Native viem-based client with 3-endpoint round-robin and 500ms per-endpoint timeout |
| **Chain ID 196 / 195** | Native mainnet + testnet support |

When the OKX API returns a honeypot flag, the specific reason is surfaced in the `flags` array: *"Contract code matches known honeypot pattern: sell function disabled post-buy."* Not a generic warning. A specific, actionable diagnosis.

---

## 🦄 Uniswap AI Skills Integration

Guardian Protocol integrates [Uniswap's official AI Skills](https://github.com/Uniswap/uniswap-ai) (`npx skills add Uniswap/uniswap-ai`) into its AMM pool analyzer for protocol-specific security capabilities that generic tools miss.

**Uniswap AI Skills Referenced:**

| Uniswap AI Skill | Guardian's Usage |
|---|---|
| **swap-integration** | TWAP verification patterns — Guardian reads Uniswap V3 observations to detect spot/TWAP price deviations that indicate flash loan manipulation |
| **uniswap-v4-security-foundations** | V4 hook permission risk model — Guardian assesses `beforeSwapReturnDelta`, `afterSwapReturnDelta`, and other dangerous hook permissions that can modify swap pricing |
| **uniswap-driver** | Swap planning and price validation reference — Guardian uses the same observation window methodology for TWAP-based oracle integrity verification |
| **uniswap-viem** | EVM integration patterns — Guardian's pool state reads use the same viem + Uniswap V3 ABI patterns for `slot0()`, `liquidity()`, `ticks()`, `observe()` |

**What Guardian adds on top of Uniswap AI Skills:**

1. **TWAP Oracle Deviation Analysis** — Reads Uniswap V3's `observe()` function to compute 5-minute and 30-minute TWAPs, then compares against spot price. A >2% deviation triggers a warning; >5% flags manipulation (likely flash loan attack in progress).

2. **V4 Hook Security Assessment** — For Uniswap V4 pools, Guardian reads hook permissions and flags dangerous combinations:
   - `beforeSwapReturnDelta` = **HIGH risk** (hook can modify swap pricing arbitrarily)
   - `afterSwapReturnDelta` = **MEDIUM risk** (hook can modify output amounts)
   - Standard `beforeSwap` / `afterSwap` = **LOW risk** (common for oracles, fees)

3. **Concentrated Liquidity Manipulation Detection** — What Uniswap AI tools don't cover: reading raw tick-level liquidity distribution to detect strategic removal of liquidity near the current price (tick gap manipulation), one-sided liquidity (rug-pull signal), and zero-liquidity execution ticks.

> **Install Uniswap AI Skills:** `npx skills add Uniswap/uniswap-ai`  
> **Source:** [Uniswap/uniswap-ai](https://github.com/Uniswap/uniswap-ai)

---

## 📊 Safety Score System

Every evaluation returns a composite score `0–100` computed via weighted aggregation with penalty cascading.

| Tier | Score | Machine Verdict | Meaning |
|------|-------|----------------|---------|
| ✅ **SAFE** | 90–100 | `isSafeToExecute: true` | All analyzers clear. Execute. |
| ⚠️ **MODERATE** | 70–89 | `isSafeToExecute: true` | Minor signals. Present but manageable. Review flags. |
| 🔶 **CAUTION** | 50–69 | `isSafeToExecute: false` | Significant risk. **Blocked.** |
| 🟠 **DANGEROUS** | 30–49 | `isSafeToExecute: false` | Multiple serious vectors. **Blocked.** |
| 🔴 **CRITICAL** | 0–29 | `isSafeToExecute: false` | Fatal signal or analyzer failure. **Blocked.** |

### Scoring Rules (Beyond Simple Averaging)

The risk engine is not a calculator — it's an adversarial model:

- **Sub-score floor** — Any single analyzer scoring below 20 blocks the trade *regardless of the overall score*. A token that scores 95 but has a simulation revert is still blocked.
- **Cross-analyzer penalty cascades** — Correlated risk signals amplify each other:
  - `AMM_THIN_LIQUIDITY` + high simulation slippage → **−60% penalty** (confirmed pool manipulation)
  - `AMM_PRICE_DEVIATION` + `SANDWICH_ATTACK_LIKELY` → **−40% penalty** (coordinated attack pattern)
  - `AMM_ONESIDED_LIQUIDITY` + `MINT_FUNCTION_PRESENT` → **−30% penalty** (rug-pull signature)
- **Confidence degradation** — Each failed analyzer reduces the confidence factor applied to the final score. Three failed analyzers = score effectively halved before verdict.

---

## 🚀 Quick Start

### Prerequisites
- Node.js ≥ 20.0.0
- OKX API credentials — [OKX Developer Portal](https://www.okx.com/web3/build/dev-portal)
- An X Layer RPC endpoint (public: `https://rpc.xlayer.tech`)

### Installation

```bash
# Clone
git clone https://github.com/anujkumar2o/guardian-protocol.git
cd guardian-protocol

# Install
npm install

# Configure
cp .env.example .env
# Add your OKX API credentials to .env

# Verify — all 72 tests should pass
npm test

# Live fire against X Layer Mainnet
npm run live-fire
```

### CLI Usage

```bash
# Full trade evaluation: Is this WOKB → USDC swap safe?
npx tsx src/cli.ts evaluate \
  0xe538905cf8410324e03A5A23C1c177a474D59b2b \
  0x1E4a5963aBFD975d8c9021ce480b42188849D41d \
  1000000000000000000 \
  --chain 196

# Quick token screen: Is this token a honeypot?
npx tsx src/cli.ts scan-token \
  0xe538905cf8410324e03A5A23C1c177a474D59b2b \
  --chain 196

# Pre-flight check: Will this transaction revert?
npx tsx src/cli.ts simulate-tx \
  0xYourRawTxHex \
  --user 0xYourWallet \
  --chain 196
```

All CLI output is **pure JSON on stdout**. Agents parse it directly. Structured logs on stderr. No mixing.

### Library API

```typescript
import { evaluateTrade, scanToken, simulateTx } from "@guardian-protocol/skill";

// ── Pattern 1: Full pipeline (recommended for every swap) ──
const verdict = await evaluateTrade({
  tokenIn:     "0xe538905cf8410324e03A5A23C1c177a474D59b2b",
  tokenOut:    "0x1E4a5963aBFD975d8c9021ce480b42188849D41d",
  amount:      "1000000000000000000",
  userAddress: "0xYourWallet",
  chainId:     196,  // X Layer Mainnet
});

if (verdict.isSafeToExecute) {
  // Execute your swap — Guardian doesn't execute trades, only evaluates them
  await executeSwap({ tokenIn, tokenOut, amount });
  // Note: verdict.optimizedRouting is a Phase 3 field (currently null)
} else {
  // Structured flags tell the agent exactly why
  for (const flag of verdict.flags) {
    console.log(`[${flag.severity.toUpperCase()}] ${flag.code}: ${flag.message}`);
  }
}

// ── Pattern 2: Token pre-screen before even building a tx ──
const scan = await scanToken({ tokenAddress: "0x...", chainId: 196 });
if (!scan.isSafe) return; // don't waste gas building a tx for a honeypot

// ── Pattern 3: Validate a pre-built transaction ──
const sim = await simulateTx({ proposedTxHex: "0x...", userAddress: "0x...", chainId: 196 });
if (!sim.simulationSuccess) return; // tx would revert
```

---

## 🧪 Test Suite — 72 Tests, 5 Suites, All Passing

```bash
npm test                   # Full suite: 72/72 ✅
npm run test:watch         # Watch mode for development
npm run live-fire          # End-to-end test against X Layer Mainnet (Chain ID 196)
```

| Suite | Tests | What's Covered |
|-------|-------|----------------|
| `token-risk.test.ts` | 9 | Honeypot, blacklist, mint, tax, API failure → fail-closed |
| `tx-simulation.test.ts` | 13 | Revert, slippage, OKX cross-validation, 8-variant fuzzing, degradation |
| `mev-detection.test.ts` | 10 | Sandwich patterns, volatility, private flow, dynamic slippage, builder toxicity |
| `amm-pool-analyzer.test.ts` | 13 | Thin liquidity, tick gaps, price deviation, one-sided, score bounds |
| `risk-engine.test.ts` | 27 | Weighted scoring, all 3 AMM correlations, confidence, penalties, sub-score floors |
| **Total** | **72** | **100% passing ✅** |

The test suite is adversarial. It doesn't just test the happy path — it tests *everything that can go wrong* and verifies the system fails closed every time.

---

## ⚡ Performance Profile

| Metric | Value | Notes |
|--------|-------|-------|
| Full 4-analyzer pipeline | **< 2 seconds** | All 4 analyzers run concurrently via `Promise.all` |
| RPC failover budget | **~1.5s** | 3 endpoints × 500ms timeout each |
| Cache hit response | **< 1ms** | LRU cache serves repeat evaluations instantly |
| Cache TTL | **60 seconds** | Fresh enough for DeFi conditions |
| Cache capacity | **500 entries** | Handles high-frequency agent loops |
| Fuzzing variants | **8 per tx** | Mutation strategies covering all known trap patterns |

Agents running in evaluation loops never hit rate limits. The OKX API client wraps all requests in a 60-second LRU cache. The same token evaluated 50 times in a minute hits the API once.

---

## 🔍 Risk Flags Reference (30+ Signals)

| Category | Flag Code | Severity | What It Means |
|----------|-----------|----------|---------------|
| **Token** | `HONEYPOT_DETECTED` | 🔴 CRITICAL | Cannot sell after buying — funds permanently trapped |
| **Token** | `BLACKLIST_FUNCTION` | 🔴 CRITICAL | Contract can freeze your wallet address |
| **Token** | `HIGH_TAX_TOKEN` | 🟠 HIGH | Buy/sell tax exceeds threshold — guaranteed extraction |
| **Token** | `MINT_FUNCTION_PRESENT` | 🟠 HIGH | Deployer can print unlimited tokens, diluting holdings |
| **Token** | `UNVERIFIED_CONTRACT` | 🟠 HIGH | No verified source code — unauditable |
| **Token** | `OWNERSHIP_NOT_RENOUNCED` | 🟡 MEDIUM | Admin controls remain with deployer |
| **Token** | `LOW_HOLDER_COUNT` | 🟡 MEDIUM | Centralized distribution — rug-pull precursor |
| **TX Sim** | `TX_SIMULATION_REVERTED` | 🔴 CRITICAL | Transaction will fail on-chain — 100% wasted gas |
| **TX Sim** | `HIGH_PRICE_IMPACT` | 🟠 HIGH | Slippage beyond your tolerance |
| **TX Sim** | `FUZZING_INVARIANT_VIOLATION` | 🟠 HIGH | Hidden state-dependent revert trap discovered |
| **TX Sim** | `UNEXPECTED_STATE_CHANGE` | 🟡 MEDIUM | Suspicious token balance mutation |
| **TX Sim** | `GAS_ESTIMATION_FAILED` | 🟡 MEDIUM | Contract behaves unexpectedly during gas estimation |
| **MEV** | `SANDWICH_ATTACK_LIKELY` | 🟠 HIGH | Bots can profitably sandwich this trade |
| **MEV** | `FRONTRUN_RISK_HIGH` | 🟠 HIGH | Frontrunning is profitable at this trade size |
| **MEV** | `PRIVATE_MEV_FLOW_HIGH` | 🟡 MEDIUM | High invisible MEV via private builder bundles |
| **AMM** | `AMM_THIN_LIQUIDITY` | 🔴 CRITICAL | Zero or near-zero liquidity at execution price |
| **AMM** | `AMM_TICK_GAP_MANIPULATION` | 🟠 HIGH | Price cliff created by strategic liquidity removal |
| **AMM** | `AMM_PRICE_DEVIATION` | 🟡 MEDIUM | Pool price deviates from its theoretical fair value |
| **AMM** | `AMM_ONESIDED_LIQUIDITY` | 🟡 MEDIUM | Asymmetric liquidity — coordinated extraction signal |

---

## 📁 Project Structure

```
guardian-protocol/
├── src/
│   ├── index.ts                      # Orchestrator — evaluateTrade(), scanToken(), simulateTx()
│   ├── cli.ts                        # Agent CLI — JSON-only output, 3 commands
│   ├── analyzers/
│   │   ├── token-risk.ts             # OKX + GoPlus dual-oracle honeypot/tax/blacklist detection
│   │   ├── tx-simulation.ts          # eth_call + OKX cross-validation + 8-variant invariant fuzzer
│   │   ├── mev-detection.ts          # Sandwich + private flow + builder toxicity + dynamic slippage
│   │   └── amm-pool-analyzer.ts      # On-chain concentrated liquidity pool state analysis
│   ├── scoring/
│   │   ├── risk-engine.ts            # Weighted aggregation + penalty cascades + correlation detection
│   │   └── thresholds.ts             # Configurable weights (30/30/15/25) + all policy thresholds
│   ├── services/
│   │   ├── okx-security-client.ts    # HMAC-SHA256 signed OKX API v5 client + LRU cache
│   │   └── xlayer-rpc-client.ts      # Round-robin RPC manager (3 endpoints, 500ms failover)
│   ├── types/
│   │   ├── input.ts                  # GuardianEvaluationRequest schema
│   │   ├── output.ts                 # GuardianEvaluationResponse + SafetyScore + 30+ RiskFlagCodes
│   │   ├── internal.ts               # AnalyzerResult inter-module contract
│   │   └── okx-api.ts                # OKX API response type definitions
│   └── utils/
│       ├── errors.ts                 # GuardianError + structured error codes
│       ├── logger.ts                 # Structured JSON logger (stdout/stderr separation)
│       └── hex.ts                    # Hex validation + utilities
├── tests/unit/
│   ├── analyzers/                    # 45 analyzer unit tests
│   └── scoring/                      # 27 risk engine / scoring tests
├── scripts/
│   └── live-fire.ts                  # End-to-end mainnet demo (X Layer 196)
├── CHANGELOG.md                      # Version history
├── LIVE_FIRE_LOG.txt                 # Actual live fire output from X Layer Mainnet (Chain ID 196)
├── SKILL.md                          # OnchainOS skill metadata
├── USAGE.md                          # Integration guide
└── MOLTBOOK_PITCH.md                 # Hackathon submission
```

---

## 🔑 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OKX_API_KEY` | ✅ | OKX OnchainOS API key |
| `OKX_SECRET_KEY` | ✅ | HMAC-SHA256 signing secret |
| `OKX_PASSPHRASE` | ✅ | Account passphrase |
| `OKX_PROJECT_ID` | ✅ | OKX project identifier |
| `XLAYER_RPC_URL` | ➖ | Primary RPC (default: `https://rpc.xlayer.tech`) |
| `XLAYER_RPC_URL_2` | ➖ | Secondary RPC for failover |
| `XLAYER_RPC_URL_3` | ➖ | Tertiary RPC for failover |
| `GUARDIAN_SAFETY_THRESHOLD` | ➖ | Override block threshold (default: `70`) |
| `GUARDIAN_MAX_SLIPPAGE_BPS` | ➖ | Max allowed slippage in bps (default: `500`) |
| `GUARDIAN_TX_SIMULATION_TIMEOUT_MS` | ➖ | Simulation + fuzz timeout (default: `10000`) |
| `GUARDIAN_RPC_ENDPOINT_TIMEOUT_MS` | ➖ | Per-endpoint failover budget (default: `500`) |

---

## 🔄 Version History

See [CHANGELOG.md](./CHANGELOG.md) for full history.

### v0.2.1 — Mainnet Hardening *(current)*
- 🆕 **Dual-oracle token scanning** — OKX Security API + GoPlus Security cross-validation
- 🆕 **AMM Pool Analyzer** — On-chain concentrated liquidity manipulation detection (4th engine)
- 🆕 **RPC Redundancy** — 3-endpoint round-robin with health-based failover
- 🆕 **TX Simulation Fuzzing** — 8-variant invariant testing engine
- 🆕 **Dynamic Slippage Caps** — Computed on the fly based on trade impact.
- 🆕 **Risk Engine Rebalancing** — 4-analyzer weights (30/30/15/25)
- 🆕 **Cross-Analyzer Correlations** — 3 compound penalty detectors
- 🆕 **72 tests** — Up from 50, all passing

### v0.1.0 — Initial Release
- Token risk, TX simulation, MEV detection, risk engine, CLI, live fire demo

---

## 🏆 OKX Build X Hackathon — Skill Arena Track

This is our **Skill Arena** submission. Guardian Protocol demonstrates what a *real, reusable, production-hardened agent skill* looks like:

- **Modular** — Three exposed functions (`evaluateTrade`, `scanToken`, `simulateTx`) composable as any agent needs
- **Machine-readable** — All output is structured JSON. No human in the loop required.
- **Fail-safe** — The default state is *blocked*. Safety requires active confirmation.
- **OKX-native** — Built on OKX Security APIs, targeting X Layer, using OKX infrastructure as the trust anchor
- **Tested** — 72 tests. Not demo tests. Adversarial tests.
- **Real on-chain activity** — Verified against X Layer Mainnet (Chain ID 196). See [`LIVE_FIRE_LOG.txt`](./LIVE_FIRE_LOG.txt).

### Agentic Wallet

```
0x6e9fb08755b837388a36ced22f26ed64240fb29c
```

> **X Layer Mainnet (Chain ID 196)** — [View on OKLink](https://www.oklink.com/xlayer/address/0x6e9fb08755b837388a36ced22f26ed64240fb29c)

### Verified GuardianProofLogger Deployment

```
0x93A3DB5645Cb21DBDfEAB3047Fe01D1A65a8F52F
```

> **X Layer Mainnet (Chain ID 196)** — [View on OKLink](https://www.oklink.com/xlayer/address/0x93a3db5645cb21dbdfeab3047fe01d1a65a8f52f)

### Author

- **Telegram:** [@bitnormie01](https://t.me/bitnormie01)

See [MOLTBOOK_PITCH.md](./MOLTBOOK_PITCH.md) for the full submission document.

---

<div align="center">

---

### 🛡️ Guardian Protocol

*The security oracle autonomous agents have been waiting for.*

*Because an agent that trades without a Guardian is an agent that eventually gets extracted from.*

**Built for OKX Build X Hackathon — Skill Arena Track**

---

</div>
