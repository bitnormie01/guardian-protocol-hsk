/* Analyzer console — 5 tabbed forms + working submit */

const TABS = [
  { id: 'full',  label: 'Full Pipeline',  sub: '4-analyzer parallel' },
  { id: 'token', label: 'Token Scan',     sub: 'single-token pre-screen' },
  { id: 'sim',   label: 'TX Simulation',  sub: '8-variant fuzzer' },
  { id: 'mev',   label: 'MEV Detection',  sub: 'toxicity + sandwich' },
  { id: 'amm',   label: 'AMM Pool',       sub: 'multi-protocol discovery' },
];

function ChainSelect({ value, onChange }) {
  return (
    <Field
      label="CHAIN"
      value={value}
      onChange={v => onChange(+v)}
      select
      options={CHAINS.map(c => ({ value: c.id, label: `${c.name} (${c.id})` }))}
    />
  );
}

function FormFull({ onRun }) {
  const [tokenIn, setTokenIn]   = React.useState(SAMPLE_ADDR);
  const [tokenOut, setTokenOut] = React.useState(TOKEN_OUT_DEFAULT);
  const [amount, setAmount]     = React.useState('1000000000000000000');
  const [user, setUser]         = React.useState(USER_ADDR);
  const [txHex, setTxHex]       = React.useState('');
  const [target, setTarget]     = React.useState('');
  const [chain, setChain]       = React.useState(177);

  return (
    <form className="form-grid" onSubmit={e => { e.preventDefault(); onRun({ tokenIn, tokenOut, amount, user, txHex, target, chain }); }}>
      <Field label="TOKEN IN"   value={tokenIn}  onChange={setTokenIn}  placeholder="0x…" hint="ERC-20 address" />
      <Field label="TOKEN OUT"  value={tokenOut} onChange={setTokenOut} placeholder="0x…" hint="ERC-20 address" />
      <Field label="AMOUNT (WEI)" value={amount}  onChange={setAmount}  placeholder="1e18" hint="1.0 token · 18 dec" />
      <Field label="USER"       value={user}     onChange={setUser}     placeholder="0x…" hint="from address" />
      <Field label="TX HEX (OPTIONAL)" value={txHex}  onChange={setTxHex}  placeholder="0x…" hint="proposed calldata" />
      <Field label="TX TARGET"  value={target}   onChange={setTarget}   placeholder="0x…" hint="when tx hex provided" />
      <ChainSelect value={chain} onChange={setChain} />
      <div className="form-cta">
        <Btn>▸ Analyze Trade</Btn>
        <span className="mono tiny muted">Returns structured JSON · isSafeToExecute boolean</span>
      </div>
    </form>
  );
}

function FormToken({ onRun }) {
  const [token, setToken] = React.useState(SAMPLE_ADDR);
  const [chain, setChain] = React.useState(177);
  return (
    <form className="form-grid" onSubmit={e => { e.preventDefault(); onRun({ tokenIn: token, tokenOut: '', amount: '0', chain, _only: 'token' }); }}>
      <Field label="TOKEN ADDRESS" value={token} onChange={setToken} placeholder="0x…" hint="ERC-20" />
      <ChainSelect value={chain} onChange={setChain} />
      <div className="form-cta"><Btn>▸ Scan Token</Btn></div>
    </form>
  );
}

function FormSim({ onRun }) {
  const [txHex, setTxHex] = React.useState('0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000016345785d8a0000');
  const [from, setFrom]   = React.useState(USER_ADDR);
  const [to, setTo]       = React.useState(SAMPLE_ADDR);
  const [chain, setChain] = React.useState(177);
  return (
    <form className="form-grid" onSubmit={e => { e.preventDefault(); onRun({ tokenIn: from, tokenOut: to, amount: '0', chain, txHex, _only: 'sim' }); }}>
      <Field label="PROPOSED TX HEX" value={txHex} onChange={setTxHex} placeholder="0xa9059cbb…" hint="ERC-20 transfer(address,uint256)" />
      <Field label="USER (FROM)" value={from} onChange={setFrom} placeholder="0x…" />
      <Field label="TARGET (TO)" value={to}   onChange={setTo}   placeholder="0x…" />
      <ChainSelect value={chain} onChange={setChain} />
      <div className="form-cta"><Btn>▸ Simulate TX</Btn></div>
    </form>
  );
}

function FormMev({ onRun }) {
  const [tokenIn, setTokenIn]   = React.useState(SAMPLE_ADDR);
  const [tokenOut, setTokenOut] = React.useState(TOKEN_OUT_DEFAULT);
  const [usd, setUsd]           = React.useState('5000');
  const [chain, setChain]       = React.useState(177);
  return (
    <form className="form-grid" onSubmit={e => { e.preventDefault(); onRun({ tokenIn, tokenOut, amount: usd, chain, _only: 'mev' }); }}>
      <Field label="TOKEN IN"  value={tokenIn}  onChange={setTokenIn}  placeholder="0x…" />
      <Field label="TOKEN OUT" value={tokenOut} onChange={setTokenOut} placeholder="0x…" />
      <Field label="TRADE USD" value={usd}      onChange={setUsd}      placeholder="5000" hint="estimated notional" />
      <ChainSelect value={chain} onChange={setChain} />
      <div className="form-cta"><Btn>▸ Analyze MEV</Btn></div>
    </form>
  );
}

function FormAmm({ onRun }) {
  const [pool, setPool] = React.useState(POOL_DEFAULT);
  const [usd, setUsd]   = React.useState('5000');
  const [chain, setChain] = React.useState(177);
  return (
    <form className="form-grid" onSubmit={e => { e.preventDefault(); onRun({ tokenIn: pool, tokenOut: '', amount: usd, chain, _only: 'amm' }); }}>
      <Field label="POOL ADDRESS" value={pool} onChange={setPool} placeholder="0x…" hint="Uniswap V3 on HashKey Chain" />
      <Field label="TRADE USD"    value={usd}  onChange={setUsd}  placeholder="5000" />
      <ChainSelect value={chain} onChange={setChain} />
      <div className="form-cta"><Btn>▸ Analyze Pool</Btn></div>
    </form>
  );
}

function EvaluateConsole({ onResult }) {
  const [tab, setTab] = React.useState('full');
  const [running, setRunning] = React.useState(false);
  const [stream, setStream] = React.useState(null);
  const cancelRef = React.useRef(null);

  function handleRun(inputs) {
    if (cancelRef.current) cancelRef.current();
    setRunning(true);
    const init = { analyzers: {}, flags: [], id: null, inputs };
    setStream(init);
    onResult({ kind: 'start', inputs });
    cancelRef.current = streamEvaluate(inputs, ev => {
      if (ev.kind === 'start') setStream(s => ({ ...s, id: ev.id }));
      else if (ev.kind === 'analyzer') setStream(s => ({ ...s, analyzers: { ...s.analyzers, [ev.key]: ev } }));
      else if (ev.kind === 'flag') setStream(s => ({ ...s, flags: [...s.flags, ev.flag] }));
      else if (ev.kind === 'done') {
        setRunning(false);
        setStream(s => ({ ...s, result: ev.result }));
        onResult({ kind: 'done', result: ev.result, inputs });
      }
    });
  }

  React.useEffect(() => () => cancelRef.current && cancelRef.current(), []);

  const forms = {
    full:  <FormFull onRun={handleRun} />,
    token: <FormToken onRun={handleRun} />,
    sim:   <FormSim onRun={handleRun} />,
    mev:   <FormMev onRun={handleRun} />,
    amm:   <FormAmm onRun={handleRun} />,
  };
  const activeTab = TABS.find(t => t.id === tab);

  return (
    <Section id="evaluate" no="02" label="EVALUATION CONSOLE"
             extra={<span className="mono tiny muted">INTERACTIVE · SIMULATED · RETURNS JSON</span>}>
      <div className="console-tabs">
        {TABS.map(t => (
          <button key={t.id}
                  className={`tab ${tab === t.id ? 'on' : ''}`}
                  onClick={() => setTab(t.id)}>
            <span className="tab-label">{t.label}</span>
            <span className="mono xs muted">{t.sub}</span>
          </button>
        ))}
      </div>

      <div className="console-layout">
        <div className="console-form">
          <div className="form-head">
            <span className="mono tiny muted">▌ REQUEST</span>
            <span className="mono small">{activeTab.label}</span>
          </div>
          {forms[tab]}
        </div>

        <div className="console-panel">
          {/* Verdict panel rendered by parent */}
          {window.VerdictPanel ? <window.VerdictPanel stream={stream} running={running} /> : null}
        </div>
      </div>
    </Section>
  );
}

Object.assign(window, { EvaluateConsole });
