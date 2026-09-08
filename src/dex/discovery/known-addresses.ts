import { getAddress, type Address } from "viem";

/**
 * These are the publicly documented contract addresses for the two most
 * established Base Mainnet DEX venues as of the last time this file was
 * reviewed:
 *
 *  - Uniswap V3 on Base (same addresses as Uniswap's other deterministic
 *    deployments): https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments
 *  - Aerodrome Finance on Base: https://aerodrome.finance/security  (contracts page)
 *
 * IMPORTANT: contract addresses can change if a protocol migrates or
 * redeploys. Before running against real funds, re-verify every address
 * below against the protocol's current official documentation and cross
 * check on Basescan, then override via environment variables if anything
 * has changed. Nothing here is invented — but "documented at the time this
 * was written" is not the same guarantee as "correct forever."
 */

export const WETH_BASE: Address = getAddress("0x4200000000000000000000000000000000000006");

export const UNISWAP_V3_BASE = {
  factory: getAddress("0x33128a8fC17869897dcE68Ed026d694621f6FDfD"),
  quoterV2: getAddress("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"),
  swapRouter02: getAddress("0x2626664c2603336E57B271c5C0b26F421741e481"),
  // Standard V3 fee tiers to probe when discovering pools, in hundredths of a bip.
  feeTiers: [100, 500, 3000, 10000] as const,
};

export const AERODROME_BASE = {
  factory: getAddress("0x420DD381b31aEf6683db6B902084cB0FFECe40Da"),
  router: getAddress("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"),
};

export const ZEROX_API_BASE_URL = "https://api.0x.org";
