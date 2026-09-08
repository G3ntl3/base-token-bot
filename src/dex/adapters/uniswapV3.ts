import { encodeFunctionData, type Address } from "viem";
import { httpClient } from "../../blockchain/base";
import {
  uniswapV3FactoryAbi,
  uniswapV3PoolAbi,
  uniswapV3QuoterAbi,
  uniswapV3SwapRouterAbi,
} from "../../blockchain/contracts/abis";
import { UNISWAP_V3_BASE, WETH_BASE } from "../discovery/known-addresses";
import { env } from "../../config/env";
import { child } from "../../logging/logger";
import type {
  DexAdapter,
  Pool,
  Quote,
  QuoteParams,
  SwapParams,
  UnsignedTransaction,
} from "../DexAdapter";

const log = child("dex:uniswap-v3");

export class UniswapV3Adapter implements DexAdapter {
  public readonly name = "uniswap-v3";
  public readonly routerAddress = UNISWAP_V3_BASE.swapRouter02;

  async discoverPools(token: Address): Promise<Pool[]> {
    const pools: Pool[] = [];

    for (const fee of UNISWAP_V3_BASE.feeTiers) {
      try {
        const poolAddress = (await httpClient.readContract({
          address: UNISWAP_V3_BASE.factory,
          abi: uniswapV3FactoryAbi,
          functionName: "getPool",
          args: [token, WETH_BASE, fee],
        })) as Address;

        if (poolAddress === "0x0000000000000000000000000000000000000000") continue;

        const [token0, token1, liquidity] = await Promise.all([
          httpClient.readContract({ address: poolAddress, abi: uniswapV3PoolAbi, functionName: "token0" }),
          httpClient.readContract({ address: poolAddress, abi: uniswapV3PoolAbi, functionName: "token1" }),
          httpClient.readContract({ address: poolAddress, abi: uniswapV3PoolAbi, functionName: "liquidity" }),
        ]);

        if ((liquidity as bigint) === 0n) {
          log.debug({ poolAddress, fee }, "pool exists but has zero active liquidity");
          continue;
        }

        pools.push({
          dex: this.name,
          address: poolAddress,
          token0: token0 as Address,
          token1: token1 as Address,
          concentrated: true,
          feeBps: fee / 100, // fee is in hundredths of a bip; /100 -> bps
          raw: { liquidity },
        });
      } catch (err) {
        log.debug({ err, fee }, "no pool at this fee tier or read failed");
      }
    }

    return pools;
  }

  async getQuote(params: QuoteParams): Promise<Quote> {
    const { pool, tokenIn, tokenOut, amountInWei } = params;
    if (pool.feeBps === undefined) {
      throw new Error("Uniswap V3 pool missing fee tier for quoting");
    }
    const feeUnits = pool.feeBps * 100;

    const result = await httpClient.simulateContract({
      address: UNISWAP_V3_BASE.quoterV2,
      abi: uniswapV3QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          amountIn: amountInWei,
          fee: feeUnits,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

    const [amountOut, , , gasEstimate] = result.result as readonly [bigint, bigint, number, bigint];

    return {
      dex: this.name,
      pool,
      tokenIn,
      tokenOut,
      amountInWei,
      amountOutWei: amountOut,
      expiresAt: Date.now() + env.QUOTE_TTL_SECONDS * 1000,
      gasEstimate,
      routerAddress: this.routerAddress,
    };
  }

  async buildSwapTransaction(params: SwapParams): Promise<UnsignedTransaction> {
    const { quote, recipient, slippageBps } = params;
    if (quote.pool.feeBps === undefined) {
      throw new Error("Uniswap V3 pool missing fee tier for swap build");
    }
    const feeUnits = quote.pool.feeBps * 100;

    const amountOutMinimum = applySlippageFloor(quote.amountOutWei, slippageBps);

    const data = encodeFunctionData({
      abi: uniswapV3SwapRouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: quote.tokenIn,
          tokenOut: quote.tokenOut,
          fee: feeUnits,
          recipient,
          amountIn: quote.amountInWei,
          amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

    return {
      chainId: env.CHAIN_ID,
      to: this.routerAddress,
      data,
      // Native ETH input: SwapRouter02 wraps to WETH internally when tokenIn
      // is WETH and `value` is sent; this bot only ever routes ETH -> token.
      value: quote.amountInWei,
    };
  }
}

/** floor(amountOut * (10000 - slippageBps) / 10000) using pure integer math. */
export function applySlippageFloor(amountOut: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.trunc(slippageBps));
  return (amountOut * (10_000n - bps)) / 10_000n;
}
