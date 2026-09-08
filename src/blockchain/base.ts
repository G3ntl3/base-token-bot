import {
  createPublicClient,
  http,
  webSocket,
  fallback,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { env } from "../config/env";
import { child } from "../logging/logger";

const log = child("blockchain");

const chain = env.CHAIN_ID === 8453 ? base : baseSepolia;

/**
 * HTTP client with automatic failover across the primary RPC and any
 * configured fallback URLs. Used for calls that don't need a subscription.
 */
export const httpClient = createPublicClient({
  chain,
  transport: fallback(
    [env.BASE_RPC_URL, ...env.BASE_RPC_FALLBACK_URLS].map((url) =>
      http(url, { retryCount: 3, retryDelay: 500, timeout: 10_000 })
    )
  ),
});

/**
 * WebSocket client used for new-block and log subscriptions. viem's
 * `webSocket` transport reconnects automatically; we additionally wrap
 * subscription setup with our own retry/backoff in monitoring/blockWatcher.ts
 * so an unrecoverable disconnect doesn't silently stop monitoring.
 */
export function createWsClient() {
  return createPublicClient({
    chain,
    transport: webSocket(env.BASE_WS_RPC_URL, {
      reconnect: { attempts: Infinity, delay: 2000 },
      keepAlive: { interval: 15_000 },
    }),
  });
}

export async function verifyChainId(): Promise<void> {
  const onChainId = await httpClient.getChainId();
  if (onChainId !== env.CHAIN_ID) {
    throw new Error(
      `Configured CHAIN_ID=${env.CHAIN_ID} does not match RPC chain id=${onChainId}`
    );
  }
  log.info({ chainId: onChainId }, "chain id verified");
}

export { chain };
