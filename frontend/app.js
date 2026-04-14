import {
  normalizePipelineResult,
  normalizeSingleAnalyzerResult,
} from './ui-adapter.js';

document.addEventListener('DOMContentLoaded', () => {
  // Tab logic
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  const resultsPanel = document.getElementById('results-panel');
  const fullPipelineScores = document.getElementById('full-pipeline-scores');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // Deactivate all
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.add('hidden'));
      resultsPanel.classList.add('hidden');
      
      // Activate target
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-target');
      document.getElementById(targetId).classList.remove('hidden');
    });
  });

  // UI Element Refs for Output
  const verdictBanner = document.getElementById('verdict-banner');
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
  let latestRequestId = 0;

  // Helper for requests
  async function handleRequest(formId, endpoint, payloadMapper, mode) {
    const form = document.getElementById(formId);
    if (!form) return;
    
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const submitBtn = form.querySelector('button[type="submit"]');
      const loader = form.querySelector('.loader');
      
      submitBtn.disabled = true;
      loader.classList.remove('hidden');
      resultsPanel.classList.add('hidden');
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

        if (response.ok) {
          console.log(`[Guardian UI] ${mode} raw response`, data);
          renderResults(data, mode);
        } else {
          renderError(data.error || 'Evaluation Failed');
        }
      } catch (error) {
        if (requestId !== latestRequestId) return;
        renderError(error.message);
      } finally {
        submitBtn.disabled = false;
        loader.classList.add('hidden');
      }
    });
  }

  // 1. Full Pipeline
  handleRequest('form-pipeline', '/api/evaluate', (f) => ({
    tokenIn: f.tokenIn.value.trim(),
    tokenOut: f.tokenOut.value.trim(),
    amountRaw: f.amountRaw.value.trim(),
    userAddress: f.userAddress.value.trim(),
    proposedTxHex: f.proposedTxHex.value.trim() || undefined,
    proposedTxTarget: f.proposedTxTarget.value.trim() || undefined,
    chainId: parseInt(f.chainId.value.trim(), 10)
  }), 'pipeline');

  // 2. Token Risk
  handleRequest('form-token', '/api/scan', (f) => ({
    tokenAddress: f.tokenAddress.value.trim(),
    chainId: parseInt(f.chainId.value.trim(), 10)
  }), 'token');

  // 3. TX Simulation
  handleRequest('form-sim', '/api/simulate', (f) => ({
    proposedTxHex: f.proposedTxHex.value.trim(),
    userAddress: f.userAddress.value.trim(),
    targetAddress: f.targetAddress.value.trim(),
    chainId: parseInt(f.chainId.value.trim(), 10)
  }), 'simulate');

  // 4. MEV Detection
  handleRequest('form-mev', '/api/mev', (f) => ({
    tokenIn: f.tokenIn.value.trim(),
    tokenOut: f.tokenOut.value.trim(),
    estimatedTradeUsd: parseInt(f.estimatedTradeUsd.value.trim(), 10),
    chainId: parseInt(f.chainId.value.trim(), 10)
  }), 'mev');

  // 5. AMM Pool
  handleRequest('form-amm', '/api/amm', (f) => ({
    poolAddress: f.poolAddress.value.trim(),
    estimatedTradeUsd: parseInt(f.estimatedTradeUsd.value.trim(), 10),
    chainId: parseInt(f.chainId.value.trim(), 10)
  }), 'amm');

  function resetAnalyzerCards() {
    analyzerCards.token.textContent = '--';
    analyzerCards.sim.textContent = '--';
    analyzerCards.mev.textContent = '--';
    analyzerCards.amm.textContent = '--';
  }

  function renderResults(data, mode) {
    if (data.error) return renderError(data.error);

    resultsPanel.classList.remove('hidden');
    const isPipeline = mode === 'pipeline';
    fullPipelineScores.classList.toggle('hidden', !isPipeline);

    if (isPipeline) {
      const viewModel = normalizePipelineResult(data);

      verdictBanner.className = 'verdict-banner ' + viewModel.verdictTone;
      verdictText.textContent = viewModel.verdictText;
      verdictScore.textContent = viewModel.verdictScore;

      analyzerCards.token.textContent =
        viewModel.analyzerScores.tokenRisk ?? '--';
      analyzerCards.sim.textContent =
        viewModel.analyzerScores.txSimulation ?? '--';
      analyzerCards.mev.textContent =
        viewModel.analyzerScores.mevRisk ?? '--';
      analyzerCards.amm.textContent =
        viewModel.analyzerScores.ammPoolRisk ?? '--';

      renderFlags(viewModel.flags);
      return;
    }

    resetAnalyzerCards();
    const viewModel = normalizeSingleAnalyzerResult(mode, data);
    verdictBanner.className = 'verdict-banner ' + viewModel.verdictTone;
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
        li.className = `flag-item ${f.severity || 'info'}`;
        let colorMap = {
          'critical': 'var(--danger)',
          'high': 'var(--danger)',
          'medium': 'var(--warning)',
          'low': 'var(--text-bright)',
          'info': 'var(--text-bright)'
        };
        li.innerHTML = `
          <div class="flag-code" style="color: ${colorMap[f.severity] || '#fff'}">${f.severity.toUpperCase()} | ${f.code}</div>
          <div class="flag-message">${f.message}</div>
          ${f.source ? `<div class="flag-source">Source: ${f.source}</div>` : ''}
        `;
        flagsList.appendChild(li);
      });
    } else {
      flagsList.innerHTML = '<li class="flag-item info">No flags returned by Guardian.</li>';
    }
  }

  function renderError(msg) {
    alert("Error: " + msg);
  }
});
