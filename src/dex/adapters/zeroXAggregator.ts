import { type Address, getAddress, isAddress, isHex } from "viem";
import { env } from "../../config/env";
import { WETH_BASE, ZEROX_API_BASE_URL } from "../discovery/known-addresses";
import { child } from "../../logging/logger";
import type {
  DexAdapter,
  Pool,
  Quote,
  QuoteParams,
  SwapParams,
  UnsignedTransaction,
} from "../DexAdapter";

const log = child("dex:0x-aggregator");

const NATIVE_ETH_PSEUDO_ADDRESS = getAddress("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE");

/**
 * Wraps the 0x Swap API (https://0x.org/docs/api, chainId 8453 = Base).
 * This is a *route discovery / execution* adapter, not a pool-owning DEX:
 * "pools" here are a synthetic placeholder representing "0x found a route".
 *
 * Disabled entirely unless ZEROX_API_KEY is configured. Its returned router
 * ("to" address / allowance target) is NOT hardcoded here because 0x has
 * changed this address across API versions; the safety engine will reject
 * any transaction whose `to` is not in ROUTER_ALLOWLIST, so an admin must
 * explicitly verify and allowlist 0x's current allowance-holder/router
 * address before this adapter's transactions can ever be marked ready.
 */
export class ZeroXAggregatorAdapter implements DexAdapter {
  public readonly name = "0x-aggregator";
  // Placeholder; the *real* target address is only known once 0x returns a
  // quote, and is validated against the allowlist at that point.
  public routerAddress: Address = "0x0000000000000000000000000000000000dEaD";

  private get enabled(): boolean {
    return env.ZEROX_API_KEY.length > 0;
  }

  async discoverPools(token: Address): Promise<Pool[]> {
    if (!this.enabled) return [];

    try {
      const url = new URL(`${ZEROX_API_BASE_URL}/swap/permit2/price`);
      url.searchParams.set("chainId", String(env.CHAIN_ID));
      url.searchParams.set("sellToken", NATIVE_ETH_PSEUDO_ADDRESS);
      url.searchParams.set("buyToken", token);
      url.searchParams.set("sellAmount", "1000000000000"); // tiny probe amount, wei

      const res = await fetch(url, {
        headers: { "0x-api-key": env.ZEROX_API_KEY, "0x-version": "v2" },
      });
      if (!res.ok) {
        log.debug({ status: res.status }, "0x price probe failed - treating as no route");
        return [];
      }
      const body = (await res.json()) as { liquidityAvailable?: boolean };
      if (!body.liquidityAvailable) return [];

      // Synthetic pool: there is no single pool address for an aggregator.
      return [
        {
          dex: this.name,
          address: getAddress("0x0000000000000000000000000000000000dEaD"),
          token0: WETH_BASE,
          token1: token,
          concentrated: false,
          raw: { aggregator: true },
        },
      ];
    } catch (err) {
      log.warn({ err }, "0x discovery request failed");
      return [];
    }
  }

  async getQuote(params: QuoteParams): Promise<Quote> {
    if (!this.enabled) throw new Error("0x aggregator not configured (ZEROX_API_KEY missing)");
    const { tokenIn, tokenOut, amountInWei } = params;

    const url = new URL(`${ZEROX_API_BASE_URL}/swap/permit2/quote`);
    url.searchParams.set("chainId", String(env.CHAIN_ID));
    url.searchParams.set("sellToken", NATIVE_ETH_PSEUDO_ADDRESS);
    url.searchParams.set("buyToken", tokenOut);
    url.searchParams.set("sellAmount", amountInWei.toString());

    const res = await fetch(url, {
      headers: { "0x-api-key": env.ZEROX_API_KEY, "0x-version": "v2" },
    });
    if (!res.ok) {
      throw new Error(`0x quote request failed with status ${res.status}`);
    }
    const body = (await res.json()) as {
      buyAmount: string;
      transaction: { to: string; data: string; value: string; gas?: string };
    };

    if (!isAddress(body.transaction.to) || !isHex(body.transaction.data)) {
      throw new Error("0x returned a malformed transaction object");
    }

    const routerAddress = getAddress(body.transaction.to);
    this.routerAddress = routerAddress;

    return {
      dex: this.name,
      pool: params.pool,
      tokenIn,
      tokenOut,
      amountInWei,
      amountOutWei: BigInt(body.buyAmount),
      expiresAt: Date.now() + env.QUOTE_TTL_SECONDS * 1000,
      gasEstimate: body.transaction.gas ? BigInt(body.transaction.gas) : undefined,
      routerAddress,
      // stash the raw tx so buildSwapTransaction doesn't need a second call
      // (avoids the quote changing between quote and build)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ __rawTx: body.transaction } as any),
    };
  }

  async buildSwapTransaction(params: SwapParams): Promise<UnsignedTransaction> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (params.quote as any).__rawTx as
      | { to: string; data: string; value: string }
      | undefined;
    if (!raw) {
      throw new Error(
        "0x adapter requires buildSwapTransaction to be called with the exact Quote returned from getQuote (no re-fetch, to avoid quote/tx mismatch)"
      );
    }
    return {
      chainId: env.CHAIN_ID,
      to: getAddress(raw.to),
      data: raw.data as `0x${string}`,
      value: BigInt(raw.value),
    };
  }
}
