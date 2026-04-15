# DoraHacks BUIDL Submission — Guardian Protocol

> Paste-ready. No placeholders. Copy each section into the DoraHacks form.

---

## 1. PROJECT NAME

```
Guardian Protocol
```

---

## 2. ONE-LINE TAGLINE

```
Fail-closed AI security oracle that blocks unsafe trades before an autonomous agent executes them on HashKey Chain.
```

*(110 characters)*

---

## 3. FULL PROJECT DESCRIPTION

Autonomous AI agents are coming to DeFi — and they trade blind. Today's compliance infrastructure stops at the gateway: KYC verifies _who_ enters the chain, but nothing verifies _what_ they execute once inside. Every swap is a new attack surface. Honeypot tokens with hidden sell taxes. MEV sandwich attacks that extract value between blocks. Unverified contracts masquerading as legitimate liquidity pools. Thin-liquidity AMM positions designed to maximize price impact on naive order flow. These aren't theoretical risks — they are the daily operating environment of on-chain DeFi. When an AI agent autonomously executes a trade with no pre-execution safety layer, the agent's wallet is the victim, and the chain's reputation is the collateral damage.

Guardian Protocol is a deterministic security middleware that intercepts every proposed trade _before_ execution on HashKey Chain, runs four parallel security analyzers in under two seconds, and returns a single machine-readable verdict: execute or block. The four engines work simultaneously. The **Token Risk Analyzer** queries GoPlus Security as a dual-oracle, checking both input and output tokens for honeypot behavior, hidden ownership functions, predatory buy/sell taxes, blacklist mechanisms, and holder concentration anomalies. The **TX Simulation Analyzer** executes the exact proposed transaction via `eth_call` against a pinned block, then runs an 8-variant invariant fuzzer that mutates gas limits, value parameters, and call ordering to detect state-dependent revert traps that a single simulation would miss — all cross-validated across multiple RPC endpoints. The **AMM Pool Analyzer** reads Uniswap V3 pool state directly from on-chain contracts — `slot0` for current price, `liquidity` for depth, and TWAP oracle observations for manipulation detection — then models the real price impact of the proposed trade size against the pool's concentrated liquidity distribution. The **MEV Detection Engine** scores builder toxicity patterns, identifies sandwich attack setups in recent blocks, and enforces dynamic slippage caps calibrated to the pool's actual tick depth. The output is a structured JSON verdict: `isSafeToExecute` (boolean), `overallScore` (0–100), a `tier` classification (SAFE / CAUTION / DANGEROUS / CRITICAL), and an array of 30+ typed `RiskFlagCode` entries, each with severity level, confidence score, and a natural-language explanation. This output format is designed for machine consumption — an LLM-based trading agent can parse the flags, reason about the risk profile, and decide whether to proceed, adjust parameters, or abort.

Guardian Protocol is purpose-built for HashKey Chain because HashKey Chain is purpose-built for compliance. As the first SFC-licensed blockchain infrastructure, HashKey Chain has already established that institutional-grade trust begins at the infrastructure layer. Guardian extends that promise from the onboarding layer to the execution layer. Compliance doesn't end at KYC — it must extend to every swap, every block, every agent action. We are the only submission that defaults to blocking, not warning. Guardian is **fail-closed by design**: if any analyzer fails, if any data source is unavailable, if any result is ambiguous, the trade is blocked. Score zero. Verdict: do not execute. This is not a bug — it is the fundamental architectural decision that makes Guardian safe for institutional deployment and autonomous agent integration. In the live-fire test on HashKey Chain testnet, our `GuardianProofLogger` smart contract permanently recorded three evaluation verdicts on-chain — all three scored zero, all three blocked, because that is the correct response when security data is incomplete. The system worked exactly as designed.

The protocol is production-tested: 76 unit tests passing across all four analyzers, the scoring engine, and the trade context resolver. The RPC layer uses a 3-endpoint round-robin manager with 500ms per-endpoint failover and adaptive health scoring. The `GuardianProofLogger` contract is deployed at `0x33C38701715be74327B1Bc6EDf9Da81Bfb6800A8` on HashKey Chain testnet, with three `EvaluationLogged` events permanently anchored on-chain. End-to-end evaluation latency is under two seconds. The entire codebase is TypeScript, runs on any Node.js 20+ environment, and exposes a clean CLI and REST API for integration by agent frameworks, trading bots, and institutional middleware stacks.

Guardian Protocol is not a dashboard for humans. It is the reasoning layer between an AI agent's _intent_ and its _execution_. The structured 30+ flag taxonomy with severity levels and natural-language explanations is designed to be consumed by an LLM agent that needs to understand _why_ a trade is dangerous — not just _that_ it is dangerous. This is AI infrastructure: the security oracle that makes autonomous DeFi safe on HashKey Chain.

*(587 words)*

---

## 4. TRACK SELECTION

**AI Track**

Guardian Protocol belongs in the AI Track because its entire output interface is designed for machine consumption, not human dashboards. The structured JSON verdict — with 30+ typed `RiskFlagCode` entries, severity levels, confidence scores, and natural-language explanations — is purpose-built for LLM-based trading agents that need to reason about trade safety before autonomous execution. Guardian is not a tool for humans; it is security infrastructure that other AI agents integrate as their pre-execution reasoning layer, making it a foundational component of the autonomous agent stack on HashKey Chain.

---

## 5. TECH STACK

- **TypeScript** — Core runtime, CLI, and REST API
- **Viem** — HashKey Chain RPC interaction, contract reads, transaction simulation
- **GoPlus Security API** — Dual-oracle token risk analysis (honeypot, tax, blacklist, ownership)
- **HashKey Chain RPC** — 3-endpoint round-robin with 500ms per-endpoint failover and adaptive health scoring
- **Uniswap V3 ABI** — Direct on-chain reads: `slot0`, `liquidity`, `observe` (TWAP oracle)
- **8-Variant Invariant Fuzzer** — Mutations on gas, value, and call ordering to detect state-dependent revert traps
- **LRU Cache** — 60-second TTL, 500-entry capacity for token risk and pool state
- **Vitest** — 76 unit tests across all analyzers, scoring engine, and trade context
- **Foundry** — Smart contract compilation and deployment (`forge create`)
- **Solidity ^0.8.24** — `GuardianProofLogger` on-chain proof contract + `MockERC20` test tokens

---

## 6. LINKS

| Resource | URL |
|---|---|
| **GitHub Repository** | https://github.com/ArtificialSapien/Guardian-Protocol |
| **Deployed Contract** (Testnet) | https://testnet.hashkeyscan.io/address/0x33C38701715be74327B1Bc6EDf9Da81Bfb6800A8 |
| **Deployment TX** | https://testnet.hashkeyscan.io/tx/0xc14ca6e2ae0531b84b55d3901baec6cd58248c379ad4b47f63d394fdd42417b7 |
| **Proof TX #1** | https://testnet.hashkeyscan.io/tx/0x74a05cf4fffe407f1a0f20bb4afc0a5af98d9e82da1d80b409765cdf993732ca |
| **Proof TX #2** | https://testnet.hashkeyscan.io/tx/0x547fffbf06786d1eda3e8061d041f9b200b93662bf65f2facecb49a491025ffa |
| **Proof TX #3** | https://testnet.hashkeyscan.io/tx/0xce9f20b40c4ac141a53f1333e6d627e9751cb8e2b8ce2fb65054911a9ff7ed20 |

---

## 7. DEMO VIDEO SCRIPT (3:00)

### 0:00 – 0:30 — The Problem

> *[Screen: dark terminal, Guardian Protocol ASCII banner fades in]*
>
> "AI agents are trading autonomously on-chain. But there is no pre-execution safety layer. No oracle that tells an agent: this token is a honeypot. This pool will sandwich you. This swap will revert and waste your gas."
>
> "Today, agents trade blind. On a compliance-first chain like HashKey Chain, that's not acceptable."
>
> "Guardian Protocol fixes that."

### 0:30 – 1:15 — Live CLI Demo

> *[Screen: terminal running `npx tsx scripts/live-fire.ts`]*
>
> "Let me show you. I'm running Guardian Protocol's live-fire test against HashKey Chain testnet right now."
>
> *[Show the banner: Chain ID 133, Proof Logger address, 4-Analyzer architecture]*
>
> "Three tests are running in parallel. Each one hits the full pipeline — Token Risk, TX Simulation, AMM Pool Analysis, and MEV Detection. All four analyzers execute simultaneously and return a single verdict."
>
> *[JSON output scrolls: `evaluationId`, `safetyScore`, `flags` array]*
>
> "Look at the output. This is structured JSON — not a dashboard for humans. It's a machine-readable verdict designed for an AI agent to parse and act on."

### 1:15 – 1:45 — Fail-Closed Verdict

> *[Zoom in on JSON result]*
>
> "Score: zero. Tier: CRITICAL. `isSafeToExecute`: false. The agent is blocked from executing this trade."
>
> "This is not a failure. This is the system working exactly as designed. GoPlus has no indexed data for custom testnet tokens — and when Guardian doesn't have complete security data, it defaults to blocking. Not warning. Blocking."
>
> "We are fail-closed by default. Every other security tool warns you. Guardian stops you."

### 1:45 – 2:15 — On-Chain Proof

> *[Screen: HashKey Chain testnet explorer]*
>
> "Every evaluation verdict is permanently logged on-chain. Here's our `GuardianProofLogger` contract at `0x33C387...` on HashKey Chain testnet."
>
> *[Click through EvaluationLogged events]*
>
> "Three evaluations. Three on-chain records. Immutable proof that Guardian analyzed these trades and blocked them. This is auditable compliance at the execution layer."

### 2:15 – 2:45 — Test Suite

> *[Screen: terminal running `npm test`]*
>
> "76 tests. Zero failures. Every analyzer, the scoring engine, the trade context resolver — all covered."
>
> *[Show: `Test Files 6 passed (6) / Tests 76 passed (76)` in ~1 second]*
>
> "Sub-one-second test suite. Sub-two-second evaluation latency. This is production infrastructure, not a prototype."

### 2:45 – 3:00 — Closing

> *[Screen: Guardian Protocol logo + HashKey Chain badge]*
>
> "Compliance doesn't end at KYC. It extends to every execution."
>
> "Guardian Protocol. Fail-closed by default. Built for HashKey Chain."
>
> *[Screen: contract address + explorer link + GitHub URL]*
