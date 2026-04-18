/* Theme tokens + Tweaks wiring */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accentHue": 75,
  "density": "comfortable",
  "heroVariant": "stream",
  "verdictStyle": "cockpit"
}/*EDITMODE-END*/;

// Expose for editmode + other scripts
window.GP_TWEAKS = { ...TWEAK_DEFAULTS };

function applyTweaks(t) {
  const r = document.documentElement;
  r.style.setProperty('--accent-h', t.accentHue);
  r.dataset.density = t.density;
  r.dataset.heroVariant = t.heroVariant;
  r.dataset.verdictStyle = t.verdictStyle;
}
applyTweaks(window.GP_TWEAKS);

// Tweaks panel (React)
function TweaksPanel({ open, onClose }) {
  const [t, setT] = React.useState(window.GP_TWEAKS);
  const update = (k, v) => {
    const next = { ...t, [k]: v };
    setT(next);
    window.GP_TWEAKS = next;
    applyTweaks(next);
    window.parent.postMessage({ type: '__edit_mode_set_keys', edits: { [k]: v } }, '*');
  };
  if (!open) return null;
  return (
    <div className="tweaks-panel">
      <div className="tweaks-head">
        <span>TWEAKS</span>
        <button onClick={onClose} aria-label="close">×</button>
      </div>
      <div className="tweaks-body">
        <label>
          <span>ACCENT HUE <em>{t.accentHue}°</em></span>
          <input type="range" min="0" max="360" value={t.accentHue}
                 onChange={e => update('accentHue', +e.target.value)} />
          <div className="hue-strip" />
        </label>
        <label>
          <span>DENSITY</span>
          <div className="seg">
            {['comfortable', 'compact'].map(v =>
              <button key={v} className={t.density === v ? 'on' : ''}
                      onClick={() => update('density', v)}>{v}</button>)}
          </div>
        </label>
        <label>
          <span>HERO VARIANT</span>
          <div className="seg">
            {[['stream','stream'],['manifesto','manifesto'],['pipeline','pipeline']].map(([v,l]) =>
              <button key={v} className={t.heroVariant === v ? 'on' : ''}
                      onClick={() => update('heroVariant', v)}>{l}</button>)}
          </div>
        </label>
        <label>
          <span>VERDICT STYLE</span>
          <div className="seg">
            {[['cockpit','cockpit'],['dossier','dossier'],['diff','diff']].map(([v,l]) =>
              <button key={v} className={t.verdictStyle === v ? 'on' : ''}
                      onClick={() => update('verdictStyle', v)}>{l}</button>)}
          </div>
        </label>
      </div>
    </div>
  );
}

Object.assign(window, { TweaksPanel });
