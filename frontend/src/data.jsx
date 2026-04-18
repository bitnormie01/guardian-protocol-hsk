/* Data layer + API integration
 * - Mock evaluateTrade() retained for hero live feed
 * - Real API calls for interactive Evaluation Console
 */

const CHAINS = [
  { id: 177, name: 'HashKey Chain Mainnet' },
  { id: 133, name: 'HashKey Chain Testnet' },
];

// ── Real addresses for demo defaults ──────────────────────────
const SAMPLE_ADDR = '0xefd4bc9afd210517803f293ababd701caeecdfd0'; // WHSK
const USER_ADDR   = '0x2B6E71C59f571969Ae9C32373aa4Ce48054cbF27';
const TOKEN_OUT_DEFAULT = '0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029'; // USDT
const POOL_DEFAULT = '0xd136e36610f35e0cc3cad40de858c151f2aa65d4';

// ── Mock risk flags for hero live feed ONLY ───────────────────
const RISK_FLAGS = [
  { code: 'TOK-001', tier: 'CRIT', label: 'Honeypot signature detected', src: 'token' },
  { code: 'TOK-007', tier: 'HIGH', label: 'Owner can mint unlimited supply', src: 'token' },
  { code: 'TOK-012', tier: 'MED',  label: 'Holder concentration > 40% top-1', src: 'token' },
  { code: 'TOK-018', tier: 'LOW',  label: 'Transfer tax set to 3.0%', src: 'token' },
  { code: 'TOK-022', tier: 'MED',  label: 'Blacklist function present', src: 'token' },
  { code: 'TXS-004', tier: 'HIGH', label: 'State-dependent revert at slot 0x4', src: 'sim' },
  { code: 'TXS-009', tier: 'MED',  label: 'Gas anomaly +340% vs baseline', src: 'sim' },
  { code: 'TXS-015', tier: 'LOW',  label: 'Fuzz variant 6/8 reverted', src: 'sim' },
  { code: 'MEV-002', tier: 'HIGH', label: 'Builder toxicity score 0.82', src: 'mev' },
  { code: 'MEV-011', tier: 'MED',  label: 'Sandwich pattern matched (0.6 conf)', src: 'mev' },
  { code: 'AMM-003', tier: 'MED',  label: 'TWAP deviation 4.1σ from spot', src: 'amm' },
  { code: 'AMM-008', tier: 'LOW',  label: 'Liquidity depth <$50k at ±2% tick', src: 'amm' },
];

// ── Deterministic hash for mock data ──────────────────────────
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ── MOCK evaluateTrade (used by hero live feed ONLY) ──────────
function mockEvaluateTrade(inputs) {
  const seed = hashStr(JSON.stringify(inputs));
  const rng = (n) => (hashStr(seed + ':' + n) % 1000) / 1000;

  const flagCount = Math.floor(rng(1) * 6);
  const shuffled = [...RISK_FLAGS].sort((a, b) => hashStr(seed + a.code) - hashStr(seed + b.code));
  const flags = shuffled.slice(0, flagCount);

  const score = Math.max(0, 100 - flags.reduce((a, f) =>
    a + (f.tier === 'CRIT' ? 60 : f.tier === 'HIGH' ? 25 : f.tier === 'MED' ? 10 : 3), 0));

  const isSafe = !flags.some(f => f.tier === 'CRIT' || f.tier === 'HIGH');
  const verdict = flags.some(f => f.tier === 'CRIT') ? 'BLOCK'
                : flags.some(f => f.tier === 'HIGH') ? 'BLOCK'
                : flags.some(f => f.tier === 'MED')  ? 'WARN'
                : 'PASS';

  const analyzers = {
    token: { state: flags.some(f => f.src === 'token') ? (verdict === 'BLOCK' ? 'fail' : 'warn') : 'pass',
             ms: 180 + Math.floor(rng(2) * 400) },
    sim:   { state: flags.some(f => f.src === 'sim')   ? (verdict === 'BLOCK' ? 'fail' : 'warn') : 'pass',
             ms: 420 + Math.floor(rng(3) * 600) },
    mev:   { state: flags.some(f => f.src === 'mev')   ? 'warn' : 'pass',
             ms: 110 + Math.floor(rng(4) * 300) },
    amm:   { state: flags.some(f => f.src === 'amm')   ? 'warn' : 'pass',
             ms: 240 + Math.floor(rng(5) * 350) },
  };

  const totalMs = Math.max(...Object.values(analyzers).map(a => a.ms)) + 80;

  return {
    id: 'ev_' + seed.toString(36).slice(0, 10),
    verdict, isSafe, score, flags, analyzers,
    ms: totalMs,
    block: 2_145_830 + (seed % 10_000),
    timestamp: Date.now(),
    chain: inputs.chain || 177,
  };
}

// ── Mock streaming (used by hero live feed ONLY) ──────────────
function mockStreamEvaluate(inputs, onEvent) {
  const final = mockEvaluateTrade(inputs);
  const steps = [
    { t: 40,  ev: { kind: 'start', id: final.id } },
    { t: final.analyzers.mev.ms,   ev: { kind: 'analyzer', key: 'mev',   state: final.analyzers.mev.state,   ms: final.analyzers.mev.ms } },
    { t: final.analyzers.token.ms, ev: { kind: 'analyzer', key: 'token', state: final.analyzers.token.state, ms: final.analyzers.token.ms } },
    { t: final.analyzers.amm.ms,   ev: { kind: 'analyzer', key: 'amm',   state: final.analyzers.amm.state,   ms: final.analyzers.amm.ms } },
    { t: final.analyzers.sim.ms,   ev: { kind: 'analyzer', key: 'sim',   state: final.analyzers.sim.state,   ms: final.analyzers.sim.ms } },
  ];
  final.flags.forEach((f, i) => {
    steps.push({ t: 60 + i * 90 + (final.analyzers[f.src]?.ms || 300) * 0.5, ev: { kind: 'flag', flag: f } });
  });
  steps.push({ t: final.ms, ev: { kind: 'done', result: final } });
  steps.sort((a, b) => a.t - b.t);
  const timers = [];
  steps.forEach(s => timers.push(setTimeout(() => onEvent(s.ev), s.t)));
  return () => timers.forEach(clearTimeout);
}

// ═══════════════════════════════════════════════════════════════
// ── REAL API LAYER (used by Evaluation Console) ───────────────
// ═══════════════════════════════════════════════════════════════

// Map backend severity string → UI tier code
function mapSeverity(sev) {
  if (!sev) return 'LOW';
  const s = sev.toLowerCase();
  if (s === 'critical') return 'CRIT';
  if (s === 'high')     return 'HIGH';
  if (s === 'medium')   return 'MED';
  return 'LOW';
}

// Map backend source string → short key
function mapSource(src) {
  if (!src) return 'unknown';
  const s = src.toLowerCase();
  if (s.includes('token'))  return 'token';
  if (s.includes('sim'))    return 'sim';
  if (s.includes('mev'))    return 'mev';
  if (s.includes('amm') || s.includes('pool')) return 'amm';
  return src;
}

// Determine analyzer state from score
function analyzerState(score) {
  if (score == null || score === undefined) return 'pending';
  if (score >= 70) return 'pass';
  if (score >= 40) return 'warn';
  return 'fail';
}

// Map full pipeline response → UI model
function mapPipelineResponse(data, durationMs) {
  const safetyScore = data?.safetyScore ?? {};
  const breakdown = safetyScore.breakdown ?? {};
  const overall = safetyScore.overall ?? 0;
  const isSafe = data?.isSafeToExecute === true;

  // Map flags
  const flags = (data?.flags || []).map(f => ({
    code: f.code || 'UNKNOWN',
    tier: mapSeverity(f.severity),
    label: f.message || f.description || '',
    src: mapSource(f.source),
  }));

  // Verdict
  const verdict = isSafe
    ? (flags.some(f => f.tier === 'MED') ? 'WARN' : 'PASS')
    : 'BLOCK';

  // Analyzer results
  const analyzers = {
    token: { state: analyzerState(breakdown.tokenRisk),     ms: null },
    sim:   { state: analyzerState(breakdown.txSimulation),  ms: null },
    mev:   { state: analyzerState(breakdown.mevRisk),       ms: null },
    amm:   { state: analyzerState(breakdown.ammPoolRisk),   ms: null },
  };

  return {
    id: data?.evaluationId || 'ev_' + Date.now().toString(36),
    verdict, isSafe, score: overall, flags, analyzers,
    ms: durationMs || data?.meta?.evaluationDurationMs || 0,
    block: null,
    timestamp: Date.now(),
    chain: 177,
  };
}

// Map single-analyzer response → UI model
function mapSingleResponse(mode, data, durationMs) {
  const flags = (data?.flags || []).map(f => ({
    code: f.code || 'UNKNOWN',
    tier: mapSeverity(f.severity),
    label: f.message || f.description || '',
    src: mapSource(f.source || mode),
  }));

  let score, verdict, isSafe;

  if (mode === 'token') {
    score = data?.safetyScore?.overall ?? data?.score ?? 0;
    isSafe = data?.isSafe !== false;
  } else if (mode === 'sim') {
    score = data?.safetyScore?.overall ?? data?.score ?? 0;
    isSafe = data?.simulationSuccess !== false;
  } else if (mode === 'mev') {
    score = data?.score ?? 0;
    isSafe = score >= 50;
  } else {
    // amm
    score = data?.score ?? 0;
    isSafe = score >= 50;
  }

  verdict = !isSafe ? 'BLOCK' : (flags.some(f => f.tier === 'MED') ? 'WARN' : 'PASS');

  const analyzers = {
    [mode]: { state: analyzerState(score), ms: durationMs },
  };

  return {
    id: data?.evaluationId || 'ev_' + Date.now().toString(36),
    verdict, isSafe, score, flags, analyzers,
    ms: durationMs || 0,
    block: null,
    timestamp: Date.now(),
    chain: 177,
  };
}

// ── Build API request from form inputs ────────────────────────

function buildApiRequest(inputs) {
  const only = inputs._only;

  // Full pipeline
  if (!only) {
    return {
      endpoint: '/api/evaluate',
      payload: {
        tokenIn: inputs.tokenIn,
        tokenOut: inputs.tokenOut,
        amountRaw: inputs.amount,
        userAddress: inputs.user,
        proposedTxHex: inputs.txHex || undefined,
        proposedTxTarget: inputs.target || undefined,
        chainId: inputs.chain || 177,
      },
      mode: 'full',
    };
  }

  if (only === 'token') {
    return {
      endpoint: '/api/scan',
      payload: { tokenAddress: inputs.tokenIn, chainId: inputs.chain || 177 },
      mode: 'token',
    };
  }

  if (only === 'sim') {
    return {
      endpoint: '/api/simulate',
      payload: {
        proposedTxHex: inputs.txHex,
        userAddress: inputs.tokenIn,  // form passes `from` as tokenIn
        targetAddress: inputs.tokenOut, // form passes `to` as tokenOut
        chainId: inputs.chain || 177,
      },
      mode: 'sim',
    };
  }

  if (only === 'mev') {
    return {
      endpoint: '/api/mev',
      payload: {
        tokenIn: inputs.tokenIn,
        tokenOut: inputs.tokenOut,
        estimatedTradeUsd: parseInt(inputs.amount, 10) || 1000,
        chainId: inputs.chain || 177,
      },
      mode: 'mev',
    };
  }

  // amm
  return {
    endpoint: '/api/amm',
    payload: {
      poolAddress: inputs.tokenIn,  // form passes pool as tokenIn
      estimatedTradeUsd: parseInt(inputs.amount, 10) || 1000,
      chainId: inputs.chain || 177,
    },
    mode: 'amm',
  };
}

// ── REAL streamEvaluate (used by Evaluation Console) ──────────
// Makes a real API call, then simulates progressive UI updates
// so the cockpit/verdict panel animates nicely.

function streamEvaluate(inputs, onEvent) {
  let cancelled = false;
  const timers = [];

  const { endpoint, payload, mode } = buildApiRequest(inputs);
  const startTime = performance.now();

  // Emit start immediately
  const tempId = 'ev_' + Date.now().toString(36);
  timers.push(setTimeout(() => {
    if (!cancelled) onEvent({ kind: 'start', id: tempId });
  }, 40));

  // Make the real API call
  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then(res => res.json())
    .then(data => {
      if (cancelled) return;
      const durationMs = Math.round(performance.now() - startTime);

      let result;
      if (mode === 'full') {
        result = mapPipelineResponse(data, durationMs);
      } else {
        result = mapSingleResponse(mode, data, durationMs);
      }

      // Simulate progressive analyzer emissions
      const analyzerKeys = Object.keys(result.analyzers);
      analyzerKeys.forEach((key, i) => {
        const delay = 100 + i * 200; // stagger by 200ms
        timers.push(setTimeout(() => {
          if (!cancelled) {
            onEvent({
              kind: 'analyzer',
              key,
              state: result.analyzers[key].state,
              ms: result.analyzers[key].ms || Math.round(delay + Math.random() * 200),
            });
          }
        }, delay));
      });

      // Emit flags progressively
      result.flags.forEach((f, i) => {
        const delay = 300 + i * 120;
        timers.push(setTimeout(() => {
          if (!cancelled) onEvent({ kind: 'flag', flag: f });
        }, delay));
      });

      // Emit done after all animations
      const doneDelay = Math.max(600, analyzerKeys.length * 200 + result.flags.length * 120 + 200);
      timers.push(setTimeout(() => {
        if (!cancelled) onEvent({ kind: 'done', result });
      }, doneDelay));
    })
    .catch(err => {
      if (cancelled) return;
      // Fail-closed: show error as BLOCK verdict
      const errorResult = {
        id: tempId,
        verdict: 'BLOCK',
        isSafe: false,
        score: 0,
        flags: [{ code: 'API_ERROR', tier: 'CRIT', label: err.message || 'Evaluation failed', src: 'system' }],
        analyzers: {},
        ms: Math.round(performance.now() - startTime),
        timestamp: Date.now(),
        chain: 177,
      };
      onEvent({ kind: 'flag', flag: errorResult.flags[0] });
      timers.push(setTimeout(() => {
        if (!cancelled) onEvent({ kind: 'done', result: errorResult });
      }, 300));
    });

  return () => {
    cancelled = true;
    timers.forEach(clearTimeout);
  };
}

// ── Expose to window (scripts loaded in order, no module system) ──
Object.assign(window, {
  CHAINS, RISK_FLAGS, SAMPLE_ADDR, USER_ADDR, TOKEN_OUT_DEFAULT, POOL_DEFAULT,
  hashStr, mockEvaluateTrade, mockStreamEvaluate,
  streamEvaluate, // Real API version used by EvaluateConsole
  mapPipelineResponse, mapSingleResponse,
});
