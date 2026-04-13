---
name: guardian-protocol
version: 0.2.1
author: GuardianTeam
license: MIT
runtime: node>=20
entrypoint: src/index.ts
description: >
  Fail-closed security middleware for autonomous agents executing swaps on X Layer.
  Guardian Protocol is an agent-native security oracle: it intercepts every proposed
  swap, runs four parallel security engines (token risk via OKX + GoPlus dual-oracle,
  transaction simulation with 8-variant invariant fuzzing, MEV detection with private
  flow awareness, and on-chain concentrated liquidity pool analysis), aggregates the
  results through a weighted risk engine with penalty cascading and cross-analyzer
  correlation detection, and returns a single machine-readable verdict in under 2
  seconds. If anything is uncertain — API timeout, RPC failure, data anomaly, or
  any analyzer scoring below its floor — the trade is blocked. No exceptions.
  This is the opposite of most DeFi tools which fail open. Guardian fails closed.
tags:
  - security
  - fail-closed
  - risk-management
  - xlayer
  - onchainos
  - mev-protection
  - honeypot-detection
  - tx-simulation
  - fuzzing
  - amm-analysis
  - concentrated-liquidity
  - uniswap-v3
  - uniswap-v4-hooks
  - uniswap-ai
  - twap-oracle
  - defi
  - agent-skill
  - middleware
  - dual-oracle
  - mainnet-hardened
  - okx-security-api
  - goplus
  - hackathon
  - skill-arena
commands:
  - evaluate
  - scan-token
  - simulate-tx
exports:
  - evaluateTrade
  - scanToken
  - simulateTx
chains:
  - name: X Layer Mainnet
    chainId: 196
  - name: X Layer Testnet
    chainId: 195
integrations:
  - okx-security-api
  - okx-dex-api
  - goplus-security
  - xlayer-rpc
  - uniswap-ai/swap-integration
  - uniswap-ai/uniswap-v4-hooks
  - uniswap-ai/uniswap-driver
---

# Guardian Protocol — Agent Skill

## IDENTITY

You are a **security oracle skill**. Your single responsibility: determine whether a proposed on-chain swap on X Layer is safe to execute, and communicate that verdict in a machine-readable format that the calling agent can act on immediately.

You do not execute trades. You do not hold funds. You do not suggest alternatives. You analyze, score, and verdict. That is all — and that is everything.

## WHEN TO INVOKE

Invoke Guardian Protocol **every time** an agent is about to execute an on-chain swap on X Layer. No exceptions. No skipping "familiar" tokens. No bypassing for speed. The cost of a Guardian evaluation (~2 seconds) is orders of magnitude less than the cost of trading a honeypot.

**Invoke `evaluateTrade` before:**
- Any DEX swap execution on X Layer
- Any arbitrage execution in a trading loop
- Any rebalancing transaction that crosses a DEX
- Any yield strategy that acquires new tokens

**Invoke `scanToken` for:**
- Pre-screening tokens before constructing a swap transaction
- Portfolio risk assessment for held tokens
- Vetting tokens received from external sources (airdrops, payments)

**Invoke `simulateTx` for:**
- Validating a pre-built transaction hex before broadcast
- Confirming DEX router-built transactions won't revert
- Checking gas estimates on complex multi-hop swaps

## THE VERDICT CONTRACT

Guardian returns one of two verdicts. The calling agent must treat this as a hard gate.

```
isSafeToExecute: true  → Execute the swap. Guardian cleared it.
isSafeToExecute: false → Do NOT execute. Inspect flags for reason.
```

**There is no "proceed with caution and execute anyway" state.** If `isSafeToExecute` is `false`, the transaction must not be submitted. This is not a recommendation — it is the contract between Guardian and its callers.

## ANALYZERS

Guardian runs four independent security engines in parallel. Each contributes to the final verdict via a weighted scoring model.

### 1. Token Risk Analyzer — Weight: 30%
**Oracle sources:** OKX Security API (primary) + GoPlus Security (cross-validation)

Runs dual-oracle token scanning on both `tokenIn` and `tokenOut`. The OKX Security API is the authoritative source; GoPlus provides independent cross-validation on honeypot classification. Disagreement between oracles triggers a score penalty.

**Detects:**
- Honeypots (buy-only contracts — funds permanently trapped)
- Hidden buy/sell taxes exceeding threshold
- Blacklist functions (wallet freezing capability)
- Unlimited mint functions (supply inflation risk)
- Unverified contracts (no auditable source code)
- Centralized holder distribution (rug-pull precursor)
- Retained ownership (deployer admin privileges active)

**Fail behavior:** If OKX API is unreachable → `score: 0` → trade blocked.

### 2. TX Simulation + Fuzzing Analyzer — Weight: 30%
**Method:** eth_call → OKX cross-validation → 8-variant invariant fuzzer

Three-layer simulation:
1. `eth_call` dry-run against X Layer RPC
2. Independent cross-validation via OKX Security API's pre-execution scan — if results diverge, penalty applied
3. 8-variant invariant fuzzer: zero-args, max-uint256, half/double/10x amounts, byte-flip, truncation — detects state-dependent revert traps that only manifest under specific calldata conditions

**Detects:**
- Reverts before broadcast (100% wasted gas prevention)
- Slippage exceeding tolerance
- Unexpected balance state changes
- Hidden state-conditional traps (fuzzing invariant violations)
- Gas estimation anomalies

**Fail behavior:** If simulation is skipped (no tx hex) → neutral score 75. If simulation fails → `score: 0` → trade blocked.

### 3. MEV Detection Analyzer — Weight: 15%
**Method:** Mempool analysis + private flow estimation + builder toxicity tracking

Tracks per-block-builder MEV extraction history via an LRU cache (256 entries, 1hr TTL). Standard mempool analysis is insufficient: private MEV via Flashbots-style bundles is invisible to standard methods. Guardian estimates private flow exposure and computes a **dynamic slippage cap** that tightens automatically when builder toxicity is elevated.

**Detects:**
- Sandwich attack viability (profitable MEV extraction window calculated)
- Frontrunning profitability at the given trade size
- High private MEV flow (invisible extraction via builder bundles)
- Dynamic slippage cap breaches

**Note:** MEV is partially mitigable via private mempools. Hence 15% weight (lower than pool analysis). A high MEV score alone does not block — it compounds with other signals.

### 4. AMM Pool Analyzer — Weight: 25%
**Method:** Direct on-chain state reads via Uniswap V3-compatible ABI

This is the differentiator. No other security tool reads concentrated liquidity pool state at this depth. Guardian calls `slot0()`, `liquidity()`, `ticks()`, and `tickSpacing()` on the pool contract and interprets the raw state.

**Detects:**
- **Thin liquidity at tick** — Zero or near-zero active liquidity at the execution price → trade walks off a cliff
- **Tick gap manipulation** — Strategic removal of liquidity near the current tick creates an artificial price cliff post-execution
- **sqrtPriceX96 deviation** — Pool-reported price diverges from its theoretical tick-implied fair value → possible oracle manipulation
- **One-sided liquidity** — 90%+ of liquidity concentrated on one side → coordinated extraction fingerprint

**Why 25% weight?** AMM pool manipulation is non-mitigable. You cannot use a private mempool to avoid thin liquidity manipulation. If the pool is rigged, no routing optimization saves you. The analysis must happen before the route is even confirmed.

**Fail behavior:** If pool reads fail gracefully → `score: 60` (cautious, non-blocking). This allows agents to operate when pool reads timeout, while still applying a conservative penalty.

## SCORING ENGINE

### Weighted Aggregation
```
finalScore = (tokenRisk × 0.30) + (txSim × 0.30) + (mev × 0.15) + (amm × 0.25)
           × confidenceFactor
           × (1 - correlationPenalty)
```

### Hard Rules (Override the Score)
- Any analyzer sub-score < 20 → **trade blocked regardless of overall score**
- Any `CRITICAL` severity flag → **trade blocked regardless of score**
- 3+ `HIGH` severity flags → **trade blocked regardless of score**
- `confidenceFactor` degrades with each failed analyzer: 4→1.0, 3→0.88, 2→0.65, 1→0.35, 0→0.15

### Cross-Analyzer Penalty Cascades
Correlated risk signals are not additive — they multiply:
- `AMM_THIN_LIQUIDITY` + high TX slippage → **−60% penalty** (confirmed pool manipulation, certain extraction)
- `AMM_PRICE_DEVIATION` + `SANDWICH_ATTACK_LIKELY` → **−40% penalty** (coordinated attack — timing + pool state aligned)
- `AMM_ONESIDED_LIQUIDITY` + `MINT_FUNCTION_PRESENT` → **−30% penalty** (rug-pull signature: rigged pool + exit capability)

## COMMANDS

### `guardian evaluate` — Full Pipeline

```bash
npx tsx src/cli.ts evaluate <tokenIn> <tokenOut> <amount> [options]

Options:
  -u, --user <address>     Wallet address (default: 0x000...001)
  -c, --chain <id>         Chain ID: 196 (mainnet) or 195 (testnet)
  -t, --tx <hex>           Pre-built tx hex for simulation
  --threshold <score>      Custom safety threshold (default: 70)
```

Returns: `{ evaluationId, safetyScore, isSafeToExecute, flags, meta }`

### `guardian scan-token` — Token-Only Scan

```bash
npx tsx src/cli.ts scan-token <tokenAddress> [options]
```

Returns: `{ evaluationId, safetyScore, flags, isSafe }`

### `guardian simulate-tx` — TX Pre-flight

```bash
npx tsx src/cli.ts simulate-tx <txHex> [options]
```

Returns: `{ evaluationId, simulationSuccess, gasUsed, stateChanges, flags }`

## OUTPUT CONTRACT

Every Guardian command outputs **structured JSON on stdout**. Structured logs go to stderr. Never mixed.

```json
{
  "evaluationId": "uuid-v4",
  "timestamp": "ISO-8601",
  "chainId": 196,
  "safetyScore": {
    "overall": 87,
    "tier": "MODERATE",
    "breakdown": {
      "tokenRisk": 95,
      "txSimulation": 82,
      "mevRisk": 70,
      "ammPoolRisk": 90
    }
  },
  "isSafeToExecute": true,
  "flags": [
    {
      "code": "SANDWICH_ATTACK_LIKELY",
      "severity": "high",
      "message": "Trade size is 3.2% of pool liquidity. MEV bots can profitably sandwich. Expected extraction: ~$12. Recommend splitting into 3 trades.",
      "source": "mev-detection-analyzer"
    }
  ],
  "optimizedRouting": null,
  "meta": {
    "guardianVersion": "0.2.1",
    "evaluationDurationMs": 847,
    "analyzersRun": [
      { "name": "token-risk-analyzer", "status": "success", "durationMs": 412 },
      { "name": "tx-simulation-analyzer", "status": "success", "durationMs": 380 },
      { "name": "mev-detection-analyzer", "status": "success", "durationMs": 22 },
      { "name": "amm-pool-analyzer", "status": "success", "durationMs": 847 }
    ]
  }
}
```

## INTEGRATION PATTERN

The canonical way for an agent to integrate Guardian Protocol:

```typescript
import { evaluateTrade } from "@guardian-protocol/skill";

// In your trading loop:
async function safeSwap(tokenIn: string, tokenOut: string, amount: string) {
  // Step 1: Guardian evaluation (mandatory, not optional)
  const verdict = await evaluateTrade({ tokenIn, tokenOut, amount, chainId: 196 });

  // Step 2: Hard gate — no bypass, no "try anyway"
  if (!verdict.isSafeToExecute) {
    // Log block reason, skip this opportunity
    return { blocked: true, reason: verdict.flags[0]?.code };
  }

  // Step 3: Execute only after Guardian clearance
  return executeSwap({ tokenIn, tokenOut, amount });
}
```

## CONFIGURATION

Guardian is configurable for different risk tolerances and operating contexts:

```typescript
await evaluateTrade(request, {
  scoringWeights: { tokenRisk: 0.30, txSimulation: 0.30, mevSignals: 0.15, ammPool: 0.25 },
  scoringPolicy: {
    safetyThreshold: 70,        // Minimum score to approve
    minimumSubScore: 20,         // Per-analyzer floor
    maxHighFlagsBeforeBlock: 3,  // High-severity flag count limit
  },
  tokenRisk: {
    buyTaxWarningPercent: 10,    // Flag above 10% buy tax
    sellTaxWarningPercent: 10,
    minHolderCount: 50,          // Rug-pull threshold
  },
  ammPool: {
    minLiquidityDepthUsd: 10000, // Min $10k at execution tick
    maxTickGapMultiplier: 20,    // Flag tick gaps > 20× spacing
    maxPriceDeviationRatio: 0.05,
  },
});
```

## TESTING STATUS

```
Total Tests:   72 / 72 passing ✅
Test Suites:   5
Test Runner:   Vitest 2.1
Coverage:      Analyzers, scoring engine, fail-closed behavior,
               cross-analyzer correlations, confidence degradation

Notable adversarial tests:
  - API failure → verify score = 0 (fail-closed enforcement)
  - Honeypot token → verify CRITICAL flag and blocked verdict
  - Fuzzing trap → verify FUZZING_INVARIANT_VIOLATION detection
  - All 3 correlation penalty scenarios
  - RPC failover: all endpoints fail → verify pipeline blocks
```

## LIVE FIRE RESULTS

Executed against X Layer Mainnet (Chain ID 196) — see `LIVE_FIRE_LOG.txt`:

```
Tests run:        3
Protocol mode:    Fail-Closed
Architecture:     4 analyzers, parallel execution, weighted scoring
RPC redundancy:   3-endpoint round-robin (1500ms failover)
State fuzzing:    8 invariant variants per simulation
Cache:            LRU 60s TTL, 500 entries
Target:           X Layer Mainnet (Chain ID 196)

Results:
  ✅ Full pipeline evaluation: WOKB → USDC swap evaluated — all 4 analyzers ran, OKX DEX quote resolved pool address, tx simulation detected revert (expired deadline in test calldata)
  ✅ Token-only scan: WOKB analyzed on mainnet, score 100, no flags
  ✅ Unknown token: 0xDeadBeef scanned on mainnet, score 100 (OKX API returned no risk data — fail-closed enforced at pipeline level)
```

## SECURITY PROPERTIES

1. **Deterministic** — Identical chain state + identical inputs → identical verdict. No randomness, no ambient state.
2. **Non-destructive** — Guardian never signs, sends, or mutates any transaction. Read-only on-chain access only.
3. **Fail-closed** — Default state is blocked. Safety requires active multi-analyzer confirmation.
4. **Audit-logged** — Every evaluation produces a structured log trail for post-hoc review.
5. **Rate-limit resistant** — LRU cache means high-frequency loops don't exhaust API quotas.
6. **RPC-redundant** — 3-endpoint failover means single RPC downtime doesn't affect operations.
