# `src/routing/` — Phase 3: Optimized Routing (Planned)

This directory is reserved for the **Guardian Optimized Routing** module, scheduled for Phase 3.

## What Will Go Here

When implemented, this module will:
1. Query the OKX DEX API for swap routes across available X Layer liquidity pools
2. Filter routes through Guardian's security pipeline (no routing through flagged pools)
3. Return the safest route that meets the agent's slippage requirements
4. Populate `optimizedRouting` in the `GuardianEvaluationResponse` (currently `null`)

## Current Status

`optimizedRouting` in the response payload is `null` in v0.2.1.

The field is reserved and typed in the output schema so agents integrating now will get the enriched routing data without breaking changes when Phase 3 ships.

## Timeline

- **Phase 1 (v0.1.0):** Core 3-analyzer pipeline, scoring engine, CLI
- **Phase 2 (v0.2.1):** AMM pool analyzer, RPC redundancy, TX fuzzing, MEV upgrades ✅
- **Phase 3 (planned):** Optimized routing — OKX DEX integration for safe route selection
