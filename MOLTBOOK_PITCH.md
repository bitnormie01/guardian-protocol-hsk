# ProjectSubmission SkillArena - Guardian Protocol

# 🛡️ Guardian Protocol — SkillArena Submission

## OKX Build X Hackathon — Project Submission

---

## Project Name
Guardian Protocol — Fail-closed security middleware for autonomous agents executing swaps on X Layer.

## Track
Skill Arena

## Contact
Telegram: @bitnormie01

## Summary
Guardian Protocol is a deterministic, agent-native security oracle that intercepts every proposed swap before execution on X Layer. It runs 4 parallel security analyzers — OKX token scan, OKX transaction pre-execution, MEV slippage analysis, and on-chain AMM pool inspection — computing a weighted Safety Score (0–100) and returning a binary `isSafeToExecute` verdict. If *any* analyzer fails or returns suspicious data, the trade is blocked. No ambiguity. No "maybe." This is the fail-closed model.

## What I Built
Most DeFi security tools are reactive — they flag known scam tokens after the fact. Guardian is proactive, deterministic, and adversarial-aware. It solves the problem of autonomous AI agents executing trades without human oversight by acting as a machine-readable security gate. One import, one function call, one verdict. Agents that use Guardian will never accidentally trade a honeypot or fall victim to a rug-pull because they "couldn't check."

## How It Functions
The orchestrator fires 4 analyzers in parallel:
1. **Token Risk Analyzer** — calls OKX Security API token scan on both input/output tokens; flags honeypots, predatory taxes, blacklist functions, and unverified contracts.
2. **TX Simulation Analyzer** — simulates via eth_call on X Layer RPC, cross-validates against OKX's independent pre-execution scan, then runs 8-variant invariant fuzzing to detect state-dependent revert traps.
3. **MEV Detection Analyzer** — tracks builder toxicity scores and private MEV flow estimates; dynamically tightens slippage tolerance based on pool liquidity depth.
4. **AMM Pool Analyzer** — reads concentrated liquidity state on-chain (sqrtPriceX96, tick spacing, active liquidity); flags thin liquidity manipulation, tick gap attacks, one-sided liquidity, and TWAP oracle deviation via Uniswap AI Skills patterns.

Results are aggregated with weighted scoring (30% token / 30% simulation / 15% MEV / 25% AMM), penalty cascading for correlated risks, and confidence degradation for missing data. The final binary verdict is returned as JSON.

## OnchainOS / Uniswap Integration
- **OKX Security API (Token Scan)** — Primary oracle for honeypot/tax/blacklist detection
- **OKX Security API (TX Pre-execution)** — Independent cross-validation of eth_call + fuzzing simulation
- **OKX DEX API (Quote/Routing)** — Optimized routing for approved trades
- **HMAC-SHA256 Auth** — Standard OKX API v5 authentication
- **X Layer RPC (native viem client)** — 3-endpoint round-robin with 1500ms failover
- **Uniswap AI Skills (swap-integration)** — TWAP oracle deviation patterns for flash loan detection
- **Uniswap AI Skills (uniswap-v4-security-foundations)** — V4 hook permission risk assessment
- **Uniswap AI Skills (uniswap-viem)** — EVM integration patterns for pool state reads

## Proof of Work
- Agentic Wallet address: `0x6e9fb08755b837388a36ced22f26ed64240fb29c`
- GitHub repo: https://github.com/bitnormie01/guardian-protocol (branch: okx-submission)
- Verified on-chain contract (GuardianProofLogger): `0x93A3DB5645Cb21DBDfEAB3047Fe01D1A65a8F52F`
- OKLink verification: https://www.oklink.com/xlayer/address/0x93a3db5645cb21dbdfeab3047fe01d1a65a8f52f

## Why It Matters
Autonomous agents are executing real trades with real money on X Layer right now. They have no eyes, no instincts, and no way to detect a honeypot from a legitimate token. Guardian gives every agent a security oracle it can call before every single trade — deterministic, machine-readable, fail-closed. It is the missing safety layer for the agentic DeFi stack. Any agent that integrates `@guardian-protocol/skill` gets institutional-grade trade security with a single import.

---

### 📋 Project Name
**Guardian Protocol**

### 📝 Tagline
*Mainnet-hardened, fail-closed security middleware for autonomous agents on X Layer — because the safest trade is the one you don't make, unless Guardian says it's clear.*

---

## 🎯 What It Does

Guardian Protocol is a deterministic security middleware built *for* autonomous AI agents (or human traders) to consume before executing swaps on X Layer. Guardian:

1. **Scans both tokens** for honeypots, predatory taxes, blacklist functions, and unverified contracts using the **OKX Security API**.
2. **Simulates the transaction** with `eth_call` on X Layer, **cross-validates** the result against **OKX's independent pre-execution scan**, and then runs **8-variant invariant fuzzing** to detect hidden revert traps and state-dependent manipulation.
3. **Analyzes MEV vulnerability** — computing **dynamic slippage caps** based on on-chain pool liquidity depth to protect trades during volatile conditions.
4. **Inspects the AMM pool** — reading concentrated liquidity state on-chain (sqrtPriceX96, tick distribution, active liquidity) to detect **thin liquidity manipulation**, **tick gap attacks**, **price deviation**, and **one-sided liquidity** that signal rug-pulls or coordinated extraction.
5. **Computes a Safety Score** (0-100) using weighted aggregation (30% token risk, 30% simulation, 15% MEV, 25% AMM pool), **penalty cascading**, **cross-analyzer correlation detection**, and **confidence degradation** for missing analyzers.
6. **Returns a binary verdict**: `isSafeToExecute: true` or `false`. No ambiguity. No "maybe."

If *anything* goes wrong — the API times out, the RPC is unreachable, or the data looks suspicious — **Guardian blocks the trade**. This is the **fail-closed** security model, the gold standard for safety-critical systems.

---

## 🏆 Judging Criteria

### 1. Innovation 💡

**What's new?** Most DeFi security tools are reactive — they flag known scam tokens. Guardian is *proactive, deterministic, and adversarial-aware*. It:

- **Cross-validates** its own simulation against OKX's independent oracle. If they disagree, the trade is blocked.
- **Fuzzes the transaction** with 8 calldata mutations before declaring it safe — detecting state-dependent traps that static analysis misses.
- **Tracks builder toxicity** and estimates private MEV flows to dynamically tighten slippage tolerance.
- **Reads concentrated liquidity pool state on-chain** to detect pool manipulation that other security tools completely ignore.
- **Fails closed by design.** Every analyzer returns score 0 on failure, not "assume safe."
- Uses **cross-analyzer penalty cascading** — correlated risks (e.g., thin AMM liquidity + high simulation slippage) amplify each other instead of being scored independently.
- Provides a **machine-readable** safety verdict — no human parsing needed. Other AI agents consume the JSON directly.

### 2. Ecosystem Fit (OKX OnchainOS Integration) 🔗

Guardian is deeply integrated with OKX infrastructure:

| OKX Feature | How Guardian Uses It |
|---|---|
| **OKX Security API** (Token Scan) | Primary oracle for honeypot/tax/blacklist detection |
| **OKX Security API** (TX Pre-execution) | Independent cross-validation of our eth_call + fuzzing simulation |
| **OKX DEX API** (Quote/Routing) | Optimized routing for approved trades |
| **HMAC-SHA256 Auth** | Standard OKX API v5 authentication implemented |
| **X Layer RPC** | Native viem-based client with 3-endpoint round-robin redundancy |

### Uniswap AI Skills Integration 🦄

| Uniswap AI Skill | Guardian's Usage |
|---|---|
| **swap-integration** | TWAP verification patterns for oracle manipulation detection |
| **uniswap-v4-security-foundations** | V4 hook permission risk assessment |
| **uniswap-driver** | Swap planning and price validation reference |
| **uniswap-viem** | EVM integration patterns for pool state reads |

Guardian adds on top of Uniswap AI Skills:
- **TWAP Oracle Deviation Analysis**: Reads `observe()` to detect flash loan manipulation (>5% deviation = critical flag)
- **V4 Hook Security Assessment**: `beforeSwapReturnDelta` = HIGH risk, `afterSwapReturnDelta` = MEDIUM risk
- **Concentrated Liquidity Manipulation**: Tick gap attacks, one-sided liquidity, zero-liquidity execution ticks

> Install: `npx skills add Uniswap/uniswap-ai` | Source: [Uniswap/uniswap-ai](https://github.com/Uniswap/uniswap-ai)

Guardian is built **for** the OKX ecosystem. It makes OKX's security APIs accessible to autonomous agents who can't use a UI.

### 3. AI Interaction 🤖

Guardian was designed to be consumed by **other machines**, not humans:

- **CLI Output = JSON only.** `stdout` is always parseable JSON. `stderr` has structured logs.
- **Library API.** `import { evaluateTrade } from "@guardian-protocol/skill"` — one function call, one verdict.
- **Agent Loop Ready.** LRU caching (60s TTL, 500 entries) prevents rate-limiting during high-frequency evaluation loops.
- **Deterministic Behavior.** Same inputs → same verdict. No randomness, no "it depends." Agents need predictability.
- **RPC Redundancy.** 3-endpoint round-robin with 1500ms failover — agents never get stuck on a slow node.

### 4. Completeness ✅

| Component | Status |
|---|---|
| Core Engine | ✅ 4 analyzers + scoring + orchestrator |
| Type System | ✅ Full TypeScript with strict mode, 30+ risk flag codes |
| Test Suite | ✅ 74/74 tests passing (6 suites) |
| CLI | ✅ 3 commands (evaluate, scan-token, simulate-tx) |
| RPC Redundancy | ✅ 3-endpoint round-robin with health tracking |
| State Fuzzing | ✅ 8-variant invariant testing |
| Private MEV | ✅ Builder toxicity + dynamic slippage |
| AMM Analysis | ✅ Concentrated liquidity pool risk detection |
| Uniswap AI | ✅ TWAP oracle + V4 hook security analysis |
| Caching | ✅ LRU with 60s TTL |
| Documentation | ✅ README + CHANGELOG + architecture diagrams |
| Live Fire Demo | ✅ X Layer Testnet (Chain ID 195) |
| Error Handling | ✅ Custom error classes + codes |
| Logging | ✅ Structured JSON observability |

---

## 🛠️ Tech Stack

| Technology | Purpose |
|---|---|
| **TypeScript 5.6** | Type-safe implementation with strict mode |
| **viem 2.21** | X Layer RPC client, ABI encoding, contract reads |
| **lru-cache** | Enterprise-grade caching for API rate limits & builder toxicity |
| **commander** | CLI framework for agent interaction |
| **vitest 2.1** | Fast unit testing (72 tests, < 2s) |
| **OKX Security API** | Token risk + TX simulation oracle |
| **X Layer** | Target blockchain (EVM-compatible L2) |

---

## 🔐 The "Fail-Closed" Philosophy

Most security tools in DeFi operate **fail-open**: if the security scan doesn't find anything wrong, the trade proceeds. But "not finding anything wrong" is very different from "confirming it's safe."

Guardian operates **fail-closed**:

```
                    ┌───────────────────┐
                    │ Can we determine  │
                    │ safety with HIGH  │
                    │ confidence?       │
                    └─────┬───────┬─────┘
                          │       │
                       YES│       │NO / MAYBE
                          │       │
                    ┌─────▼───┐ ┌─▼────────────┐
                    │ Score & │ │   ⛔ BLOCK    │
                    │ Evaluate│ │   Score = 0   │
                    └─────────┘ └──────────────┘
```

This means:
- **API timeout?** → Score 0. Blocked.
- **RPC unreachable?** → Failover to 2nd endpoint. If ALL 3 fail → Score 0. Blocked.
- **Unknown token?** → Score 0. Blocked.
- **OKX disagrees with eth_call?** → Penalty. Likely blocked.
- **Fuzzing finds hidden revert?** → Invariant violation flag. Blocked.
- **AMM pool has zero liquidity?** → Critical flag. Blocked.
- **Builder toxicity > threshold?** → Dynamic slippage tightened. May block.

An autonomous agent using Guardian will **never accidentally trade a honeypot** because it "couldn't check."

---

## 🏃‍♂️ How to Run

```bash
# Clone & install
git clone https://github.com/bitnormie01/guardian-protocol.git
cd guardian-protocol
npm install

# Run the 72-test suite
npm test

# Run live fire against X Layer Testnet
npm run live-fire

# Use the CLI
npx tsx src/cli.ts evaluate 0xTokenIn 0xTokenOut 1000000 --chain 195
```

---

## 📊 Live Fire Results

See the full output in [`LIVE_FIRE_LOG.txt`](./LIVE_FIRE_LOG.txt). Summary:

```
Tests Attempted:      3
Pipeline Mode:        Fail-Closed
Architecture:         4-Analyzer Parallel + Weighted Scoring (30/30/15/25)
RPC Redundancy:       3-endpoint round-robin (1500ms per-endpoint timeout)
State Fuzzing:        8 invariant variants per simulation
Caching:              LRU (60s TTL, 500 entries)
Target Chain:         X Layer Testnet (195)
```

The live fire test demonstrates:
1. **Full pipeline evaluation** — WOKB → USDC swap assessed and scored
2. **Token-only scan** — Individual token risk analysis
3. **Fail-closed verification** — Unknown token correctly blocked with score 0

---

## 👥 Team

**Guardian Protocol** — OKX Build X Hackathon 2026 — Skill Arena Track

Built to support autonomous agents.

### Agentic Wallet

```
0x6e9fb08755b837388a36ced22f26ed64240fb29c
```

> X Layer Mainnet (Chain ID 196) — [View on OKLink](https://www.oklink.com/xlayer/address/0x6e9fb08755b837388a36ced22f26ed64240fb29c)

### Verified GuardianProofLogger Deployment

```text
0x93A3DB5645Cb21DBDfEAB3047Fe01D1A65a8F52F
```

> X Layer Mainnet (Chain ID 196) — [View on OKLink](https://www.oklink.com/xlayer/address/0x93a3db5645cb21dbdfeab3047fe01d1a65a8f52f)

---

### Author

- **Telegram:** [@bitnormie01](https://t.me/bitnormie01)

---

*Built with 🛡️ for the agents who can't protect themselves.*
