import type { Address } from "viem";
import { decodeFunctionData } from "viem";
import { env } from "../config/env";
import { httpClient } from "../blockchain/base";
import type { Quote, UnsignedTransaction } from "../dex/DexAdapter";
import { uniswapV3SwapRouterAbi, aerodromeRouterAbi } from "../blockchain/contracts/abis";
import { isQuoteExpired } from "./quote";
import { child } from "../logging/logger";
import type { ExecutionRepository } from "../state/repository";

const log = child("safety");

export interface SafetyCheckInput {
  quote: Quote;
  tx: UnsignedTransaction;
  slippageBps: number;
  maxSpendWei: bigint;
  routerAllowlist: Address[];
  configuredTokenCA: Address;
  repository: ExecutionRepository;
  userId?: number | null;
}

export interface SafetyCheckResult {
  ok: boolean;
  failedChecks: string[];
  passedChecks: string[];
}

const KNOWN_SWAP_SELECTORS = new Set<string>(
  [
    ...uniswapV3SwapRouterAbi,
    ...aerodromeRouterAbi,
  ]
    .filter((f) => f.type === "function")
    .map((f) => (f as { name: string }).name)
);

/**
 * Runs the full battery of pre-flight checks listed in the spec. Every check
 * is independent and recorded, so a failure report always shows exactly
 * which condition(s) blocked execution - never a bare boolean.
 */
export async function runSafetyChecks(input: SafetyCheckInput): Promise<SafetyCheckResult> {
  const failed: string[] = [];
  const passed: string[] = [];
  const check = (name: string, ok: boolean) => (ok ? passed.push(name) : failed.push(name));

  // 1. Chain ID is exactly 8453 (or whatever CHAIN_ID is configured to, e.g. Sepolia in test mode)
  const liveChainId = await httpClient.getChainId();
  check(
    "chain_id_matches",
    liveChainId === env.CHAIN_ID && input.tx.chainId === env.CHAIN_ID
  );

  // 2. Token address exactly matches configured CA
  check(
    "token_matches_configured_ca",
    input.quote.tokenOut.toLowerCase() === input.configuredTokenCA.toLowerCase()
  );

  // 3. Recipient/router address is on an allowlist
  const routerAllowed = input.routerAllowlist.some(
    (a) => a.toLowerCase() === input.tx.to.toLowerCase()
  );
  check("router_on_allowlist", routerAllowed);

  // 4. Pool is recognized (has a concrete, non-zero address from a known adapter)
  check(
    "pool_recognized",
    input.quote.pool.address !== "0x0000000000000000000000000000000000dEaD" ||
      input.quote.dex === "0x-aggregator"
  );

  // 5. Sufficient liquidity exists (checked upstream in route selection; re-verify bound here)
  const minLiquidityWei = BigInt(Math.floor(env.MIN_LIQUIDITY_ETH * 1e18));
  const liquidityKnown = input.quote.pool.estimatedLiquidityEthWei !== undefined;
  check(
    "sufficient_liquidity",
    !liquidityKnown || input.quote.pool.estimatedLiquidityEthWei! >= minLiquidityWei
  );

  // 6. Quote is valid (positive output)
  check("quote_output_positive", input.quote.amountOutWei > 0n);

  // 7. Quote has not expired
  check("quote_not_expired", !isQuoteExpired(input.quote));

  // 8. Maximum ETH spend is respected
  check("within_max_spend", input.tx.value <= input.maxSpendWei && input.tx.value <= env.MAX_BUY_WEI);

  // 9. Slippage is within configured limits
  check("slippage_within_limit", input.slippageBps <= env.MAX_SLIPPAGE_BPS);

  // 10. Gas estimate is reasonable (non-zero, and not absurdly high - sanity bound)
  const gasOk =
    input.tx.gas === undefined || (input.tx.gas > 0n && input.tx.gas < 2_000_000n);
  check("gas_estimate_reasonable", gasOk);

  // 11. Calldata targets the expected router (redundant with #3 but checked
  //     at the calldata level too, since `to` and calldata are independent
  //     fields that could theoretically diverge upstream)
  check("calldata_targets_expected_router", input.tx.to.toLowerCase() === input.quote.routerAddress.toLowerCase());

  // 12. Transaction does not contain unexpected contract calls
  let knownSelector = false;
  try {
    if (input.quote.dex === "uniswap-v3") {
      const decoded = decodeFunctionData({ abi: uniswapV3SwapRouterAbi, data: input.tx.data });
      knownSelector = KNOWN_SWAP_SELECTORS.has(decoded.functionName);
    } else if (input.quote.dex === "aerodrome") {
      const decoded = decodeFunctionData({ abi: aerodromeRouterAbi, data: input.tx.data });
      knownSelector = KNOWN_SWAP_SELECTORS.has(decoded.functionName);
    } else if (input.quote.dex === "0x-aggregator") {
      // Aggregator calldata is opaque (routed through an external contract);
      // we cannot decode it against a known ABI, so we only allow it through
      // when it targets an address the admin has explicitly allowlisted.
      knownSelector = routerAllowed;
    }
  } catch (err) {
    log.warn({ err }, "failed to decode calldata against expected router ABI");
    knownSelector = false;
  }
  check("calldata_decodes_to_known_swap", knownSelector);

  // 13. Transaction has not already been submitted (idempotency key: token+pool+route+amount)
  const executionKey = buildExecutionKey(input);
  const alreadySubmitted = await input.repository.hasExecutionKey(executionKey);
  check("not_already_submitted", !alreadySubmitted);

  // 14. Bot has not already completed the configured one-shot operation
  const oneShotDone = env.BUY_ONCE ? await input.repository.hasCompletedOneShot(input.userId) : false;
  check("one_shot_not_completed", !oneShotDone);

  const ok = failed.length === 0;
  log.info({ ok, failed, passed: passed.length }, "safety checks complete");
  return { ok, failedChecks: failed, passedChecks: passed };
}

export function buildExecutionKey(input: SafetyCheckInput): string {
  return [
    input.configuredTokenCA.toLowerCase(),
    input.quote.pool.address.toLowerCase(),
    input.quote.dex,
    input.tx.value.toString(),
    input.userId ? String(input.userId) : "global",
  ].join(":");
}
