/* Hero: Live evaluation stream */

function shortHash(seed, len = 6) {
  const s = (hashStr(seed) * 9301 + 49297).toString(16);
  return '0x' + s.padStart(8, '0').slice(0, len) + '…' + s.slice(-4);
}

function useLiveFeed() {
  // simulated continuous stream of evaluations
  const [feed, setFeed] = React.useState([]);
  const [current, setCurrent] = React.useState(null);
  const [live, setLive] = React.useState({ analyzers: {}, flags: [], score: null, verdict: null, id: null });
  React.useEffect(() => {
    let cancel;
    let idx = 0;
    const targets = [
      { tokenIn: 'HSK',   tokenOut: 'USDC', amt: '12000', seed: 'a1' },
      { tokenIn: 'WETH',  tokenOut: 'PEPE', amt: '0.5',   seed: 'b2' },
      { tokenIn: 'USDC',  tokenOut: 'HSK',  amt: '500',   seed: 'c3' },
      { tokenIn: 'ARB',   tokenOut: 'USDT', amt: '2400',  seed: 'd4' },
      { tokenIn: 'WBTC',  tokenOut: 'USDC', amt: '0.08',  seed: 'e5' },
      { tokenIn: 'PEPE',  tokenOut: 'WETH', amt: '4.2M',  seed: 'f6' },
    ];
    function run() {
      const t = targets[idx % targets.length]; idx++;
      setCurrent(t);
      setLive({ analyzers: {}, flags: [], score: null, verdict: null, id: null });
      cancel = mockStreamEvaluate({ ...t, chain: 177 }, ev => {
        if (ev.kind === 'start') {
          setLive(l => ({ ...l, id: ev.id }));
        } else if (ev.kind === 'analyzer') {
          setLive(l => ({ ...l, analyzers: { ...l.analyzers, [ev.key]: ev } }));
        } else if (ev.kind === 'flag') {
          setLive(l => ({ ...l, flags: [...l.flags, ev.flag] }));
        } else if (ev.kind === 'done') {
          setLive(l => ({ ...l, score: ev.result.score, verdict: ev.result.verdict }));
          setFeed(f => [{ ...ev.result, target: t }, ...f].slice(0, 14));
          setTimeout(run, 1400);
        }
      });
    }
    const t0 = setTimeout(run, 300);
    return () => { clearTimeout(t0); cancel && cancel(); };
  }, []);
  return { feed, current, live };
}

function HeroStream() {
  const { feed, current, live } = useLiveFeed();
  const now = useNow();
  const analyzerOrder = [
    ['token', 'TOKEN',   'Risk'],
    ['sim',   'SIM',     'Fuzz'],
    ['mev',   'MEV',     'Guard'],
    ['amm',   'AMM',     'Pool'],
  ];

  return (
    <div className="hero-stream">
      <div className="hero-left">
        <div className="hero-kicker">
          <span className="blip" /> LIVE · HASHKEY CHAIN · BLOCK 2,145,{(now.getSeconds()+830).toString().padStart(3,'0')}
        </div>
        <h1 className="hero-h1">
          Every autonomous trade,<br/>
          <em>interrogated</em> before execution.
        </h1>
        <p className="hero-sub">
          Guardian Protocol is a four-analyzer security oracle for AI agents
          on HashKey Chain. It returns a deterministic, machine-readable
          verdict in under two seconds — or it fails closed.
        </p>
        <div className="hero-cta">
          <Btn onClick={() => { const el = document.getElementById('evaluate'); el && window.scrollTo({top: el.offsetTop - 20, behavior: 'smooth'}); }}>
            ▸ Evaluate a trade
          </Btn>
          <Btn variant="ghost" onClick={() => { const el = document.getElementById('architecture'); el && window.scrollTo({top: el.offsetTop - 20, behavior: 'smooth'}); }}>
            View architecture
          </Btn>
        </div>

        <div className="hero-stats">
          <Stat k="TESTS PASSING" v="76/76" sub="deterministic suite" big accent />
          <Stat k="RISK FLAGS" v="30+" sub="taxonomy codes" big />
          <Stat k="ONCHAIN PROOFS" v="3" sub="verdict commits" big />
        </div>
      </div>

      <div className="hero-right">
        <div className="console">
          <div className="console-head">
            <span className="mono small">guardian://live-feed</span>
            <span className="console-dots">
              <i/><i/><i/>
            </span>
          </div>

          <div className="console-body">
            <div className="now-eval">
              <div className="mono tiny muted">▌ CURRENT EVALUATION</div>
              <div className="now-row">
                <div className="mono small">
                  {current ? `${current.tokenIn} → ${current.tokenOut}` : '—'}
                </div>
                <div className="mono tiny muted">
                  {live.id || 'ev_—'}
                </div>
              </div>

              <div className="analyzer-grid">
                {analyzerOrder.map(([key, name, label]) => {
                  const a = live.analyzers[key];
                  const state = a ? a.state : 'pending';
                  return (
                    <div key={key} className={`an an-${state}`}>
                      <div className="an-head">
                        <Dot state={state} />
                        <span className="mono tiny">{name}</span>
                      </div>
                      <div className="mono xs muted">{label}</div>
                      <div className="mono xs">
                        {a ? `${a.ms}ms` : '· · ·'}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flag-stream">
                {live.flags.length === 0 && <div className="mono xs muted">No flags raised · scanning…</div>}
                {live.flags.slice(0, 3).map((f, i) =>
                  <div key={i} className="flag-line">
                    <TierChip tier={f.tier} />
                    <span className="mono xs">{f.code}</span>
                    <span className="mono xs muted">{f.label}</span>
                  </div>
                )}
              </div>

              {live.verdict && (
                <div className={`verdict-stamp v-${live.verdict.toLowerCase()}`}>
                  <span className="mono small">VERDICT</span>
                  <span className="mono big">{live.verdict}</span>
                  <span className="mono small">{live.score}/100</span>
                </div>
              )}
            </div>

            <div className="feed-divider">
              <span className="mono tiny muted">▌ RECENT — {fmtTime(now)}</span>
            </div>

            <div className="feed-list">
              {feed.slice(0, 6).map((f, i) => (
                <div key={f.id + i} className={`feed-item feed-${f.verdict.toLowerCase()}`}>
                  <span className="mono xs muted">{new Date(f.timestamp).toISOString().slice(14,19)}</span>
                  <span className="mono xs">{f.target.tokenIn}→{f.target.tokenOut}</span>
                  <span className="mono xs muted">{f.ms}ms</span>
                  <span className={`mono xs v-${f.verdict.toLowerCase()}-text`}>{f.verdict}</span>
                  <span className="mono xs muted">{f.score}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function HeroManifesto() {
  return (
    <div className="hero-manifesto">
      <div className="hm-kicker mono small">GUARDIAN PROTOCOL · v0.2.1 · HASHKEY CHAIN</div>
      <h1 className="hm-title">
        Fail-closed<br/>by default.
      </h1>
      <p className="hm-sub">
        A security oracle that refuses to let an autonomous agent trade
        anything it cannot prove is safe — in under two seconds.
      </p>
      <div className="hm-stats">
        <div><b>76/76</b><span>tests passing</span></div>
        <div><b>30+</b><span>risk flag codes</span></div>
        <div><b>3</b><span>on-chain proofs</span></div>
      </div>
    </div>
  );
}

function HeroPipeline() {
  const stages = [
    { k: 'TOKEN', label: 'Token Risk', sub: 'GoPlus dual-oracle · honeypot · taxes · concentration' },
    { k: 'SIM',   label: 'TX Simulation', sub: '8-variant fuzzer · eth_call · revert detection' },
    { k: 'MEV',   label: 'MEV Detect', sub: 'builder toxicity · sandwich patterns · slippage caps' },
    { k: 'AMM',   label: 'AMM Analytics', sub: 'Uni V3 slot0 · TWAP · tick manipulation' },
  ];
  return (
    <div className="hero-pipeline">
      <div className="hp-kicker mono small">INCOMING TRADE</div>
      <div className="hp-pipe">
        {stages.map((s, i) => (
          <React.Fragment key={s.k}>
            <div className="hp-stage">
              <div className="hp-k mono tiny">{String(i+1).padStart(2,'0')}</div>
              <div className="hp-label">{s.label}</div>
              <div className="hp-sub mono xs muted">{s.sub}</div>
            </div>
            {i < stages.length - 1 && <div className="hp-arrow">→</div>}
          </React.Fragment>
        ))}
        <div className="hp-arrow">→</div>
        <div className="hp-verdict">
          <div className="mono tiny">VERDICT</div>
          <div className="mono big">PASS · WARN · BLOCK</div>
          <div className="mono xs muted">deterministic · signed · on-chain</div>
        </div>
      </div>
    </div>
  );
}

function Hero() {
  const [variant, setVariant] = React.useState(window.GP_TWEAKS.heroVariant);
  React.useEffect(() => {
    const i = setInterval(() => setVariant(window.GP_TWEAKS.heroVariant), 300);
    return () => clearInterval(i);
  }, []);
  if (variant === 'manifesto') return <><HeroManifesto /><HeroStream /></>;
  if (variant === 'pipeline')  return <><HeroPipeline /><HeroStream /></>;
  return <HeroStream />;
}

Object.assign(window, { Hero, HeroStream, HeroManifesto, HeroPipeline });
