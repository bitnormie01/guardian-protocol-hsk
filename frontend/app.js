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

  // Helper for requests
  async function handleRequest(formId, endpoint, payloadMapper, hideGrid = false) {
    const form = document.getElementById(formId);
    if (!form) return;
    
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const submitBtn = form.querySelector('button[type="submit"]');
      const loader = form.querySelector('.loader');
      
      submitBtn.disabled = true;
      loader.classList.remove('hidden');
      resultsPanel.classList.add('hidden');
      
      const payload = payloadMapper(form);

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        
        const data = await response.json();
        if (response.ok) {
          if (hideGrid) {
            fullPipelineScores.classList.add('hidden');
          } else {
            fullPipelineScores.classList.remove('hidden');
          }
          // The single analyzers return an AnalyzerResult. The pipeline returns a GuardianEvaluationResponse.
          renderResults(data, hideGrid);
        } else {
          renderError(data.error || 'Evaluation Failed');
        }
      } catch (error) {
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
    amount: f.amount.value.trim(),
    chainId: parseInt(f.chainId.value.trim(), 10)
  }), false);

  // 2. Token Risk
  handleRequest('form-token', '/api/scan', (f) => ({
    tokenAddress: f.tokenAddress.value.trim(),
    chainId: parseInt(f.chainId.value.trim(), 10)
  }), true);

  // 3. TX Simulation
  handleRequest('form-sim', '/api/simulate', (f) => ({
    proposedTxHex: f.proposedTxHex.value.trim(),
    userAddress: f.userAddress.value.trim(),
    targetAddress: f.targetAddress.value.trim(),
    chainId: parseInt(f.chainId.value.trim(), 10)
  }), true);

  // 4. MEV Detection
  handleRequest('form-mev', '/api/mev', (f) => ({
    tokenIn: f.tokenIn.value.trim(),
    tokenOut: f.tokenOut.value.trim(),
    estimatedTradeUsd: parseInt(f.estimatedTradeUsd.value.trim(), 10),
    chainId: parseInt(f.chainId.value.trim(), 10)
  }), true);

  // 5. AMM Pool
  handleRequest('form-amm', '/api/amm', (f) => ({
    poolAddress: f.poolAddress.value.trim(),
    estimatedTradeUsd: parseInt(f.estimatedTradeUsd.value.trim(), 10),
    chainId: parseInt(f.chainId.value.trim(), 10)
  }), true);

  function renderResults(data, isSingleAnalyzer) {
    if (data.error) return renderError(data.error);

    resultsPanel.classList.remove('hidden');

    if (isSingleAnalyzer) {
      const score = data.score !== undefined ? data.score : (data.safetyScore?.overall !== undefined ? data.safetyScore.overall : '--');
      let approved = true;
      if (data.simulationSuccess !== undefined) {
        approved = data.simulationSuccess;
      } else if (data.isSafe !== undefined) {
        approved = data.isSafe;
      } else if (data.hasFatalRisk !== undefined) {
        approved = !data.hasFatalRisk;
      }

      verdictBanner.className = 'verdict-banner ' + (approved ? 'approved' : 'blocked');
      verdictText.textContent = approved ? '✅ PASSED' : '⛔ FAILED';
      verdictScore.textContent = `Score: ${score}/100`;

      renderFlags(data.flags);
    } else {
      // GuardianEvaluationResponse (has isSafeToExecute, safetyScore)
      const isSafeToExecute = data.isSafeToExecute;
      const safetyScore = data.safetyScore;
      const flags = data.flags;

      verdictBanner.className = 'verdict-banner ' + (isSafeToExecute ? 'approved' : 'blocked');
      verdictText.textContent = isSafeToExecute ? '✅ APPROVED' : '⛔ BLOCKED';
      verdictScore.textContent = `Score: ${safetyScore?.overall || 0}/100 (${safetyScore?.tier || 'UNKNOWN'})`;

      const bd = safetyScore?.breakdown || {};
      analyzerCards.token.textContent = bd.tokenRisk !== undefined ? bd.tokenRisk : '--';
      analyzerCards.sim.textContent = bd.txSimulation !== undefined ? bd.txSimulation : '--';
      analyzerCards.mev.textContent = bd.mevRisk !== undefined ? bd.mevRisk : '--';
      analyzerCards.amm.textContent = bd.ammPoolRisk !== undefined ? bd.ammPoolRisk : '--';

      renderFlags(flags);
    }
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
        `;
        flagsList.appendChild(li);
      });
    } else {
      flagsList.innerHTML = '<li class="flag-item info">No flags detected. Looks clean!</li>';
    }
  }

  function renderError(msg) {
    alert("Error: " + msg);
  }
});
