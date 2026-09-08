import type { Address, Hex } from "viem";

export interface Pool {
  dex: string;
  address: Address;
  token0: Address;
  token1: Address;
  /** True if the pool is a concentrated-liquidity (V3-style) pool. */
  concentrated: boolean;
  /** Rough liquidity estimate in wei-of-ETH terms, when computable. */
  estimatedLiquidityEthWei?: bigint;
  /** Fee tier in basis points, if applicable (e.g. 3000 = 0.3% for a V3 pool). */
  feeBps?: number;
  raw?: unknown;
}

export interface QuoteParams {
  pool: Pool;
  tokenIn: Address;
  tokenOut: Address;
  amountInWei: bigint;
}

export interface Quote {
  dex: string;
  pool: Pool;
  tokenIn: Address;
  tokenOut: Address;
  amountInWei: bigint;
  amountOutWei: bigint;
  /** Unix ms timestamp after which this quote must be treated as stale. */
  expiresAt: number;
  gasEstimate?: bigint;
  routerAddress: Address;
}

export interface SwapParams {
  quote: Quote;
  recipient: Address;
  slippageBps: number;
  deadlineSeconds: number;
}

export interface UnsignedTransaction {
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce?: number;
}

export interface DexAdapter {
  name: string;
  /** The router address this adapter would target, for allowlist checks. */
  routerAddress: Address;
  discoverPools(token: Address): Promise<Pool[]>;
  getQuote(params: QuoteParams): Promise<Quote>;
  buildSwapTransaction(params: SwapParams): Promise<UnsignedTransaction>;
}
