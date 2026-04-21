/* Verdict panel: cockpit / dossier / diff styles */

function VerdictPanel({ stream, running }) {
  const style = window.GP_TWEAKS.verdictStyle || 'cockpit';
  const [_, force] = React.useState(0);
  React.useEffect(() => {
    const i = setInterval(() => force(n => n+1), 400);
    return () => clearInterval(i);
  }, []);

  if (!stream) return <EmptyPanel />;

  const s = window.GP_TWEAKS.verdictStyle;
  if (s === 'dossier') return <DossierPanel stream={stream} running={running} />;
  if (s === 'diff')    return <DiffPanel stream={stream} running={running} />;
  return <CockpitPanel stream={stream} running={running} />;
}

function EmptyPanel() {
  return (
    <div className="vp vp-empty">
      <div className="vp-head">
        <span className="mono tiny muted">▌ RESPONSE</span>
        <span className="mono tiny muted">awaiting request</span>
      </div>
      <div className="vp-empty-body">
        <div className="mono small muted">// no evaluation in flight</div>
        <div className="mono tiny muted">Submit a request to see a structured verdict here.</div>
      </div>
    </div>
  );
}

function useElapsed(running) {
  const [ms, setMs] = React.useState(0);
  React.useEffect(() => {
    if (!running) return;
    const start = performance.now();
    setMs(0);
    const id = setInterval(() => setMs(performance.now() - start), 16);
    return () => clearInterval(id);
  }, [running]);
  return ms;
}

function stateFor(stream, key) {
  const a = stream?.analyzers?.[key];
  if (!a) return { state: 'pending', ms: null };
  return a;
}

function CockpitPanel({ stream, running }) {
  const elapsed = useElapsed(running);
  const done = stream.analyzers && Object.keys(stream.analyzers).length === 4 && !running;
  const score = done && stream.result ? stream.result.score : null;
  const verdict = done && stream.result ? stream.result.verdict : (running ? 'EVALUATING' : 'PENDING');

  const analyzers = [
    ['token', 'Token Risk',     'GoPlus dual-oracle'],
    ['sim',   'TX Simulation',  '8-variant fuzzer'],
    ['mev',   'MEV Detection',  'builder toxicity'],
    ['amm',   'AMM Pool',       'multi-protocol discovery'],
  ];

  return (
    <div className={`vp vp-cockpit v-${verdict.toLowerCase()}`}>
      <div className="vp-head">
        <span className="mono tiny muted">▌ RESPONSE</span>
        <span className="mono tiny">{stream.id || 'ev_…'}</span>
        <span className="mono tiny muted">{running ? (elapsed/1000).toFixed(2)+'s' : ''}</span>
      </div>

      <div className="vp-verdict">
        <div className="vp-v-label mono small">VERDICT</div>
        <div className="vp-v-big">{verdict}</div>
        <div className="vp-v-score">
          <div className="mono tiny muted">SCORE</div>
          <div className="mono big">{score !== null ? score : '—'}<span className="muted">/100</span></div>
          <Meter value={score || 0} />
        </div>
      </div>

      <div className="vp-analyzers">
        {analyzers.map(([k, name, sub]) => {
          const a = stateFor(stream, k);
          return (
            <div key={k} className={`vp-a a-${a.state}`}>
              <div className="vp-a-top">
                <Dot state={a.state} />
                <span className="mono small">{name}</span>
                <span className="mono tiny muted">{a.ms ? a.ms+'ms' : '· · ·'}</span>
              </div>
              <div className="mono xs muted">{sub}</div>
              <div className="mono xs">{a.state === 'pending' ? 'scanning…' : a.state.toUpperCase()}</div>
            </div>
          );
        })}
      </div>

      <div className="vp-flags">
        <div className="vp-flags-head">
          <span className="mono tiny muted">▌ RISK FLAGS</span>
          <span className="mono tiny">{stream.flags.length}</span>
        </div>
        {stream.flags.length === 0 && <div className="mono xs muted vp-empty-row">— none raised —</div>}
        {stream.flags.map((f, i) => (
          <div key={i} className="vp-flag">
            <TierChip tier={f.tier} />
            <span className="mono xs">{f.code}</span>
            <span className="mono xs muted">{f.label}</span>
            <span className="mono xs muted vp-flag-src">{f.src}</span>
          </div>
        ))}
      </div>

      <div className="vp-foot">
        <span className="mono tiny muted">chain hashkey(177)</span>
        <span className="mono tiny muted">· fail-closed</span>
        <span className="mono tiny muted">· deterministic</span>
      </div>
    </div>
  );
}

function DossierPanel({ stream, running }) {
  const done = stream.analyzers && Object.keys(stream.analyzers).length === 4 && !running;
  const score = done && stream.result ? stream.result.score : null;
  const verdict = done && stream.result ? stream.result.verdict : (running ? 'EVALUATING' : 'PENDING');
  return (
    <div className={`vp vp-dossier v-${verdict.toLowerCase()}`}>
      <div className="do-stamp mono tiny">GUARDIAN PROTOCOL · EVALUATION REPORT</div>
      <div className="do-head">
        <div>
          <div className="mono tiny muted">CASE</div>
          <div className="mono">{stream.id || 'ev_—'}</div>
        </div>
        <div>
          <div className="mono tiny muted">ISSUED</div>
          <div className="mono">{new Date().toISOString().slice(0,19)}Z</div>
        </div>
        <div>
          <div className="mono tiny muted">CHAIN</div>
          <div className="mono">HASHKEY·177</div>
        </div>
      </div>
      <div className="do-verdict">
        <div className="mono tiny muted">DETERMINATION</div>
        <div className="do-v-big">{verdict}</div>
        <div className="mono small">score {score !== null ? score : '—'}/100</div>
      </div>
      <div className="do-section">
        <div className="mono tiny muted">ANALYZERS</div>
        <table className="do-table">
          <tbody>
            {['token','sim','mev','amm'].map(k => {
              const a = stateFor(stream, k);
              return (
                <tr key={k}>
                  <td className="mono xs"><Dot state={a.state}/> {k.toUpperCase()}</td>
                  <td className="mono xs muted">{a.state === 'pending' ? 'scanning' : a.state}</td>
                  <td className="mono xs muted">{a.ms ? a.ms+' ms' : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="do-section">
        <div className="mono tiny muted">FLAGS · {stream.flags.length}</div>
        {stream.flags.length === 0
          ? <div className="mono xs muted">— none —</div>
          : stream.flags.map((f,i)=>(
            <div key={i} className="do-flag">
              <TierChip tier={f.tier}/> <span className="mono xs">{f.code}</span>
              <span className="mono xs muted"> — {f.label}</span>
            </div>
          ))}
      </div>
      <div className="do-foot mono tiny muted">
        signed · deterministic · fail-closed · onchain proof pending
      </div>
    </div>
  );
}

function DiffPanel({ stream, running }) {
  const done = stream.analyzers && Object.keys(stream.analyzers).length === 4 && !running;
  const verdict = done && stream.result ? stream.result.verdict : (running ? 'EVAL' : 'WAIT');
  const lines = [];
  lines.push({ t: 'c', s: `// guardian-protocol · eval ${stream.id || '…'}` });
  lines.push({ t: 'c', s: `// chain: 177 · hashkey · fail-closed` });
  ['token','sim','mev','amm'].forEach(k => {
    const a = stateFor(stream, k);
    if (a.state === 'pending') lines.push({ t: 'n', s: `  analyze(${k})  ⟳ scanning…` });
    else if (a.state === 'pass') lines.push({ t: '+', s: `  analyze(${k})  pass  ${a.ms}ms` });
    else if (a.state === 'warn') lines.push({ t: 'w', s: `  analyze(${k})  warn  ${a.ms}ms` });
    else lines.push({ t: '-', s: `  analyze(${k})  fail  ${a.ms}ms` });
  });
  stream.flags.forEach(f => {
    const t = f.tier === 'CRIT' || f.tier === 'HIGH' ? '-' : 'w';
    lines.push({ t, s: `    ⚑ ${f.code}  [${f.tier}]  ${f.label}` });
  });
  lines.push({ t: 'c', s: `// --` });
  lines.push({ t: done ? (verdict === 'PASS' ? '+' : '-') : 'n', s: `verdict ${verdict}` });

  return (
    <div className="vp vp-diff">
      <div className="vp-head">
        <span className="mono tiny muted">▌ stdout</span>
        <span className="mono tiny muted">guardian --eval</span>
      </div>
      <pre className="diff-code">
        {lines.map((l,i) => (
          <div key={i} className={`diff-${l.t}`}>
            <span className="diff-g">{l.t === 'c' ? ' ' : l.t === 'n' ? '·' : l.t === 'w' ? '!' : l.t}</span>
            <span>{l.s}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

function computeScore(stream) {
  return Math.max(0, 100 - stream.flags.reduce((a, f) =>
    a + (f.tier === 'CRIT' ? 60 : f.tier === 'HIGH' ? 25 : f.tier === 'MED' ? 10 : 3), 0));
}
function computeVerdict(stream) {
  if (stream.flags.some(f => f.tier === 'CRIT' || f.tier === 'HIGH')) return 'BLOCK';
  if (stream.flags.some(f => f.tier === 'MED')) return 'WARN';
  return 'PASS';
}

Object.assign(window, { VerdictPanel, computeScore, computeVerdict });
