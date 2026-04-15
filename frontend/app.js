// ==========================================================================
// Guardian Protocol — Frontend Application (HashKey Chain)
// ==========================================================================

import {
  normalizePipelineResult,
  normalizeSingleAnalyzerResult,
} from './ui-adapter.js';

document.addEventListener('DOMContentLoaded', () => {
  // ── Tab Logic ──────────────────────────────────────────────
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  const resultsPanel = document.getElementById('results-panel');
  const fullPipelineScores = document.getElementById('full-pipeline-scores');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.add('hidden'));
      resultsPanel.classList.add('hidden');

      btn.classList.add('active');
      const targetId = btn.getAttribute('data-target');
      document.getElementById(targetId).classList.remove('hidden');
    });
  });

  // ── UI Element Refs ────────────────────────────────────────
  const verdictBanner = document.getElementById('verdict-banner');
  const verdictIcon = document.getElementById('verdict-icon');
  const verdictText = document.getElementById('verdict-text');
  const verdictScore = document.getElementById('verdict-score');

  const analyzerCards = {
    token: document.querySelector('#analyzer-token .score'),
    sim: document.querySelector('#analyzer-sim .score'),
    mev: document.querySelector('#analyzer-mev .score'),
    amm: document.querySelector('#analyzer-amm .score'),
  };

  const flagsList = document.getElementById('flags-list');
  const flagsCount = document.getElementById('flags-count');
  const evalMeta = document.getElementById('eval-meta');
  const metaEvalId = document.getElementById('meta-eval-id');
  const metaDuration = document.getElementById('meta-duration');
  const jsonOutput = document.getElementById('json-output');

  let latestRequestId = 0;
  let lastRawResponse = null;

  // ── JSON Toggle ────────────────────────────────────────────
  const toggleJsonBtn = document.getElementById('toggle-json');
  toggleJsonBtn.addEventListener('click', () => {
    jsonOutput.classList.toggle('hidden');
    toggleJsonBtn.textContent = jsonOutput.classList.contains('hidden')
      ? 'Show Raw JSON'
      : 'Hide Raw JSON';
  });

  // ── Request Handler ────────────────────────────────────────
  async function handleRequest(formId, endpoint, payloadMapper, mode) {
    const form = document.getElementById(formId);
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const submitBtn = form.querySelector('button[type="submit"]');
      const loader = form.querySelector('.loader');
      const btnText = form.querySelector('.btn-text');

      submitBtn.disabled = true;
      loader.classList.remove('hidden');
      if (btnText) btnText.textContent = 'Analyzing...';
      resultsPanel.classList.add('hidden');
      jsonOutput.classList.add('hidden');
      toggleJsonBtn.textContent = 'Show Raw JSON';

      const requestId = ++latestRequestId;
      const payload = payloadMapper(form);

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (requestId !== latestRequestId) return;

        lastRawResponse = data;
        jsonOutput.textContent = JSON.stringify(data, null, 2);

        if (response.ok) {
          renderResults(data, mode);
        } else {
          renderError(data.error || 'Evaluation failed — server returned error.');
        }
      } catch (error) {
        if (requestId !== latestRequestId) return;
        renderError(error.message);
      } finally {
        submitBtn.disabled = false;
        loader.classList.add('hidden');
        if (btnText) {
          const labels = {
            'form-pipeline': 'Analyze Trade',
            'form-token': 'Scan Token',
            'form-sim': 'Simulate TX',
            'form-mev': 'Analyze MEV',
            'form-amm': 'Analyze Pool',
          };
          btnText.textContent = labels[formId] || 'Submit';
        }
      }
    });
  }

  // ── Wire Up Forms ──────────────────────────────────────────

  // 1. Full Pipeline
  handleRequest('form-pipeline', '/api/evaluate', (f) => ({
    tokenIn: f.tokenIn.value.trim(),
    tokenOut: f.tokenOut.value.trim(),
    amountRaw: f.amountRaw.value.trim(),
    userAddress: f.userAddress.value.trim(),
    proposedTxHex: f.proposedTxHex.value.trim() || undefined,
    proposedTxTarget: f.proposedTxTarget.value.trim() || undefined,
    chainId: parseInt(f.chainId.value, 10)
  }), 'pipeline');

  // 2. Token Risk
  handleRequest('form-token', '/api/scan', (f) => ({
    tokenAddress: f.tokenAddress.value.trim(),
    chainId: parseInt(f.chainId.value, 10)
  }), 'token');

  // 3. TX Simulation
  handleRequest('form-sim', '/api/simulate', (f) => ({
    proposedTxHex: f.proposedTxHex.value.trim(),
    userAddress: f.userAddress.value.trim(),
    targetAddress: f.targetAddress.value.trim(),
    chainId: parseInt(f.chainId.value, 10)
  }), 'simulate');

  // 4. MEV Detection
  handleRequest('form-mev', '/api/mev', (f) => ({
    tokenIn: f.tokenIn.value.trim(),
    tokenOut: f.tokenOut.value.trim(),
    estimatedTradeUsd: parseInt(f.estimatedTradeUsd.value.trim(), 10),
    chainId: parseInt(f.chainId.value, 10)
  }), 'mev');

  // 5. AMM Pool
  handleRequest('form-amm', '/api/amm', (f) => ({
    poolAddress: f.poolAddress.value.trim(),
    estimatedTradeUsd: parseInt(f.estimatedTradeUsd.value.trim(), 10),
    chainId: parseInt(f.chainId.value, 10)
  }), 'amm');

  // ── Renderer ───────────────────────────────────────────────

  function resetAnalyzerCards() {
    Object.values(analyzerCards).forEach(el => {
      if (el) el.textContent = '--';
    });
  }

  function getVerdictIcon(tone) {
    if (tone === 'approved') return '✅';
    if (tone === 'blocked') return '⛔';
    if (tone === 'caution') return '⚠️';
    return '⏳';
  }

  function renderResults(data, mode) {
    if (data.error) return renderError(data.error);

    resultsPanel.classList.remove('hidden');
    const isPipeline = mode === 'pipeline';
    fullPipelineScores.classList.toggle('hidden', !isPipeline);

    // Show meta if available
    if (data.meta) {
      evalMeta.classList.remove('hidden');
      metaEvalId.textContent = data.evaluationId || '—';
      metaDuration.textContent = data.meta.evaluationDurationMs
        ? `${data.meta.evaluationDurationMs}ms`
        : '—';
    } else {
      evalMeta.classList.add('hidden');
      metaEvalId.textContent = data.evaluationId || '—';
    }

    if (isPipeline) {
      const viewModel = normalizePipelineResult(data);

      verdictBanner.className = 'verdict-banner ' + viewModel.verdictTone;
      verdictIcon.textContent = getVerdictIcon(viewModel.verdictTone);
      verdictText.textContent = viewModel.verdictText;
      verdictScore.textContent = viewModel.verdictScore;

      analyzerCards.token.textContent = viewModel.analyzerScores.tokenRisk ?? '--';
      analyzerCards.sim.textContent = viewModel.analyzerScores.txSimulation ?? '--';
      analyzerCards.mev.textContent = viewModel.analyzerScores.mevRisk ?? '--';
      analyzerCards.amm.textContent = viewModel.analyzerScores.ammPoolRisk ?? '--';

      renderFlags(viewModel.flags);
      return;
    }

    resetAnalyzerCards();
    const viewModel = normalizeSingleAnalyzerResult(mode, data);
    verdictBanner.className = 'verdict-banner ' + viewModel.verdictTone;
    verdictIcon.textContent = getVerdictIcon(viewModel.verdictTone);
    verdictText.textContent = viewModel.verdictText;
    verdictScore.textContent = viewModel.verdictScore;
    renderFlags(viewModel.flags);
  }

  function renderFlags(flags) {
    flagsList.innerHTML = '';
    flagsCount.textContent = (flags || []).length;

    if (flags && flags.length > 0) {
      flags.forEach(f => {
        const li = document.createElement('li');
        const severity = f.severity || 'info';
        li.className = `flag-item ${severity}`;

        const colorMap = {
          'critical': 'var(--danger)',
          'high': 'var(--danger)',
          'medium': 'var(--warning)',
          'low': 'var(--accent-primary)',
          'info': 'var(--accent-primary)'
        };

        li.innerHTML = `
          <div class="flag-code" style="color: ${colorMap[severity] || '#fff'}">${severity.toUpperCase()} | ${f.code}</div>
          <div class="flag-message">${f.message}</div>
          ${f.source ? `<div class="flag-source">Source: ${f.source}</div>` : ''}
        `;
        flagsList.appendChild(li);
      });
    } else {
      flagsList.innerHTML = '<li class="flag-item info">No risk flags — all clear.</li>';
    }
  }

  function renderError(msg) {
    resultsPanel.classList.remove('hidden');
    fullPipelineScores.classList.add('hidden');
    evalMeta.classList.add('hidden');

    verdictBanner.className = 'verdict-banner blocked';
    verdictIcon.textContent = '💥';
    verdictText.textContent = 'ERROR';
    verdictScore.textContent = msg;

    flagsList.innerHTML = `<li class="flag-item critical">
      <div class="flag-code" style="color: var(--danger)">CRITICAL | EVALUATION_ERROR</div>
      <div class="flag-message">${msg}</div>
    </li>`;
    flagsCount.textContent = '1';
  }
});
