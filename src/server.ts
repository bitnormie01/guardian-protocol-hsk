import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config'; // Loads .env
import { evaluateTrade, scanToken, simulateTx } from './index.js';
import { analyzeMEVRisk } from './analyzers/mev-detection.js';
import { analyzeAMMPoolRisk } from './analyzers/amm-pool-analyzer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Serve the frontend assets
app.use(express.static(path.join(__dirname, '../frontend')));

app.post('/api/evaluate', async (req, res) => {
  try {
    const { tokenIn, tokenOut, amount, chainId, userAddress } = req.body;
    
    if (!tokenIn || !tokenOut || !amount) {
      return res.status(400).json({ error: 'Missing required parameters: tokenIn, tokenOut, amount' });
    }

    console.log(`[API] evaluateTrade requested: ${tokenIn} -> ${tokenOut}`);
    
    const requestArgs = {
      tokenIn,
      tokenOut,
      amount,
      userAddress: userAddress || "0x0000000000000000000000000000000000000001",
      chainId: chainId || 196
    };

    const result = await evaluateTrade(requestArgs);
    res.json(result);
  } catch (err: any) {
    console.error("[API] Error in evaluateTrade", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/api/scan', async (req, res) => {
  try {
    const { tokenAddress, chainId } = req.body;
    
    if (!tokenAddress) {
      return res.status(400).json({ error: 'Missing tokenAddress' });
    }

    console.log(`[API] scanToken requested for: ${tokenAddress}`);
    
    const result = await scanToken({ tokenAddress, chainId: chainId || 196 });
    res.json(result);
  } catch (err: any) {
    console.error("[API] Error in scanToken", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/api/simulate', async (req, res) => {
  try {
    const { proposedTxHex, chainId, userAddress, targetAddress } = req.body;
    if (!proposedTxHex) return res.status(400).json({ error: 'Missing proposedTxHex' });
    const result = await simulateTx({
      proposedTxHex,
      chainId: chainId || 196,
      userAddress: userAddress || "0x0000000000000000000000000000000000000001",
      targetAddress
    });
    // wrap the AnalyzerResult so it matches the frontend's renderResults expectation for single analyzer mode
    res.json(result);
  } catch (err: any) {
    console.error("[API] Error in simulateTx", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/api/mev', async (req, res) => {
  try {
    const { tokenIn, tokenOut, estimatedTradeUsd, userAddress, proposedTxHex, chainId } = req.body;
    if (!tokenIn || !tokenOut) return res.status(400).json({ error: 'Missing tokenIn or tokenOut' });
    const result = await analyzeMEVRisk(
      tokenIn,
      tokenOut,
      estimatedTradeUsd || 1000,
      userAddress || "0x0000000000000000000000000000000000000001",
      proposedTxHex,
      chainId || 196
    );
    res.json(result);
  } catch (err: any) {
    console.error("[API] Error in analyzeMEVRisk", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/api/amm', async (req, res) => {
  try {
    const { poolAddress, estimatedTradeUsd, chainId } = req.body;
    if (!poolAddress) return res.status(400).json({ error: 'Missing poolAddress' });
    const result = await analyzeAMMPoolRisk(
      poolAddress,
      estimatedTradeUsd || 1000,
      chainId || 196
    );
    res.json(result);
  } catch (err: any) {
    console.error("[API] Error in analyzeAMMPoolRisk", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 Guardian UI running on http://localhost:${PORT}`);
  });
}

// Export for Vercel Serverless
export default app;
