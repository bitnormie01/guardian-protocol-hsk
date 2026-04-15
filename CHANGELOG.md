# Changelog

All notable changes to Guardian Protocol are documented in this file.

## [0.2.1] — 2026-04-09 — Security Hardening

### 🔒 Security
- **CLI threshold bypass blocked** — `--threshold` now enforces minimum of 20; values below 20 are rejected with a structured JSON error. Prevents agents from bypassing Guardian's minimum security invariants
- **Comprehensive input validation** added to all 3 CLI commands: address format (EVM 0x-prefixed), amount must be positive non-zero, tokenIn ≠ tokenOut, chainId must be 133 or 177, txHex must be 0x-prefixed hex
- **Minimum threshold floor** cannot be bypassed via CLI flags; requires explicit env var override

### 🔧 Fixed
- **GoPlus API v5→v6 type migration** — updated `GoPlusTokenSecurityData` to include granular fields (`isHoneypot`, `hasBlacklist`, `isMintable`, `isOpenSource`, `isProxy`, `holderCount`, `ownerAddress`). These can now be detected directly without GoPlus fallback
- **72/72 test suite restored** from 59/72 — token-risk and tx-simulation fixtures rebuilt for GoPlus v6 schema (`action`/`riskItemDetail` instead of v5 `riskLevel`/`balanceChanges`)
- **Slippage detection restored** — now reads eth_call `returnData` directly since GoPlus v6 no longer provides balance changes
- **Version sync** — CLI now reports `0.2.0` (was incorrectly reporting `0.1.0`)

---

## [0.2.0] — 2026-04-09 — Phase 2: Mainnet Hardening

### 🆕 Added

#### AMM Pool Analyzer (`src/analyzers/amm-pool-analyzer.ts`)
- New 4th parallel analyzer for concentrated liquidity pool risk detection
- Reads on-chain pool state via Uniswap V3-compatible ABI (slot0, liquidity, ticks, tickSpacing)
- Detects **thin liquidity** at the current tick (zero or insufficient depth)
- Detects **tick gap manipulation** (artificial gaps between initialized ticks)
- Detects **sqrtPriceX96 deviation** from theoretical tick-derived fair value
- Detects **one-sided liquidity** (asymmetric distribution above/below current price)
- Configurable thresholds: `minLiquidityDepthUsd`, `maxTickGapMultiplier`, `maxPriceDeviationRatio`, `liquidityAsymmetryThreshold`
- Graceful degradation: failure returns score 60 (cautious, non-blocking)

#### RPC Redundancy (`src/services/hashkey-chain-rpc-client.ts`)
- `RoundRobinRPCManager` class with 3+ endpoint support
- **1500ms per-endpoint timeout** — HashKey Chain RPC latency can exceed 500ms under load; 1500ms gives 4.5s worst-case across 3 endpoints while staying within the 10s simulation budget
- Health-based smart rotation: healthy endpoints tried first
- Per-endpoint failure tracking with automatic demotion
- Only throws if ALL endpoints fail (~4.5s worst-case)
- New generic `readContract()` method for arbitrary on-chain reads
- Configurable via `HASHKEY_RPC_URL`, `HASHKEY_RPC_URL_2`, `HASHKEY_RPC_URL_3`
- Configurable at runtime via `GUARDIAN_RPC_ENDPOINT_TIMEOUT_MS` env var

#### TX Simulation Fuzzing (`src/analyzers/tx-simulation.ts`)
- 8-variant invariant fuzzing engine runs after primary `eth_call` succeeds
- Mutation strategies: zero-args, max-uint256, half/double/10x amounts, byte-flip, truncation
- Detects hidden reverts (state-dependent traps)
- Detects output non-linearity (non-proportional outputs for proportional inputs)
- New `FUZZING_INVARIANT_VIOLATION` risk flag code
- Configurable fuzz iterations, timeout, and deviation thresholds

#### MEV Detection Upgrades (`src/analyzers/mev-detection.ts`)
- `BlockBuilderToxicityTracker` — LRU-cached (256 entries, 1hr TTL) per-builder MEV extraction tracking
- `PrivateFlowEstimator` — estimates invisible MEV via private bundle flows
- `computeDynamicSlippageCap()` — tightens slippage based on volatility, builder toxicity, and private flow
- New `PRIVATE_MEV_FLOW_HIGH` risk flag code
- New report fields: `dynamicSlippageCap`, `builderToxicity`, `privateFlowEstimate`

#### Risk Engine Rebalancing (`src/scoring/risk-engine.ts`)
- 4-analyzer weight distribution: Token Risk (30%), TX Simulation (30%), MEV (15%), AMM Pool (25%)
- 3 new cross-analyzer correlations:
  - AMM thin liquidity + simulation slippage → confirmed manipulation (0.60 penalty)
  - AMM price deviation + MEV sandwich → coordinated attack (0.40 penalty)
  - AMM one-sided liquidity + mintable token → rug-pull signal (0.30 penalty)
- Confidence degradation updated for 4 analyzers (0/1/2/3/4 failures)
- `ammPoolRisk` added to `SafetyScore.breakdown`

#### New Risk Flag Codes (`src/types/output.ts`)
- `FUZZING_INVARIANT_VIOLATION` — Invariant test failure during state fuzzing
- `AMM_THIN_LIQUIDITY` — Insufficient liquidity at current tick
- `AMM_TICK_GAP_MANIPULATION` — Artificial gaps between initialized ticks
- `AMM_PRICE_DEVIATION` — sqrtPriceX96 deviates from theoretical price
- `AMM_ONESIDED_LIQUIDITY` — Asymmetric liquidity distribution
- `PRIVATE_MEV_FLOW_HIGH` — High estimated private MEV flow

#### Tests
- New `amm-pool-analyzer.test.ts` (13 tests)
- Updated `risk-engine.test.ts` (27 tests, up from 18)
- Updated `mev-detection.test.ts` (10 tests, Phase 2 assertions)
- Total: **72 tests across 5 suites** (up from 50 tests across 4 suites)

### 🔧 Changed
- `ScoringWeights` now includes `ammPool` field
- `DEFAULT_WEIGHTS` rebalanced from 40/40/20 to 30/30/15/25
- `ScoringPolicy.minimumSubScore` now checked for 4 analyzers
- `thresholds.ts` includes `ammPool` configuration section
- Orchestrator (`index.ts`) runs 4 analyzers in `Promise.all`
- Package version bumped to `0.2.0`

---

## [0.1.0] — 2026-04-08 — Phase 1: Initial Release

### Added
- Token Risk Analyzer — GoPlus Security API integration
- TX Simulation Analyzer — eth_call simulation + GoPlus cross-validation
- MEV Detection Analyzer — sandwich risk + volatility + liquidity
- Risk Scoring Engine — weighted aggregation + penalty cascade
- CLI — 3 commands (evaluate, scan-token, simulate-tx)
- Agent library — `evaluateTrade()`, `scanToken()`, `simulateTx()`
- LRU caching (60s TTL, 500 entries) for GoPlus API calls
- 50 unit tests across 4 suites
- Live fire testing against HashKey Chain Testnet
