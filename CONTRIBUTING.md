# Contributing to Guardian Protocol

Thank you for your interest in making autonomous agents safer on X Layer. Here's how to contribute.

## 🛠️ Development Setup

```bash
# Clone the repository
git clone https://github.com/your-org/guardian-protocol.git
cd guardian-protocol

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Edit .env with your OKX API credentials and RPC endpoints

# Run tests
npm test

# Run in development mode
npm run dev
```

## 🧪 Running Tests

```bash
# All tests (72 tests, 5 suites)
npm test

# Watch mode (re-runs on file changes)
npm run test:watch

# Specific test file
npx vitest run tests/unit/scoring/risk-engine.test.ts

# With coverage
npx vitest run --coverage
```

### Test Suite Breakdown

| Suite | Tests | File |
|-------|-------|------|
| Token Risk Analyzer | 9 | `tests/unit/analyzers/token-risk.test.ts` |
| TX Simulation Analyzer | 13 | `tests/unit/analyzers/tx-simulation.test.ts` |
| MEV Detection Analyzer | 10 | `tests/unit/analyzers/mev-detection.test.ts` |
| AMM Pool Analyzer | 13 | `tests/unit/analyzers/amm-pool-analyzer.test.ts` |
| Risk Engine | 27 | `tests/unit/scoring/risk-engine.test.ts` |

## 📐 Code Standards

- **TypeScript Strict Mode** — `strict: true` in tsconfig.json. No `any` types.
- **Branded Types** — Use `Address` and `HexString` (not raw `string`) for EVM values.
- **Fail Closed** — Every error handler must default to "block the trade." Never fail open.
- **Deterministic** — No `Math.random()`, no `Date.now()` in scoring logic, no ambient state.
- **Dependency Injection** — All API clients accept an optional `client` parameter for testing.
- **Structured Logging** — Use `logger.info/warn/error()` with structured data objects.

## 🔌 Adding a New Analyzer

Guardian currently runs **4 parallel analyzers**. To add a 5th:

1. Create `src/analyzers/your-analyzer.ts`
2. Implement the `AnalyzerResult` interface:

```typescript
export async function analyzeYourThing(
  ...params
): Promise<AnalyzerResult> {
  return {
    analyzerName: "your-analyzer",
    flags: [],      // RiskFlag[]
    score: 100,     // 0–100
    durationMs: 0,
    data: {},       // Your structured report
  };
}
```

3. Add new `RiskFlagCode` entries in `src/types/output.ts`
4. Add tests in `tests/unit/analyzers/your-analyzer.test.ts`
5. Wire it into the orchestrator's `Promise.all` in `src/index.ts`
6. Add its weight to `ScoringWeights` in `src/scoring/risk-engine.ts`
7. Update `DEFAULT_WEIGHTS` — **all weights must sum to 1.0**
8. Update `src/scoring/thresholds.ts` with your analyzer's config section
9. Add cross-analyzer correlations in `detectCorrelations()`  (risk-engine.ts)
10. Update confidence degradation switch case for N+1 analyzers

### Current Weight Distribution (Phase 2)

| Analyzer | Weight | Rationale |
|----------|--------|-----------|
| Token Risk | 0.30 | Fatal if honeypot/blacklist |
| TX Simulation | 0.30 | Fatal if revert/exploit |
| MEV Signals | 0.15 | Mitigable — private mempool |
| AMM Pool | 0.25 | Non-mitigable — pool state is ground truth |

## 🔒 The Proprietary Signal Hook

If you want to add custom MEV/mempool intelligence without modifying core Guardian code, use the hook at `src/analyzers/mev-detection.ts` line ~240. See the README for the full API contract.

## 📝 Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add liquidity depth analyzer
fix: handle zero-division in slippage calc
test: add edge cases for scoring engine
docs: update API reference in README
refactor: rebalance risk engine for 4 analyzers
```

## 🔄 Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/your-feature`)
3. Write tests FIRST, then implementation
4. Ensure `npm test` passes with zero failures (currently 72/72)
5. Ensure `npx tsc --noEmit` passes with zero errors
6. Submit a PR with a clear description of what and why

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.
