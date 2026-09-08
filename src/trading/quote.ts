import type { Address } from "viem";
import type { DiscoveredPool } from "../dex/discovery/discovery";
import type { Quote } from "../dex/DexAdapter";
import { WETH_BASE } from "../dex/discovery/known-addresses";
import { child } from "../logging/logger";

const log = child("quote");

export interface CandidateQuote {
  discovered: DiscoveredPool;
  quote: Quote;
}

/** Requests a quote from every discovered pool concurrently, tolerating individual failures. */
export async function collectQuotes(
  discoveredPools: DiscoveredPool[],
  tokenAddress: Address,
  amountInWei: bigint
): Promise<CandidateQuote[]> {
  const results = await Promise.allSettled(
    discoveredPools.map(async (discovered) => {
      const quote = await discovered.adapter.getQuote({
        pool: discovered.pool,
        tokenIn: WETH_BASE,
        tokenOut: tokenAddress,
        amountInWei,
      });
      return { discovered, quote };
    })
  );

  const quotes: CandidateQuote[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      quotes.push(r.value);
    } else {
      log.debug({ err: r.reason }, "quote request failed for a candidate pool");
    }
  }
  return quotes;
}

export function isQuoteExpired(quote: Quote): boolean {
  return Date.now() >= quote.expiresAt;
}
