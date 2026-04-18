/* Proof logger + footer + integration callouts */

function ProofLogger({ recent }) {
  const contract = '0x33C38701715be74327B1Bc6EDf9Da81Bfb6800A8';
  const proofs = [
    '0x74a05cf4fffe407f1a0f20bb4afc0a5af98d9e82da1d80b409765cdf993732ca',
    '0x547fffbf06786d1eda3e8061d041f9b200b93662bf65f2facecb49a491025ffa',
    '0xce9f20b40c4ac141a53f1333e6d627e9751cb8e2b8ce2fb65054911a9ff7ed20',
  ];
  return (
    <Section id="proofs" no="03" label="ONCHAIN PROOF LOGGER"
             extra={<span className="mono tiny muted">EVERY VERDICT COMMITTED · HASHKEY TESTNET</span>}>
      <div className="proof-grid">
        <div className="proof-card">
          <div className="mono tiny muted">CONTRACT</div>
          <div className="mono">GuardianProofLogger</div>
          <div className="mono xs accent">{contract.slice(0,10)}…{contract.slice(-6)}</div>
          <div className="proof-metrics">
            <div><span className="mono tiny muted">CHAIN</span><span className="mono">Testnet · 133</span></div>
            <div><span className="mono tiny muted">LOGGED</span><span className="mono">3</span></div>
            <div><span className="mono tiny muted">ARCH</span><span className="mono">Fail-Closed</span></div>
          </div>
        </div>

        <div className="proof-txs">
          <div className="mono tiny muted">▌ PROOF TRANSACTIONS</div>
          {proofs.map((p, i) => (
            <a key={p} className="proof-tx" href={`https://testnet-explorer.hsk.xyz/tx/${p}`} target="_blank" rel="noopener">
              <span className="mono tiny muted">#{String(i+1).padStart(3,'0')}</span>
              <span className="mono small accent">{p.slice(0,10)}…{p.slice(-6)}</span>
              <span className="mono xs muted">VERDICT LOGGED</span>
              <span className="proof-arrow">↗</span>
            </a>
          ))}
        </div>
      </div>
    </Section>
  );
}

function Integration() {
  return (
    <Section id="integrate" no="04" label="INTEGRATION"
             extra={<span className="mono tiny muted">DROP-IN FOR AGENT RUNTIMES</span>}>
      <div className="int-grid">
        <div className="int-copy">
          <h3>One call between your agent and the chain.</h3>
          <p>
            Guardian returns a deterministic, machine-readable verdict. Route
            every proposed trade through <code className="mono">evaluateTrade()</code> and act on
            <code className="mono"> isSafeToExecute</code>. If the oracle is
            unreachable, treat as fail. Silence is never safety.
          </p>
          <ul className="int-list">
            <li><span className="mono tiny accent">01</span> Parallel analyzers · p99 under 2s</li>
            <li><span className="mono tiny accent">02</span> Structured JSON · 30+ flag codes</li>
            <li><span className="mono tiny accent">03</span> Signed verdict · onchain commit</li>
            <li><span className="mono tiny accent">04</span> Dual-RPC cross-validation</li>
          </ul>
        </div>
        <div className="int-code">
          <div className="code-head mono tiny muted">// guardian-client.ts</div>
          <pre className="code">
{`import { guardian } from '@guardian/client';

const verdict = await guardian.evaluateTrade({
  tokenIn:  TOKEN_IN,
  tokenOut: TOKEN_OUT,
  amount:   AMOUNT_WEI,
  user:     AGENT_ADDR,
  chain:    177,
});

if (!verdict.isSafeToExecute) {
  agent.halt(verdict.flags);
  return;
}

await router.execute(tx, {
  maxSlippage: verdict.mev.slippageCap,
});`}
          </pre>
        </div>
      </div>
    </Section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="foot-row">
        <div className="foot-brand">
          <img src="logo.webp" alt="Guardian Protocol Logo" className="gp-logo" />
          <div>
            <div className="mono">GUARDIAN PROTOCOL</div>
            <div className="mono tiny muted">v0.2.1 · horizon hackathon · ai track</div>
          </div>
        </div>
        <div className="foot-links">
          <a href="https://github.com/bitnormie01/guardian-protocol-hsk" target="_blank" rel="noopener">github ↗</a>
          <a href="https://testnet-explorer.hsk.xyz/address/0x33C38701715be74327B1Bc6EDf9Da81Bfb6800A8" target="_blank" rel="noopener">explorer ↗</a>
          <a href="#architecture">architecture</a>
          <a href="#evaluate">evaluate</a>
          <a href="#proofs">proofs</a>
        </div>
        <div className="mono tiny muted">© 2026 · fail-closed by default</div>
      </div>
    </footer>
  );
}

function TopNav({ onTweaks }) {
  return (
    <header className="topnav">
      <div className="nav-left">
        <img src="logo.webp" alt="Guardian Protocol Logo" className="gp-logo" />
        <div className="nav-brand">
          <div className="mono small">GUARDIAN<span className="accent">.</span></div>
          <div className="mono tiny muted">v0.2.1 · hashkey</div>
        </div>
      </div>
      <nav className="nav-mid">
        <a href="#architecture">Architecture</a>
        <a href="#evaluate">Evaluate</a>
        <a href="#proofs">Proofs</a>
        <a href="#integrate">Integrate</a>
      </nav>
      <div className="nav-right">
        <span className="mono tiny muted">status</span>
        <span className="status-ok mono tiny"><Dot state="pass"/> OPERATIONAL</span>
        <a className="btn btn-ghost btn-sm mono" href="https://github.com/bitnormie01/guardian-protocol-hsk" target="_blank" rel="noopener">GitHub ↗</a>
      </div>
    </header>
  );
}

Object.assign(window, { ProofLogger, Integration, Footer, TopNav });
