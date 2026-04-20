/* Architecture + Analyzers */

function Architecture() {
  const items = [
    {
      no: '01', phase: 'Phase 2', key: 'token',
      title: 'Token Risk Analyzer',
      body: 'GoPlus Security API primary scan. Honeypot signatures, owner privilege detection, transfer tax, holder concentration, blacklist mechanisms. RPC bytecode pre-check confirms contract existence before oracle call.',
      metrics: [['latency', '~180ms'], ['surface', '11 checks'], ['oracle', 'GoPlus'], ['confidence', '0.94']],
    },
    {
      no: '02', phase: 'Phase 3', key: 'sim',
      title: 'TX Simulation & Fuzzing',
      body: 'Eight-variant invariant fuzzer over eth_call. Cross-RPC validation, revert detection, state-dependent trap identification, gas anomaly baselines.',
      metrics: [['latency', '~420ms'], ['variants', '8'], ['rpcs', '3'], ['baseline', '7d rolling']],
    },
    {
      no: '03', phase: 'Phase 4', key: 'mev',
      title: 'MEV Detection Engine',
      body: 'Trade-size-tiered slippage analysis. Caps tighten 50% above $10K, 25% above $1K, 10% above $100. Dynamic exposure scoring before on-chain execution.',
      metrics: [['latency', '~110ms'], ['threshold', '500 bps'], ['scaling', 'size-tiered'], ['cap range', '0.1–5%']],
    },
    {
      no: '04', phase: 'Phase 4.5', key: 'amm',
      title: 'AMM Pool Analytics',
      body: 'Uniswap V3 slot0, liquidity depth, TWAP deviation. Concentrated liquidity risk, price-impact modeling, tick manipulation detection.',
      metrics: [['latency', '~240ms'], ['twap', '5m · 30m'], ['tick scan', '±20'], ['impact', 'marginal']],
    },
  ];

  return (
    <Section id="architecture" no="01" label="ARCHITECTURE"
             extra={<span className="mono tiny muted">FOUR ANALYZERS · PARALLEL · FAIL-CLOSED</span>}>
      <div className="arch-intro">
        <p className="lead">
          A proposed trade is fanned out to four independent analyzers that
          return structured verdicts in parallel. Any <em>HIGH</em> or{' '}
          <em>CRITICAL</em> flag blocks execution. Silence is not safety — the
          oracle must affirmatively pass.
        </p>
      </div>

      <div className="arch-grid">
        {items.map(it => (
          <article key={it.key} className="arch-card">
            <div className="arch-head">
              <span className="mono small accent">{it.no}</span>
              <span className="mono tiny muted">{it.phase.toUpperCase()}</span>
            </div>
            <h3 className="arch-title">{it.title}</h3>
            <p className="arch-body">{it.body}</p>
            <div className="arch-metrics">
              {it.metrics.map(([k, v]) => (
                <div key={k}>
                  <span className="mono tiny muted">{k.toUpperCase()}</span>
                  <span className="mono small">{v}</span>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>

      <div className="pipeline-strip">
        <div className="ps-item"><span className="mono tiny muted">INGRESS</span><span className="mono">proposed trade</span></div>
        <span className="ps-arrow">→</span>
        <div className="ps-item ps-parallel">
          <div><Dot state="pass"/> TOKEN</div>
          <div><Dot state="pass"/> SIM</div>
          <div><Dot state="pass"/> MEV</div>
          <div><Dot state="pass"/> AMM</div>
        </div>
        <span className="ps-arrow">→</span>
        <div className="ps-item"><span className="mono tiny muted">AGGREGATE</span><span className="mono">score + flags</span></div>
        <span className="ps-arrow">→</span>
        <div className="ps-item"><span className="mono tiny muted">COMMIT</span><span className="mono">onchain proof</span></div>
        <span className="ps-arrow">→</span>
        <div className="ps-item ps-out"><span className="mono tiny">VERDICT</span><span className="mono big">PASS / WARN / BLOCK</span></div>
      </div>
    </Section>
  );
}

Object.assign(window, { Architecture });
