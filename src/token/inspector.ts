import { type Address, isAddress, getAddress } from "viem";
import { httpClient } from "../blockchain/base";
import { erc20Abi } from "../blockchain/contracts/abis";
import { child } from "../logging/logger";

const log = child("token-inspector");

export interface TokenInfo {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  isContract: true;
}

export class TokenValidationError extends Error {}

export function assertValidAddress(input: string): Address {
  if (!isAddress(input)) {
    throw new TokenValidationError(`"${input}" is not a valid EVM address`);
  }
  return getAddress(input);
}

/** Confirms bytecode exists at the address (i.e. it's a contract, not an EOA). */
export async function assertContractExists(address: Address): Promise<void> {
  const code = await httpClient.getBytecode({ address });
  if (!code || code === "0x") {
    throw new TokenValidationError(
      `No contract bytecode found at ${address} on chain ${await httpClient.getChainId()}`
    );
  }
}

/**
 * Reads standard ERC-20 fields. Individual calls are allowed to fail
 * independently (some tokens omit `name`/`symbol` or use bytes32 instead of
 * string) but decimals/totalSupply failures are treated as fatal since the
 * rest of the system depends on them for amount math.
 */
export async function inspectToken(address: Address): Promise<TokenInfo> {
  await assertContractExists(address);

  const base = { address, abi: erc20Abi } as const;

  const [nameRes, symbolRes, decimals, totalSupply] = await Promise.allSettled([
    httpClient.readContract({ ...base, functionName: "name" }),
    httpClient.readContract({ ...base, functionName: "symbol" }),
    httpClient.readContract({ ...base, functionName: "decimals" }),
    httpClient.readContract({ ...base, functionName: "totalSupply" }),
  ]);

  if (decimals.status === "rejected") {
    throw new TokenValidationError(
      `Contract at ${address} does not implement decimals(): ${decimals.reason}`
    );
  }
  if (totalSupply.status === "rejected") {
    throw new TokenValidationError(
      `Contract at ${address} does not implement totalSupply(): ${totalSupply.reason}`
    );
  }

  const info: TokenInfo = {
    address,
    name: nameRes.status === "fulfilled" ? (nameRes.value as string) : "UNKNOWN",
    symbol: symbolRes.status === "fulfilled" ? (symbolRes.value as string) : "UNKNOWN",
    decimals: Number(decimals.value),
    totalSupply: totalSupply.value as bigint,
    isContract: true,
  };

  log.info({ token: info.address, symbol: info.symbol, decimals: info.decimals }, "token inspected");
  return info;
}
