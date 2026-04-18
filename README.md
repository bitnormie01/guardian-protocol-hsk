# Guardian Protocol

[![Built for HashKey Chain Horizon Hackathon — AI Track](https://img.shields.io/badge/HashKey_Horizon-AI_Track-FF6B35?style=for-the-badge)](https://dorahacks.io)
[![HashKey Chain](https://img.shields.io/badge/HashKey_Chain-177_Mainnet-0EA5E9?style=for-the-badge)](https://hashkey.blockscout.com)
[![HashKey Testnet](https://img.shields.io/badge/HashKey_Testnet-133-14B8A6?style=for-the-badge)](https://testnet-explorer.hsk.xyz)
[![Tests](https://img.shields.io/badge/Tests-76%2F76_Passing-22C55E?style=for-the-badge)](#test-status)

> **Fail-closed AI security reasoning layer that blocks dangerous trades before autonomous agents execute them on HashKey Chain.**

Guardian Protocol is a pre-execution security middleware for autonomous AI agents on HashKey Chain. It evaluates every swap before execution and returns a single machine-readable verdict backed by four analyzers running in parallel:

| Analyzer | What It Does |
|---|---|
| **Token Risk** | Dual-oracle GoPlus assessment — honeypot, tax, blacklist, mint, ownership |
| **TX Simulation** | eth_call with dual-RPC cross-validation — revert detection, slippage |
| **MEV Detection** | Dynamic slippage capping based on trade size and volatility heuristics |
| **AMM Pool Health** | Concentrated liquidity tick scanning — thin liquidity, tick gaps, price deviation |

**The fail-closed model is the differentiator.** If any analyzer cannot complete — API timeout, RPC failure, unknown contract — the verdict is **BLOCK**. Guardian does not warn. It blocks.

Built for **HashKey Chain Horizon Hackathon — AI Track**.

---

## Why This Exists

Autonomous AI agents are starting to execute on-chain transactions without human review. A trading bot that can swap tokens in milliseconds will not pause to read a warning banner. Existing security tools are built for humans: they surface risk indicators and expect someone to make a judgment call. Agents don't make judgment calls. They execute. Guardian Protocol closes that gap by returning a structured verdict before the trade executes. Four analyzers run in parallel — token risk, transaction simulation, MEV exposure, AMM pool health — and produce a weighted score. If the score is below threshold, or any analyzer cannot complete, the verdict is BLOCK. No "proceed at your own risk" path. This fail-closed design fits HashKey Chain specifically because it is a compliance-native network where auditability and fail-safe behavior are requirements, not nice-to-haves.

## Live Fire Evidence

```
╔═══════════════════════════════════════════════════════════════════════╗
║   🛡️  GUARDIAN PROTOCOL — LIVE FIRE TEST                              ║
║   Target:  HashKey Chain Mainnet (Chain ID 177)                       ║
║   Engine:  4-Analyzer Parallel Architecture                           ║
║   Mode:    Fail-Closed Security Middleware                            ║
║   HashKey Hackathon Submission                                        ║
╚═══════════════════════════════════════════════════════════════════════╝

🟢 Small trade    WHSK → USDT (0.01 WHSK)        → APPROVED (score 72, 4 flags)
🔴 Large trade    WHSK → USDT (10,000 WHSK)      → BLOCKED  (score 36, 4 flags)
🔴 Unknown token  0x000...dEaD                    → BLOCKED  (score 0, fail-closed)
🔴 RPC failure    All endpoints unreachable       → BLOCKED  (score 14, fail-closed)
🔴 Oracle failure GoPlus API unreachable          → BLOCKED  (score 14, fail-closed)
```

Raw CLI captures and on-chain proof details for each scenario are in [`demo-evidence/`](./demo-evidence/).

---

## Live Deployment

### HashKey Chain Mainnet (177)

| Contract | Address |
|---|---|
| V3 Factory | [`0xD136e36610f35E0Cc3cAd40de858c151f2AA65D4`](https://hashkey.blockscout.com/address/0xD136e36610f35E0Cc3cAd40de858c151f2AA65D4) |
| Swap Router | [`0x1f3858C46F8F6fE76260b8208995D228C5cddc64`](https://hashkey.blockscout.com/address/0x1f3858C46F8F6fE76260b8208995D228C5cddc64) |
| WHSK/USDT Pool | [`0xEB33d6666dd2359cB1BF6Ea6D72286Cc1b4a778A`](https://hashkey.blockscout.com/address/0xEB33d6666dd2359cB1BF6Ea6D72286Cc1b4a778A) |
| WHSK Token | `0xB210D2120d57b758EE163cFfb43e73728c471Cf1` |
| USDT Token | `0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029` |

### HashKey Chain Testnet (133)

| Contract | Address |
|---|---|
| **GuardianProofLogger** | [`0x7384cbB4dC7dE54d49DdA4E44731003413D17D7F`](https://testnet-explorer.hsk.xyz/address/0x7384cbB4dC7dE54d49DdA4E44731003413D17D7F) |
| Deployer Wallet | [`0x2B6E71C59f571969Ae9C32373aa4Ce48054cbF27`](https://testnet-explorer.hsk.xyz/address/0x2B6E71C59f571969Ae9C32373aa4Ce48054cbF27) |
| Deploy TX | `0xb078d8c9e7600388c8177e3618a118749b112ffda1cdc22ea2d3899001847f18` |

**On-chain proof transactions:**
- Phase 4 BLOCK verdict (fresh): [`0x16eaf37129bb35a1dc90e62a8f05e03c490f2f44b789df719327d791a03cb26a`](https://testnet-explorer.hsk.xyz/tx/0x16eaf37129bb35a1dc90e62a8f05e03c490f2f44b789df719327d791a03cb26a)
- Blocked verdict: [`0x75a2f3911b9cde279d603497b1c1d3c6a35aee4a6da668fccd7f5a77fdac8799`](https://testnet-explorer.hsk.xyz/tx/0x75a2f3911b9cde279d603497b1c1d3c6a35aee4a6da668fccd7f5a77fdac8799)
- Approved verdict: [`0x2b136c8e111909ce3ed1f0efacaf58e7569c7a871e9de178883b3d844d31b225`](https://testnet-explorer.hsk.xyz/tx/0x2b136c8e111909ce3ed1f0efacaf58e7569c7a871e9de178883b3d844d31b225)

---

## Quick Start

**Requirements:**
- Node.js ≥ 20.0.0

```bash
npm install
cp .env.example .env
npm test          # 76/76 tests
npm run live-fire # End-to-end evaluation against HashKey Chain testnet (chain 133)
```

## CLI Usage

```bash
# Full swap evaluation — 4 analyzers in parallel
npx tsx src/cli.ts evaluate \
  0xB210D2120d57b758EE163cFfb43e73728c471Cf1 \
  0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029 \
  10000000000000000 \
  --chain 177 \
  --user 0xYourWalletAddress  # optional — defaults to 0x0...001; enables wallet-risk analysis when provided

# Token-only risk scan
npx tsx src/cli.ts scan-token \
  0xB210D2120d57b758EE163cFfb43e73728c471Cf1 \
  --chain 177

# Transaction pre-flight simulation
npx tsx src/cli.ts simulate-tx \
  0x095ea7b30000000000000000000000006b3... \
  --user 0xYourWalletAddress \
  --chain 177
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `HASHKEY_RPC_URL` | Yes | Primary HashKey Chain RPC (`https://mainnet.hsk.xyz`) |
| `HASHKEY_RPC_URL_2` | No | Secondary RPC for cross-validation (`https://hashkey.drpc.org`) |
| `HASHKEY_RPC_URL_3` | No | Tertiary RPC failover (`https://rpc.hashkeychain.com`) |
| `GOPLUS_API_KEY` | No | Optional GoPlus API key for higher rate limits |
| `DEPLOYER_KEY` | Deploy only | Private key for testnet contract deployment |
| `GUARDIAN_SAFETY_THRESHOLD` | No | Minimum score to approve (default: 70) |
| `GUARDIAN_MAX_SLIPPAGE_BPS` | No | Max acceptable slippage in basis points (default: 500) |
| `GUARDIAN_TX_SIMULATION_TIMEOUT_MS` | No | Simulation timeout in ms (default: 10000) |
| `GUARDIAN_RPC_ENDPOINT_TIMEOUT_MS`  | No | Per-endpoint timeout in ms (default: 5000; enforced floor of 5000ms) |

## Architecture

```
Agent Intent → Guardian Protocol → Verdict (execute/block)
                    │
                    ├── Token Risk Analyzer (GoPlus dual-oracle)
                    ├── TX Simulation Analyzer (dual-RPC eth_call)
                    ├── MEV Detection Analyzer (dynamic slippage cap)
                    └── AMM Pool Analyzer (V3 tick scanning)
                    │
                    └── Weighted Scoring Engine → JSON Verdict
                         │
                         └── GuardianProofLogger (on-chain audit trail)
```

## Risk Flag Codes

Guardian defines **30 discrete risk flag codes** across 5 categories:

| Category | Flags |
|---|---|
| Token Risk | `HONEYPOT_DETECTED`, `MINT_FUNCTION_PRESENT`, `HIGH_TAX_TOKEN`, `BLACKLIST_FUNCTION`, `OWNERSHIP_NOT_RENOUNCED`, `PROXY_CONTRACT_UPGRADEABLE`, `UNVERIFIED_CONTRACT`, `LOW_HOLDER_COUNT`, `API_UNAVAILABLE`, `TOKEN_NOT_FOUND`, `ANALYZER_ERROR`, `ROUTE_UNAVAILABLE` |
| Liquidity | `LOW_LIQUIDITY_DEPTH`, `SINGLE_POOL_DEPENDENCY`, `LIQUIDITY_LOCKED_EXPIRED`, `HIGH_PRICE_IMPACT` |
| TX/MEV | `TX_SIMULATION_REVERTED`, `SANDWICH_ATTACK_LIKELY`, `FRONTRUN_RISK_HIGH`, `UNEXPECTED_STATE_CHANGE`, `GAS_ESTIMATION_FAILED`, `FUZZING_INVARIANT_VIOLATION` |
| AMM Pool | `AMM_THIN_LIQUIDITY`, `AMM_TICK_GAP_MANIPULATION`, `AMM_PRICE_DEVIATION`, `AMM_ONESIDED_LIQUIDITY`, `AMM_READ_FAILED` |
| Wallet/MEV | `PRIVATE_MEV_FLOW_HIGH`, `EXCESSIVE_TOKEN_APPROVALS`, `APPROVAL_TO_KNOWN_PHISHER`, `WALLET_RECENTLY_DRAINED` |

Each flag includes a severity tier (`critical`/`high`/`medium`/`low`/`info`) and a natural language explanation for AI agent reasoning.

## Proof Logger

Deploy the GuardianProofLogger to HashKey Chain testnet:

```bash
npx tsx scripts/deploy-proof-contract.ts
```

Log a verdict on-chain:

```bash
npx tsx scripts/log-proof.ts \
  --contract 0x7384cbB4dC7dE54d49DdA4E44731003413D17D7F \
  --evaluation-id eval-001 \
  --score 92 \
  --safe true \
  --chain 133
```

The contract stores `evaluationId`, `verdict`, `score`, and `timestamp` immutably. Exposes owner-only `logEvaluation(bytes32,bool,uint256)` and public `getEvaluation(bytes32)`.

## Test Status

```
 ✓ tests/unit/analyzers/amm-pool-analyzer.test.ts    (13 tests)
 ✓ tests/unit/analyzers/mev-detection.test.ts        (12 tests)
 ✓ tests/unit/analyzers/token-risk.test.ts           (9 tests)
 ✓ tests/unit/analyzers/tx-simulation.test.ts        (13 tests)
 ✓ tests/unit/scoring/risk-engine.test.ts            (27 tests)
 ✓ tests/unit/services/trade-context.test.ts         (2 tests)

 Test Files  6 passed (6)
      Tests  76 passed (76)
```

## License

MIT
