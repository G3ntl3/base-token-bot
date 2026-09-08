import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createWalletClient, http, keccak256, type Hex } from "viem";
import { httpClient, chain } from "../blockchain/base";
import type { UnsignedTransaction } from "../dex/DexAdapter";
import { env } from "../config/env";
import { child } from "../logging/logger";

const log = child("signer");

export interface SignedTransaction {
  rawTransaction: Hex;
  hash: Hex;
}

export interface TransactionSigner {
  /** A short label identifying which signer implementation is active, safe to show in Telegram. */
  readonly mode: "dryrun" | "privatekey";
  signTransaction(tx: UnsignedTransaction): Promise<SignedTransaction>;
  /**
   * Signs AND broadcasts. Split out from signTransaction so callers can
   * decide, at the call site, whether broadcasting is even permitted for
   * this operation (see index.ts / the /authorize flow).
   */
  signAndSend(tx: UnsignedTransaction): Promise<{ hash: Hex }>;
  /** Public address this signer would send from, for /balance etc. Null if none configured. */
  getAddress(): Promise<`0x${string}` | null>;
}

/**
 * Never signs or broadcasts anything. Used whenever DRY_RUN=true (the
 * default) or when SIGNER_MODE=dryrun. This is what makes the rest of the
 * pipeline safely testable end-to-end without touching real funds.
 */
export class DryRunSigner implements TransactionSigner {
  public readonly mode = "dryrun" as const;

  async signTransaction(tx: UnsignedTransaction): Promise<SignedTransaction> {
    log.info({ to: tx.to, value: tx.value.toString() }, "DRY RUN: would sign transaction (no-op)");
    return {
      rawTransaction: "0x" as Hex,
      hash: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
    };
  }

  async signAndSend(tx: UnsignedTransaction): Promise<{ hash: Hex }> {
    log.info({ to: tx.to, value: tx.value.toString() }, "DRY RUN: would broadcast transaction (no-op, nothing sent)");
    return { hash: "0x0" as Hex };
  }

  async getAddress(): Promise<`0x${string}` | null> {
    return null;
  }
}

/**
 * Signs (and, only when explicitly permitted by the caller, broadcasts)
 * transactions using a local private key supplied via the WALLET_PRIVATE_KEY
 * environment variable. This class NEVER reads a key from a Telegram
 * message, the database, or any source other than process env at startup.
 *
 * This signer being configured does NOT bypass DRY_RUN or the safety engine:
 * index.ts only ever calls signAndSend() after (a) DRY_RUN=false, (b) every
 * safety check has passed, and (c) an admin has sent the explicit
 * /authorize <executionId> confirmation for that specific prepared trade.
 * See README "Manual authorization step" for exactly where that gate lives.
 */
export class PrivateKeySigner implements TransactionSigner {
  public readonly mode = "privatekey" as const;
  private readonly account: PrivateKeyAccount;

  constructor(privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey);
    // Never log the key itself, and never log the account object directly
    // (some libraries attach the signing key to it) - only the address.
    log.info({ address: this.account.address }, "PrivateKeySigner initialized");
  }

  async getAddress(): Promise<`0x${string}`> {
    return this.account.address;
  }

  async signTransaction(tx: UnsignedTransaction): Promise<SignedTransaction> {
    const walletClient = createWalletClient({
      account: this.account,
      chain,
      transport: http(env.BASE_RPC_URL),
    });

    const nonce = tx.nonce ?? (await httpClient.getTransactionCount({ address: this.account.address, blockTag: "pending" }));

    const rawTransaction = await walletClient.signTransaction({
      account: this.account,
      chain,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      nonce,
      type: "eip1559",
    });

    // Derive the transaction hash locally (keccak256 of the signed raw
    // transaction bytes) WITHOUT broadcasting anything to the network.
    const hash = keccak256(rawTransaction);

    return { rawTransaction, hash };
  }

  /**
   * The ONLY method in this entire codebase that can put a transaction on
   * chain. Callers must have already confirmed DRY_RUN=false and obtained
   * explicit admin authorization before invoking this.
   */
  async signAndSend(tx: UnsignedTransaction): Promise<{ hash: Hex }> {
    if (env.DRY_RUN) {
      throw new Error(
        "Refusing to broadcast: DRY_RUN=true. Set DRY_RUN=false only after you fully understand the risk."
      );
    }

    const walletClient = createWalletClient({
      account: this.account,
      chain,
      transport: http(env.BASE_RPC_URL),
    });

    log.warn(
      { to: tx.to, value: tx.value.toString(), from: this.account.address },
      "LIVE MODE: broadcasting transaction"
    );

    const hash = await walletClient.sendTransaction({
      account: this.account,
      chain,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      nonce: tx.nonce,
      type: "eip1559",
    });

    return { hash };
  }
}

/** Factory that creates a signer directly from an arbitrary private key. */
export function createSignerFromPrivateKey(privateKey: Hex): TransactionSigner {
  return new PrivateKeySigner(privateKey);
}

/** Factory that reads SIGNER_MODE/DRY_RUN and constructs the appropriate signer. */
export function createSigner(): TransactionSigner {
  if (!env.WALLET_PRIVATE_KEY || env.SIGNER_MODE === "dryrun" || env.DRY_RUN) {
    if (env.WALLET_PRIVATE_KEY && env.SIGNER_MODE === "privatekey" && env.DRY_RUN) {
      log.warn(
        "SIGNER_MODE=privatekey but DRY_RUN=true: a PrivateKeySigner will be constructed " +
          "(so /balance can show your address) but signAndSend() will refuse to broadcast."
      );
      return new PrivateKeySigner(env.WALLET_PRIVATE_KEY as Hex);
    }
    return new DryRunSigner();
  }
  return new PrivateKeySigner(env.WALLET_PRIVATE_KEY as Hex);
}
