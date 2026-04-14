function formatScore(score) {
  return Number.isFinite(score) ? String(score) : "--";
}

export function classifyGuardianTier(score) {
  if (!Number.isFinite(score)) return "UNKNOWN";
  if (score >= 90) return "SAFE";
  if (score >= 70) return "MODERATE";
  if (score >= 50) return "CAUTION";
  if (score >= 30) return "DANGEROUS";
  return "CRITICAL";
}

function toneForTier(tier) {
  if (tier === "SAFE" || tier === "MODERATE") return "approved";
  if (tier === "CAUTION") return "caution";
  return "blocked";
}

export function normalizePipelineResult(response) {
  const safetyScore = response?.safetyScore ?? {};
  const breakdown = safetyScore.breakdown ?? {};
  const overall = safetyScore.overall;
  const tier = safetyScore.tier ?? classifyGuardianTier(overall);
  const isSafeToExecute = response?.isSafeToExecute === true;

  return {
    verdictTone: isSafeToExecute ? "approved" : "blocked",
    verdictText: isSafeToExecute ? "APPROVED" : "BLOCKED",
    verdictScore: `Score: ${formatScore(overall)}/100 (${tier}) | isSafeToExecute: ${String(response?.isSafeToExecute === true)}`,
    analyzerScores: {
      tokenRisk: breakdown.tokenRisk,
      txSimulation: breakdown.txSimulation,
      mevRisk: breakdown.mevRisk,
      ammPoolRisk: breakdown.ammPoolRisk,
    },
    flags: Array.isArray(response?.flags) ? response.flags : [],
  };
}

export function normalizeSingleAnalyzerResult(mode, response) {
  const flags = Array.isArray(response?.flags) ? response.flags : [];

  if (mode === "token") {
    const overall = response?.safetyScore?.overall;
    const tier = response?.safetyScore?.tier ?? classifyGuardianTier(overall);
    const isSafe = response?.isSafe === true;

    return {
      verdictTone: isSafe ? "approved" : toneForTier(tier),
      verdictText: `TOKEN SCAN: ${tier}`,
      verdictScore: `Score: ${formatScore(overall)}/100 (${tier}) | isSafe: ${String(isSafe)}`,
      flags,
    };
  }

  if (mode === "simulate") {
    const overall = response?.safetyScore?.overall;
    const tier = classifyGuardianTier(overall);
    const simulationSuccess = response?.simulationSuccess === true;

    return {
      verdictTone: simulationSuccess ? toneForTier(tier) : "blocked",
      verdictText: `TX SIMULATION: ${simulationSuccess ? "SUCCESS" : "REVERTED"}`,
      verdictScore: `Score: ${formatScore(overall)}/100 (${tier}) | simulationSuccess: ${String(simulationSuccess)}`,
      flags,
    };
  }

  if (mode === "mev") {
    const overall = response?.score;
    const tier = classifyGuardianTier(overall);
    const mevRiskLevel =
      typeof response?.data?.mevRiskLevel === "string"
        ? response.data.mevRiskLevel.toUpperCase()
        : null;
    const recommendMevProtection =
      typeof response?.data?.recommendMevProtection === "boolean"
        ? response.data.recommendMevProtection
        : null;

    return {
      verdictTone: toneForTier(tier),
      verdictText: `MEV RISK: ${mevRiskLevel ?? tier}`,
      verdictScore:
        `Score: ${formatScore(overall)}/100 (${tier})` +
        (recommendMevProtection === null
          ? ""
          : ` | recommendMevProtection: ${String(recommendMevProtection)}`),
      flags,
    };
  }

  const overall = response?.score;
  const tier = classifyGuardianTier(overall);

  return {
    verdictTone: toneForTier(tier),
    verdictText: `AMM RISK: ${tier}`,
    verdictScore: `Score: ${formatScore(overall)}/100 (${tier})`,
    flags,
  };
}
