/* Main app */

function App() {
  const [tweaksOpen, setTweaksOpen] = React.useState(false);
  const [result, setResult] = React.useState(null);

  // Listen for edit mode from host
  React.useEffect(() => {
    const onMsg = (e) => {
      const d = e.data;
      if (!d || !d.type) return;
      if (d.type === '__activate_edit_mode')   setTweaksOpen(true);
      if (d.type === '__deactivate_edit_mode') setTweaksOpen(false);
    };
    window.addEventListener('message', onMsg);
    // Announce availability AFTER listener is mounted
    window.parent.postMessage({ type: '__edit_mode_available' }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);

  return (
    <>
      <TopNav onTweaks={() => setTweaksOpen(true)} />
      <main className="wrap">
        <Hero />
        <Architecture />
        <EvaluateConsole onResult={setResult} />
        <ProofLogger />
        <Integration />
      </main>
      <Footer />
      <TweaksPanel open={tweaksOpen} onClose={() => setTweaksOpen(false)} />
    </>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
