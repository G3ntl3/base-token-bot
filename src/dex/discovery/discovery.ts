import type { Address } from "viem";
import type { DexAdapter, Pool } from "../DexAdapter";
import { UniswapV3Adapter } from "../adapters/uniswapV3";
import { AerodromeAdapter } from "../adapters/aerodrome";
import { ZeroXAggregatorAdapter } from "../adapters/zeroXAggregator";
import { child } from "../../logging/logger";

const log = child("dex-discovery");

/**
 * The full set of adapters the bot knows how to speak to. Adding a new venue
 * means writing a new DexAdapter and adding it here - nothing else assumes a
 * specific DEX. If an adapter isn't listed, the bot will never interact with
 * it, satisfying "never assume a DEX beforehand."
 */
export function buildAdapters(): DexAdapter[] {
  return [new UniswapV3Adapter(), new AerodromeAdapter(), new ZeroXAggregatorAdapter()];
}

export interface DiscoveredPool {
  adapter: DexAdapter;
  pool: Pool;
}

/** Runs pool discovery across every adapter concurrently. */
export async function discoverAllPools(
  token: Address,
  adapters: DexAdapter[] = buildAdapters()
): Promise<DiscoveredPool[]> {
  const results = await Promise.allSettled(
    adapters.map(async (adapter) => {
      const pools = await adapter.discoverPools(token);
      return pools.map((pool) => ({ adapter, pool }));
    })
  );

  const discovered: DiscoveredPool[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      discovered.push(...result.value);
    } else {
      log.warn({ err: result.reason }, "adapter discovery failed, skipping venue");
    }
  }

  log.info(
    { count: discovered.length, venues: [...new Set(discovered.map((d) => d.adapter.name))] },
    "pool discovery complete"
  );
  return discovered;
}
