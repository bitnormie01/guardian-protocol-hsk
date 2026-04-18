/* Shared primitives */

function useTicker(intervalMs = 1000) {
  const [, setN] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setN(n => n + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

function useNow() {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function fmtTime(d) {
  return d.toISOString().slice(11, 19) + 'Z';
}
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// Section frame with corner label
function Section({ id, label, no, children, extra }) {
  return (
    <section id={id} className="sec">
      <div className="sec-rule">
        <span className="sec-no">§ {no}</span>
        <span className="sec-label">{label}</span>
        <span className="sec-line" />
        {extra}
      </div>
      <div className="sec-body">{children}</div>
    </section>
  );
}

// Monospace stat
function Stat({ k, v, sub, big, accent }) {
  return (
    <div className={`stat ${big ? 'stat-big' : ''} ${accent ? 'stat-accent' : ''}`}>
      <div className="stat-k">{k}</div>
      <div className="stat-v">{v}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

// Dot with color
function Dot({ state }) {
  return <span className={`dot dot-${state}`} />;
}

// Severity chip
function TierChip({ tier }) {
  return <span className={`tier tier-${tier.toLowerCase()}`}>{tier}</span>;
}

// Monospace field
function Field({ label, value, onChange, placeholder, hint, mono = true, select, options, readOnly }) {
  return (
    <label className="field">
      <div className="field-label">
        <span>{label}</span>
        {hint && <em>{hint}</em>}
      </div>
      {select ? (
        <select value={value} onChange={e => onChange(e.target.value)}>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input
          type="text"
          value={value}
          readOnly={readOnly}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className={mono ? 'mono' : ''}
        />
      )}
    </label>
  );
}

// Button
function Btn({ children, onClick, variant = 'primary', disabled, size, as }) {
  const Tag = as || 'button';
  return (
    <Tag className={`btn btn-${variant} ${size ? 'btn-' + size : ''}`} onClick={onClick} disabled={disabled}>
      {children}
    </Tag>
  );
}

// Tiny sparkline
function Sparkline({ data, w = 80, h = 20, stroke = 'currentColor' }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const rng = Math.max(1e-9, max - min);
  const path = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / rng) * h;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="spark">
      <path d={path} fill="none" stroke={stroke} strokeWidth="1" />
    </svg>
  );
}

// Horizontal bar meter
function Meter({ value, max = 100, tone = 'accent' }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={`meter meter-${tone}`}>
      <div className="meter-fill" style={{ width: pct + '%' }} />
    </div>
  );
}

Object.assign(window, {
  Section, Stat, Dot, TierChip, Field, Btn, Sparkline, Meter,
  useTicker, useNow, fmtTime, fmtDate,
});
