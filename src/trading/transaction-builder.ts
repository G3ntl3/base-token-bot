import type { Address } from "viem";
import { decodeFunctionData } from "viem";
import { httpClient } from "../blockchain/base";
import { uniswapV3SwapRouterAbi, aerodromeRouterAbi } from "../blockchain/contracts/abis";
import type { DexAdapter, Quote, SwapParams, UnsignedTransaction } from "../dex/DexAdapter";
import { env } from "../config/env";
import { child } from "../logging/logger";

const log = child("transaction-builder");

export interface BuildResult {
  tx: UnsignedTransaction;
  decodedOk: boolean;
  decodedFunctionName?: string;
}

/**
 * Builds the complete unsigned transaction via the winning adapter, fills in
 * gas parameters from the live network, and decodes the calldata back to
 * confirm it matches the swap we intended to build (defense in depth against
 * an adapter bug producing calldata for something else).
 */
export async function buildValidatedTransaction(
  adapter: DexAdapter,
  quote: Quote,
  recipient: Address,
  slippageBps: number,
  deadlineSeconds = 120
): Promise<BuildResult> {
  const swapParams: SwapParams = { quote, recipient, slippageBps, deadlineSeconds };
  const tx = await adapter.buildSwapTransaction(swapParams);

  // Chain ID must always come from our config, never trust the adapter blindly.
  tx.chainId = env.CHAIN_ID;

  // Fill gas parameters from the live network rather than hardcoding.
  const [gasEstimate, feeData] = await Promise.all([
    httpClient
      .estimateGas({ account: recipient, to: tx.to, data: tx.data, value: tx.value })
      .catch((err) => {
        log.error({ err }, "gas estimation failed");
        throw new Error("Gas estimation failed - refusing to mark transaction ready");
      }),
    httpClient.estimateFeesPerGas(),
  ]);

  tx.gas = (gasEstimate * 120n) / 100n; // 20% buffer, integer math
  tx.maxFeePerGas = feeData.maxFeePerGas;
  tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;

  let decodedOk = false;
  let decodedFunctionName: string | undefined;
  try {
    if (quote.dex === "uniswap-v3") {
      const decoded = decodeFunctionData({ abi: uniswapV3SwapRouterAbi, data: tx.data });
      decodedFunctionName = decoded.functionName;
      decodedOk = decoded.functionName === "exactInputSingle";
    } else if (quote.dex === "aerodrome") {
      const decoded = decodeFunctionData({ abi: aerodromeRouterAbi, data: tx.data });
      decodedFunctionName = decoded.functionName;
      decodedOk = decoded.functionName === "swapExactETHForTokens";
    } else if (quote.dex === "0x-aggregator") {
      // Opaque aggregator calldata: cannot decode against a known ABI, so
      // this branch relies entirely on the router allowlist + safety engine.
      decodedOk = true;
      decodedFunctionName = "(opaque aggregator calldata)";
    }
  } catch (err) {
    log.error({ err }, "failed to decode built calldata");
    decodedOk = false;
  }

  return { tx, decodedOk, decodedFunctionName };
}
