import { randomUUID } from "node:crypto";
import { type Address, getAddress } from "viem";
import { env } from "./config/env";
import { child } from "./logging/logger";
import { inspectToken, type TokenInfo } from "./token/inspector";
import { buildAdapters, discoverAllPools, type DiscoveredPool } from "./dex/discovery/discovery";
import { collectQuotes, type CandidateQuote } from "./trading/quote";
import { selectRoute } from "./trading/route";
import { runSafetyChecks, buildExecutionKey } from "./trading/safety";
import { buildValidatedTransaction } from "./trading/transaction-builder";
import { type TransactionSigner, createSignerFromPrivateKey } from "./trading/signer";
import { ExecutionRepository, type UserWalletRecord } from "./state/repository";
import { httpClient } from "./blockchain/base";
import type { DexAdapter, UnsignedTransaction } from "./dex/DexAdapter";
import { decryptPrivateKey } from "./security/crypto";

const log = child("app");

export interface ReadyTrade {
  executionId: string;
  userId: number | null;
  candidate: CandidateQuote;
  tx: UnsignedTransaction;
  slippageBps: number;
}

export class TradingApp {
  public tokenInfo: TokenInfo | null = null;
  public autobuyEnabled = false;
  public lastReadyTrade: ReadyTrade | null = null;
  public lastReadyTrades = new Map<string, ReadyTrade>();

  constructor(
    public readonly repository: ExecutionRepository,
    public readonly signer: TransactionSigner,
    public tokenAddress: Address = env.TOKEN_CA
  ) {}

  async loadToken(address: Address): Promise<TokenInfo> {
    this.tokenAddress = address;
    this.tokenInfo = await inspectToken(address);
    return this.tokenInfo;
  }

  /**
   * Resolves the signer for a specific user ID. If the user has a registered
   * wallet in the database, decrypts their key and creates a PrivateKeySigner.
   * Otherwise falls back to the default global signer.
   */
  getSignerForUser(userId?: number | null): TransactionSigner {
    if (userId) {
      const userWallet = this.repository.getUserWallet(userId);
      if (userWallet) {
        try {
          const privateKey = decryptPrivateKey(
            userWallet.encryptedPrivateKey,
            userWallet.iv,
            userWallet.authTag,
            env.EFFECTIVE_ENCRYPTION_SECRET
          );
          return createSignerFromPrivateKey(privateKey);
        } catch (err) {
          log.error({ userId, err }, "failed to decrypt private key for user wallet");
          throw new Error("Failed to decrypt your wallet key. Re-register your wallet using /setwallet.");
        }
      }
    }
    return this.signer;
  }

  /**
   * Resolves buy amount in wei for a specific user.
   */
  getBuyAmountWeiForUser(userId?: number | null): bigint {
    if (userId) {
      const userWallet = this.repository.getUserWallet(userId);
      if (userWallet && userWallet.buyAmountEth && userWallet.buyAmountEth > 0) {
        const [whole, frac = ""] = userWallet.buyAmountEth.toString().split(".");
        const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
        return BigInt(whole) * 10n ** 18n + BigInt(fracPadded || "0");
      }
    }
    return env.MAX_BUY_WEI;
  }

  /**
   * Runs discovery and prepares trades for all active registered users,
   * or for a specific user if targetUserId is provided.
   */
  async runCycle(targetUserId?: number): Promise<ReadyTrade | null> {
    const readyTrades = await this.runCycleForAllUsers(targetUserId ? [targetUserId] : undefined);
    return readyTrades.length > 0 ? readyTrades[0] : null;
  }

  /**
   * Runs discovery once across venues, then builds individual ready trades for
   * each user (with their individual buy amounts and recipient addresses).
   */
  async runCycleForAllUsers(targetUserIds?: number[]): Promise<ReadyTrade[]> {
    if (!this.tokenInfo) {
      this.tokenInfo = await inspectToken(this.tokenAddress);
    }

    const discovered: DiscoveredPool[] = await discoverAllPools(this.tokenAddress, buildAdapters());
    if (discovered.length === 0) {
      log.debug("no pools discovered yet");
      return [];
    }

    // Determine target users
    let targets: (number | null)[] = [];
    if (targetUserIds && targetUserIds.length > 0) {
      targets = targetUserIds;
    } else {
      const registeredWallets = this.repository.getAllUserWallets();
      if (registeredWallets.length > 0) {
        targets = registeredWallets.map((w) => w.userId);
      } else {
        targets = [null]; // Global fallback signer
      }
    }

    const gasPrice = await httpClient.getGasPrice();
    const readyTrades: ReadyTrade[] = [];

    for (const userId of targets) {
      try {
        const spendWei = this.getBuyAmountWeiForUser(userId);
        const candidates = await collectQuotes(discovered, this.tokenAddress, spendWei);
        if (candidates.length === 0) {
          log.debug({ userId }, "no quotes obtainable from discovered pools");
          continue;
        }

        const { selected } = selectRoute(candidates, gasPrice);
        if (!selected) {
          log.debug({ userId }, "no route passed route-selection filtering");
          continue;
        }

        let recipientAddress: Address;
        if (userId) {
          const w = this.repository.getUserWallet(userId);
          recipientAddress = w ? getAddress(w.address) : ((await this.signer.getAddress()) ?? env.TOKEN_CA);
        } else {
          recipientAddress = (await this.signer.getAddress()) ?? env.TOKEN_CA;
        }

        const built = await buildValidatedTransaction(
          selected.discovered.adapter,
          selected.quote,
          recipientAddress,
          env.MAX_SLIPPAGE_BPS
        );

        if (!built.decodedOk) {
          log.warn({ dex: selected.quote.dex, userId }, "built transaction failed calldata self-check, discarding");
          continue;
        }

        const executionId = randomUUID();
        const executionKey = buildExecutionKey({
          quote: selected.quote,
          tx: built.tx,
          slippageBps: env.MAX_SLIPPAGE_BPS,
          maxSpendWei: spendWei,
          routerAllowlist: this.resolveRouterAllowlist(),
          configuredTokenCA: this.tokenAddress,
          repository: this.repository,
          userId,
        });

        const safety = await runSafetyChecks({
          quote: selected.quote,
          tx: built.tx,
          slippageBps: env.MAX_SLIPPAGE_BPS,
          maxSpendWei: spendWei,
          routerAllowlist: this.resolveRouterAllowlist(),
          configuredTokenCA: this.tokenAddress,
          repository: this.repository,
          userId,
        });

        if (!safety.ok) {
          log.warn({ failed: safety.failedChecks, userId }, "safety checks failed, trade not marked ready");
          continue;
        }

        this.repository.createExecution(executionId, this.tokenAddress, userId);
        this.repository.transition(executionId, "LIQUIDITY_FOUND", { poolAddress: selected.discovered.pool.address });
        this.repository.transition(executionId, "QUOTE_READY", { route: selected.quote.dex });
        this.repository.transition(executionId, "TRANSACTION_READY", { executionKey });

        const readyTrade: ReadyTrade = {
          executionId,
          userId,
          candidate: selected,
          tx: built.tx,
          slippageBps: env.MAX_SLIPPAGE_BPS,
        };

        this.lastReadyTrades.set(executionId, readyTrade);
        this.lastReadyTrade = readyTrade;
        readyTrades.push(readyTrade);
      } catch (err) {
        log.error({ err, userId }, "failed to prepare trade for user");
      }
    }

    return readyTrades;
  }

  public resolveRouterAllowlist(): Address[] {
    if (env.ROUTER_ALLOWLIST.length > 0) return env.ROUTER_ALLOWLIST;
    return buildAdapters().map((a: DexAdapter) => a.routerAddress);
  }

  /**
   * The manual authorization + broadcast step. This is the ONLY path in the
   * whole app that can move a trade to AUTHORIZED/SUBMITTED and call the
   * signer's signAndSend().
   */
  async authorizeAndSend(
    executionId: string,
    callingUserId?: number
  ): Promise<{ hash: string } | { dryRun: true }> {
    const record = this.repository.getExecution(executionId);
    if (!record || record.state !== "TRANSACTION_READY") {
      throw new Error(`Execution ${executionId} is not in TRANSACTION_READY state`);
    }

    // Verify caller ownership if trade was generated for a specific user
    if (record.userId !== null && callingUserId !== undefined && record.userId !== callingUserId) {
      throw new Error("You are not authorized to execute this trade (it was prepared for another user's wallet).");
    }

    const trade = this.lastReadyTrades.get(executionId) ?? (this.lastReadyTrade?.executionId === executionId ? this.lastReadyTrade : null);
    if (!trade || trade.executionId !== executionId) {
      throw new Error("Execution ID does not match the currently prepared trade; re-run /quote first");
    }

    const { candidate, tx, slippageBps } = trade;
    const effectiveUserId = record.userId ?? callingUserId ?? null;
    const spendWei = this.getBuyAmountWeiForUser(effectiveUserId);
    const userSigner = this.getSignerForUser(effectiveUserId);

    // Re-verify safety fresh immediately before authorization
    const safety = await runSafetyChecks({
      quote: candidate.quote,
      tx,
      slippageBps,
      maxSpendWei: spendWei,
      routerAllowlist: this.resolveRouterAllowlist(),
      configuredTokenCA: this.tokenAddress,
      repository: this.repository,
      userId: effectiveUserId,
    });

    if (!safety.ok) {
      this.repository.transition(executionId, "FAILED");
      throw new Error(`Re-verification failed: ${safety.failedChecks.join(", ")}`);
    }

    this.repository.transition(executionId, "AUTHORIZED");

    if (env.DRY_RUN) {
      await userSigner.signTransaction(tx); // Dry-run: logs only, never broadcasts
      this.repository.transition(executionId, "SUBMITTED", { txHash: "0xDRYRUN" });
      this.repository.transition(executionId, "CONFIRMED");
      return { dryRun: true };
    }

    const { hash } = await userSigner.signAndSend(tx);
    this.repository.transition(executionId, "SUBMITTED", { txHash: hash });
    log.warn({ executionId, hash, userId: effectiveUserId }, "LIVE transaction submitted");
    return { hash };
  }
}
