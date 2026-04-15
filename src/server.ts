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
    const {
      tokenIn,
      tokenOut,
      amountRaw,
      amount,
      chainId,
      userAddress,
      proposedTxHex,
      proposedTxTarget,
    } = req.body;
    const normalizedAmountRaw = amountRaw || amount;
    
    if (!tokenIn || !tokenOut || !normalizedAmountRaw || !userAddress) {
      return res.status(400).json({
        error: 'Missing required parameters: tokenIn, tokenOut, amountRaw, userAddress'
      });
    }

    if (proposedTxHex && !proposedTxTarget) {
      return res.status(400).json({
        error: 'proposedTxTarget is required when proposedTxHex is provided'
      });
    }

    console.log(`[API] evaluateTrade requested: ${tokenIn} -> ${tokenOut}`);
    
    const requestArgs = {
      tokenIn,
      tokenOut,
      amountRaw: normalizedAmountRaw,
      userAddress,
      chainId: chainId || 177,
      proposedTxHex,
      proposedTxTarget,
    };

    const result = await evaluateTrade(requestArgs);
    return res.json(result);
  } catch (err: any) {
    console.error("[API] Error in evaluateTrade", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/api/scan', async (req, res) => {
  try {
    const { tokenAddress, chainId } = req.body;
    
    if (!tokenAddress) {
      return res.status(400).json({ error: 'Missing tokenAddress' });
    }

    console.log(`[API] scanToken requested for: ${tokenAddress}`);
    
    const result = await scanToken({ tokenAddress, chainId: chainId || 177 });
    return res.json(result);
  } catch (err: any) {
    console.error("[API] Error in scanToken", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/api/simulate', async (req, res) => {
  try {
    const { proposedTxHex, chainId, userAddress, targetAddress } = req.body;
    if (!proposedTxHex) return res.status(400).json({ error: 'Missing proposedTxHex' });
    const result = await simulateTx({
      proposedTxHex,
      chainId: chainId || 177,
      userAddress: userAddress || "0x0000000000000000000000000000000000000001",
      targetAddress
    });
    return res.json(result);
  } catch (err: any) {
    console.error("[API] Error in simulateTx", err);
    return res.status(500).json({ error: err.message || String(err) });
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
      chainId || 177
    );
    return res.json(result);
  } catch (err: any) {
    console.error("[API] Error in analyzeMEVRisk", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/api/amm', async (req, res) => {
  try {
    const { poolAddress, estimatedTradeUsd, chainId } = req.body;
    if (!poolAddress) return res.status(400).json({ error: 'Missing poolAddress' });
    const result = await analyzeAMMPoolRisk(
      poolAddress,
      estimatedTradeUsd || 1000,
      chainId || 177
    );
    return res.json(result);
  } catch (err: any) {
    console.error("[API] Error in analyzeAMMPoolRisk", err);
    return res.status(500).json({ error: err.message || String(err) });
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
