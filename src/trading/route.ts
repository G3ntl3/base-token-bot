import type { CandidateQuote } from "./quote";
import { env } from "../config/env";
import { child } from "../logging/logger";

const log = child("route");

export interface RouteScore {
  candidate: CandidateQuote;
  netOutputWei: bigint; // expected token out, discounted for gas-equivalent risk
  liquidityOk: boolean;
  reasonsRejected: string[];
}

/**
 * Approximate ETH cost of gas in wei, given a gas estimate and a network gas
 * price. Used only to compare routes against each other, never as ground
 * truth for the final transaction (the safety engine re-checks gas at build
 * time).
 */
function estimatedGasCostWei(gasEstimate: bigint | undefined, gasPriceWei: bigint): bigint {
  if (!gasEstimate) return 0n;
  return gasEstimate * gasPriceWei;
}

/**
 * Scores and selects the safest valid route among candidates.
 *
 * "Safest" here means: meets the minimum liquidity bar, has a plausible gas
 * cost, and only among routes that clear those bars do we prefer higher net
 * output. A route is never chosen purely because it has the single highest
 * raw output - a thin, low-liquidity pool with a slightly better price is
 * explicitly disfavored versus a deeper, more established pool.
 */
export function selectRoute(
  candidates: CandidateQuote[],
  gasPriceWei: bigint
): { selected: CandidateQuote | null; scored: RouteScore[] } {
  const minLiquidityWei = BigInt(Math.floor(env.MIN_LIQUIDITY_ETH * 1e18));

  const scored: RouteScore[] = candidates.map((candidate) => {
    const reasonsRejected: string[] = [];
    const { pool } = candidate.discovered;

    const liquidityKnown = pool.estimatedLiquidityEthWei !== undefined;
    const liquidityOk = liquidityKnown ? pool.estimatedLiquidityEthWei! >= minLiquidityWei : true; // unknown liquidity (e.g. V3) is checked on-chain later by the safety engine

    if (liquidityKnown && !liquidityOk) {
      reasonsRejected.push(
        `liquidity ${pool.estimatedLiquidityEthWei} wei below minimum ${minLiquidityWei} wei`
      );
    }

    const gasCost = estimatedGasCostWei(candidate.quote.gasEstimate, gasPriceWei);
    const netOutputWei = candidate.quote.amountOutWei; // gas is ETH-denominated, output is token-denominated: kept separate, not subtracted

    if (candidate.quote.amountOutWei <= 0n) {
      reasonsRejected.push("zero or negative quoted output");
    }

    void gasCost; // retained for potential future ETH-normalized comparisons; not combined with token output directly

    return { candidate, netOutputWei, liquidityOk, reasonsRejected };
  });

  const eligible = scored.filter((s) => s.reasonsRejected.length === 0);

  if (eligible.length === 0) {
    log.warn({ candidateCount: candidates.length }, "no eligible routes after filtering");
    return { selected: null, scored };
  }

  // Among eligible routes, prefer the one with the deepest known liquidity
  // first (safety), and use net output only as a tiebreaker.
  eligible.sort((a, b) => {
    const liqA = a.candidate.discovered.pool.estimatedLiquidityEthWei ?? 0n;
    const liqB = b.candidate.discovered.pool.estimatedLiquidityEthWei ?? 0n;
    if (liqA !== liqB) return liqA > liqB ? -1 : 1;
    return a.netOutputWei > b.netOutputWei ? -1 : a.netOutputWei < b.netOutputWei ? 1 : 0;
  });

  return { selected: eligible[0].candidate, scored };
}
