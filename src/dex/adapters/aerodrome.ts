import { encodeFunctionData, type Address } from "viem";
import { httpClient } from "../../blockchain/base";
import {
  aerodromeFactoryAbi,
  aerodromePoolAbi,
  aerodromeRouterAbi,
} from "../../blockchain/contracts/abis";
import { AERODROME_BASE, WETH_BASE } from "../discovery/known-addresses";
import { env } from "../../config/env";
import { child } from "../../logging/logger";
import { applySlippageFloor } from "./uniswapV3";
import type {
  DexAdapter,
  Pool,
  Quote,
  QuoteParams,
  SwapParams,
  UnsignedTransaction,
} from "../DexAdapter";

const log = child("dex:aerodrome");

export class AerodromeAdapter implements DexAdapter {
  public readonly name = "aerodrome";
  public readonly routerAddress = AERODROME_BASE.router;

  async discoverPools(token: Address): Promise<Pool[]> {
    const pools: Pool[] = [];

    for (const stable of [false, true]) {
      try {
        const poolAddress = (await httpClient.readContract({
          address: AERODROME_BASE.factory,
          abi: aerodromeFactoryAbi,
          functionName: "getPool",
          args: [token, WETH_BASE, stable],
        })) as Address;

        if (poolAddress === "0x0000000000000000000000000000000000000000") continue;

        const [token0, token1, reserves] = await Promise.all([
          httpClient.readContract({ address: poolAddress, abi: aerodromePoolAbi, functionName: "token0" }),
          httpClient.readContract({ address: poolAddress, abi: aerodromePoolAbi, functionName: "token1" }),
          httpClient.readContract({ address: poolAddress, abi: aerodromePoolAbi, functionName: "getReserves" }),
        ]);

        const [reserve0, reserve1] = reserves as readonly [bigint, bigint, bigint];
        const wethReserve = (token0 as Address).toLowerCase() === WETH_BASE.toLowerCase() ? reserve0 : reserve1;

        if (wethReserve === 0n) {
          log.debug({ poolAddress, stable }, "pool exists but has zero WETH reserve");
          continue;
        }

        pools.push({
          dex: this.name,
          address: poolAddress,
          token0: token0 as Address,
          token1: token1 as Address,
          concentrated: false,
          estimatedLiquidityEthWei: wethReserve,
          raw: { stable, reserve0, reserve1 },
        });
      } catch (err) {
        log.debug({ err, stable }, "no pool for this stable flag or read failed");
      }
    }

    return pools;
  }

  async getQuote(params: QuoteParams): Promise<Quote> {
    const { pool, tokenIn, tokenOut, amountInWei } = params;
    const stable = Boolean((pool.raw as { stable?: boolean } | undefined)?.stable);

    const amounts = (await httpClient.readContract({
      address: AERODROME_BASE.router,
      abi: aerodromeRouterAbi,
      functionName: "getAmountsOut",
      args: [
        amountInWei,
        [{ from: tokenIn, to: tokenOut, stable, factory: AERODROME_BASE.factory }],
      ],
    })) as readonly bigint[];

    const amountOut = amounts[amounts.length - 1];

    return {
      dex: this.name,
      pool,
      tokenIn,
      tokenOut,
      amountInWei,
      amountOutWei: amountOut,
      expiresAt: Date.now() + env.QUOTE_TTL_SECONDS * 1000,
      routerAddress: this.routerAddress,
    };
  }

  async buildSwapTransaction(params: SwapParams): Promise<UnsignedTransaction> {
    const { quote, recipient, slippageBps, deadlineSeconds } = params;
    const stable = Boolean((quote.pool.raw as { stable?: boolean } | undefined)?.stable);
    const amountOutMinimum = applySlippageFloor(quote.amountOutWei, slippageBps);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);

    const data = encodeFunctionData({
      abi: aerodromeRouterAbi,
      functionName: "swapExactETHForTokens",
      args: [
        amountOutMinimum,
        [{ from: quote.tokenIn, to: quote.tokenOut, stable, factory: AERODROME_BASE.factory }],
        recipient,
        deadline,
      ],
    });

    return {
      chainId: env.CHAIN_ID,
      to: this.routerAddress,
      data,
      value: quote.amountInWei,
    };
  }
}
