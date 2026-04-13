// ==========================================================================
// Guardian Protocol — GoPlus Token Security Enrichment
// ==========================================================================
//
// The OKX OnchainOS v6 token-scan API returns a single `isRiskToken`
// boolean. While useful for a go/no-go decision, it tells the agent
// NOTHING about WHY a token is dangerous.
//
// This module calls the GoPlus Security API (free, no auth required) to
// fetch granular risk details: honeypot, blacklist, mintable, proxy,
// hidden owner, and more. Each finding produces a precise, actionable
// risk message so the calling agent knows the EXACT threat.
//
// GoPlus Docs: https://docs.gopluslabs.io/
// ==========================================================================

import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// GoPlus Response Types
// ---------------------------------------------------------------------------

/**
 * Subset of GoPlus token_security fields we inspect.
 * GoPlus returns "1" for true, "0" for false (string-encoded booleans).
 */
export interface GoPlusTokenSecurity {
  is_honeypot?: string;
  honeypot_with_same_creator?: string;
  is_blacklisted?: string;
  is_mintable?: string;
  can_take_back_ownership?: string;
  owner_change_balance?: string;
  hidden_owner?: string;
  selfdestruct?: string;
  external_call?: string;
  is_proxy?: string;
  is_open_source?: string;
  is_anti_whale?: string;
  anti_whale_modifiable?: string;
  cannot_buy?: string;
  cannot_sell_all?: string;
  trading_cooldown?: string;
  transfer_pausable?: string;
  personal_slippage_modifiable?: string;
  buy_tax?: string;
  sell_tax?: string;
  holder_count?: string;
  total_supply?: string;
  creator_address?: string;
  owner_address?: string;
  lp_holder_count?: string;
  lp_total_supply?: string;
  is_true_token?: string;
  is_airdrop_scam?: string;
  trust_list?: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Chain ID Mapping (EVM chain ID → GoPlus chain index)
// ---------------------------------------------------------------------------

const GOPLUS_CHAIN_MAP: Record<number, string> = {
  1: "1",           // Ethereum Mainnet
  56: "56",         // BSC
  137: "137",       // Polygon
  42161: "42161",   // Arbitrum
  10: "10",         // Optimism
  43114: "43114",   // Avalanche C-Chain
  8453: "8453",     // Base
  196: "196",       // X Layer Mainnet
  324: "324",       // zkSync Era
  59144: "59144",   // Linea
  534352: "534352", // Scroll
};

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

/**
 * Fetches granular token risk data from GoPlus Security API.
 *
 * This is a FREE, no-auth API. It returns per-field risk booleans
 * like `is_honeypot`, `is_blacklisted`, `is_mintable`, etc.
 *
 * @returns The GoPlus security data, or null if the call fails.
 *          We NEVER let a GoPlus failure block the pipeline — the
 *          OKX `isRiskToken` flag is still authoritative.
 */
export async function fetchGoPlusTokenSecurity(
  tokenAddress: string,
  chainId: number,
): Promise<GoPlusTokenSecurity | null> {
  const goPlusChainId = GOPLUS_CHAIN_MAP[chainId];
  if (!goPlusChainId) {
    logger.debug(
      `[goplus] Chain ${chainId} not supported by GoPlus, skipping enrichment`,
    );
    return null;
  }

  const url = `https://api.gopluslabs.io/api/v1/token_security/${goPlusChainId}?contract_addresses=${tokenAddress.toLowerCase()}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn(`[goplus] HTTP ${response.status} from GoPlus API`);
      return null;
    }

    const json = (await response.json()) as {
      code: number;
      result: Record<string, GoPlusTokenSecurity>;
    };

    if (json.code !== 1) {
      logger.warn(`[goplus] Unexpected response code: ${json.code}`);
      return null;
    }

    const key = tokenAddress.toLowerCase();
    const data = json.result?.[key];
    if (!data) {
      logger.debug(`[goplus] No data for ${tokenAddress} on chain ${chainId}`);
      return null;
    }

    return data;
  } catch (err) {
    // GoPlus enrichment is best-effort — never break the pipeline
    logger.warn(`[goplus] Enrichment failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Risk Reason Builder
// ---------------------------------------------------------------------------

export interface TokenRiskReason {
  /** Short human-readable label for the risk. */
  label: string;
  /** Detailed explanation of the specific threat. */
  detail: string;
  /** Severity: "critical" | "high" | "medium" | "low" */
  severity: "critical" | "high" | "medium" | "low";
}

/**
 * Analyzes GoPlus security data and returns a list of specific,
 * to-the-point risk reasons for why a token is dangerous.
 *
 * Each reason has a clear label and actionable detail message.
 */
export function buildRiskReasons(
  data: GoPlusTokenSecurity,
  tokenAddress: string,
): TokenRiskReason[] {
  const reasons: TokenRiskReason[] = [];
  const isTrue = (v?: string) => v === "1";

  // ── CRITICAL: Honeypot ────────────────────────────────────────────────
  if (isTrue(data.is_honeypot)) {
    reasons.push({
      label: "Honeypot",
      severity: "critical",
      detail:
        `Token ${tokenAddress} is a confirmed honeypot — the contract ` +
        `allows buying but blocks selling. Any funds used to purchase ` +
        `this token will be permanently trapped in the contract.`,
    });
  }

  // ── CRITICAL: Cannot sell all ─────────────────────────────────────────
  if (isTrue(data.cannot_sell_all)) {
    reasons.push({
      label: "Sell restriction",
      severity: "critical",
      detail:
        `Token ${tokenAddress} restricts full sell operations — holders ` +
        `cannot sell their entire balance. This is a common scam technique ` +
        `where the contract allows selling only a fraction of holdings, ` +
        `trapping the rest permanently.`,
    });
  }

  // ── CRITICAL: Cannot buy ──────────────────────────────────────────────
  if (isTrue(data.cannot_buy)) {
    reasons.push({
      label: "Buy disabled",
      severity: "critical",
      detail:
        `Token ${tokenAddress} has buying disabled — the contract ` +
        `currently blocks purchase transactions. This typically means ` +
        `the deployer controls when trading is allowed, a hallmark of ` +
        `pump-and-dump schemes.`,
    });
  }

  // ── HIGH: Blacklist function ──────────────────────────────────────────
  if (isTrue(data.is_blacklisted)) {
    reasons.push({
      label: "Blacklist function",
      severity: "high",
      detail:
        `Token ${tokenAddress} has a blacklist function — the contract ` +
        `owner can freeze any address, making tokens untransferable. ` +
        `The agent's wallet could be blacklisted after purchase, ` +
        `functionally creating a honeypot.`,
    });
  }

  // ── HIGH: Mintable ────────────────────────────────────────────────────
  if (isTrue(data.is_mintable)) {
    reasons.push({
      label: "Unlimited minting",
      severity: "high",
      detail:
        `Token ${tokenAddress} has a mint function — the deployer can ` +
        `create unlimited new tokens at any time, diluting all existing ` +
        `holders to zero value. This is a common rug-pull mechanism.`,
    });
  }

  // ── HIGH: Owner can change balances ───────────────────────────────────
  if (isTrue(data.owner_change_balance)) {
    reasons.push({
      label: "Owner can modify balances",
      severity: "high",
      detail:
        `Token ${tokenAddress} allows the contract owner to directly ` +
        `modify holder balances. The owner can drain any wallet's tokens ` +
        `or inflate their own balance without any trade occurring.`,
    });
  }

  // ── HIGH: Hidden owner ────────────────────────────────────────────────
  if (isTrue(data.hidden_owner)) {
    reasons.push({
      label: "Hidden owner",
      severity: "high",
      detail:
        `Token ${tokenAddress} has a hidden ownership mechanism — the ` +
        `true owner is obscured through a non-standard pattern. This ` +
        `means "ownership renounced" claims may be false, and the ` +
        `deployer may still have privileged control.`,
    });
  }

  // ── HIGH: Can reclaim ownership ───────────────────────────────────────
  if (isTrue(data.can_take_back_ownership)) {
    reasons.push({
      label: "Reclaimable ownership",
      severity: "high",
      detail:
        `Token ${tokenAddress} allows the deployer to reclaim contract ` +
        `ownership even after renouncing it. "Ownership renounced" is ` +
        `a lie — the deployer can re-enable admin functions at will.`,
    });
  }

  // ── HIGH: Self-destruct ───────────────────────────────────────────────
  if (isTrue(data.selfdestruct)) {
    reasons.push({
      label: "Self-destruct",
      severity: "high",
      detail:
        `Token ${tokenAddress} contains a selfdestruct function — the ` +
        `owner can permanently destroy the contract, making all tokens ` +
        `worthless and irrecoverable.`,
    });
  }

  // ── HIGH: Transfer pausable ───────────────────────────────────────────
  if (isTrue(data.transfer_pausable)) {
    reasons.push({
      label: "Transfer pausable",
      severity: "high",
      detail:
        `Token ${tokenAddress} has a pause function — the owner can ` +
        `halt ALL transfers at any time, freezing every holder's tokens. ` +
        `This can be used to lock tokens after a price pump.`,
    });
  }

  // ── HIGH: Personal slippage modifiable ────────────────────────────────
  if (isTrue(data.personal_slippage_modifiable)) {
    reasons.push({
      label: "Per-address tax manipulation",
      severity: "high",
      detail:
        `Token ${tokenAddress} allows the owner to set different tax ` +
        `rates for individual addresses. The owner can silently set a ` +
        `100% tax on the agent's address, draining all value on sell.`,
    });
  }

  // ── HIGH: Airdrop scam ────────────────────────────────────────────────
  if (isTrue(data.is_airdrop_scam)) {
    reasons.push({
      label: "Airdrop scam",
      severity: "high",
      detail:
        `Token ${tokenAddress} is identified as an airdrop scam — tokens ` +
        `were distributed unsolicited to wallets as bait. Interacting ` +
        `with this contract (approve/sell) typically triggers a drainer ` +
        `that steals other tokens from the wallet.`,
    });
  }

  // ── HIGH: Same creator deployed honeypots ─────────────────────────────
  if (isTrue(data.honeypot_with_same_creator)) {
    reasons.push({
      label: "Creator deployed known honeypots",
      severity: "high",
      detail:
        `The deployer of ${tokenAddress} has previously created other ` +
        `tokens flagged as honeypots. This is a strong serial-scammer ` +
        `signal — the same wallet is repeatedly deploying malicious contracts.`,
    });
  }

  // ── MEDIUM: External calls ────────────────────────────────────────────
  if (isTrue(data.external_call)) {
    reasons.push({
      label: "External call in transfer",
      severity: "medium",
      detail:
        `Token ${tokenAddress} makes external contract calls during ` +
        `transfer operations. This can be used to introduce ` +
        `unpredictable behavior, hidden fees, or re-entrancy attacks ` +
        `that only activate under specific conditions.`,
    });
  }

  // ── MEDIUM: Proxy (upgradeable) ───────────────────────────────────────
  if (isTrue(data.is_proxy)) {
    reasons.push({
      label: "Upgradeable proxy contract",
      severity: "medium",
      detail:
        `Token ${tokenAddress} is a proxy contract — the owner can ` +
        `change the contract logic after deployment. A safe token today ` +
        `can be modified into a honeypot tomorrow.`,
    });
  }

  // ── LOW: Not open-source ──────────────────────────────────────────────
  if (data.is_open_source === "0") {
    reasons.push({
      label: "Unverified source code",
      severity: "low",
      detail:
        `Token ${tokenAddress} has not verified its source code on the ` +
        `block explorer. The contract logic cannot be publicly audited, ` +
        `making it impossible to confirm the absence of malicious code.`,
    });
  }

  // ── HIGH TAX checks (GoPlus gives exact percentages) ──────────────────
  const buyTax = parseFloat(data.buy_tax ?? "0") * 100; // GoPlus returns 0-1
  const sellTax = parseFloat(data.sell_tax ?? "0") * 100;

  if (sellTax >= 50) {
    reasons.push({
      label: `Extreme sell tax (${sellTax.toFixed(0)}%)`,
      severity: "critical",
      detail:
        `Token ${tokenAddress} imposes a ${sellTax.toFixed(1)}% sell tax — ` +
        `selling will forfeit more than half the output. This is ` +
        `effectively a honeypot disguised as a tax mechanism.`,
    });
  } else if (sellTax >= 30) {
    reasons.push({
      label: `Predatory sell tax (${sellTax.toFixed(0)}%)`,
      severity: "high",
      detail:
        `Token ${tokenAddress} imposes a ${sellTax.toFixed(1)}% sell tax. ` +
        `Selling will forfeit ~${sellTax.toFixed(0)}% of the output amount, ` +
        `making profitable trading nearly impossible.`,
    });
  }

  if (buyTax >= 50) {
    reasons.push({
      label: `Extreme buy tax (${buyTax.toFixed(0)}%)`,
      severity: "critical",
      detail:
        `Token ${tokenAddress} imposes a ${buyTax.toFixed(1)}% buy tax — ` +
        `more than half of the input amount is taken as tax on purchase. ` +
        `This is effectively theft.`,
    });
  } else if (buyTax >= 30) {
    reasons.push({
      label: `Predatory buy tax (${buyTax.toFixed(0)}%)`,
      severity: "high",
      detail:
        `Token ${tokenAddress} imposes a ${buyTax.toFixed(1)}% buy tax. ` +
        `Buying will forfeit ~${buyTax.toFixed(0)}% of the input amount.`,
    });
  }

  return reasons;
}
