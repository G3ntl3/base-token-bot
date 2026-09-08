import { Telegraf } from "telegraf";
import { formatEther, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "../config/env";
import { child } from "../logging/logger";
import { createAdminMiddleware, superAdminOnly, isAuthorizedUser } from "./middleware/auth";
import type { TradingApp, ReadyTrade } from "../app";
import { assertValidAddress, TokenValidationError } from "../token/inspector";
import { encryptPrivateKey } from "../security/crypto";
import { httpClient } from "../blockchain/base";

const log = child("telegram");

export function createBot(app: TradingApp): Telegraf {
  const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
  const adminOnly = createAdminMiddleware(app.repository);

  bot.catch((err, ctx) => {
    log.error({ err, updateType: ctx.updateType }, "unhandled telegram error");
  });

  bot.command("start", async (ctx) => {
    const userWallet = ctx.from?.id ? app.repository.getUserWallet(ctx.from.id) : undefined;
    await ctx.reply(
      "Base Token-Launch Sniper Bot.\n\n" +
        `Mode: ${env.DRY_RUN ? "DRY RUN (Simulated, no funds moved)" : "LIVE (Broadcasts real transactions)"}\n` +
        `Your Telegram ID: ${ctx.from?.id}\n` +
        `Connected Wallet: ${userWallet ? userWallet.address : "(None configured - use /setwallet in private DM)"}\n\n` +
        "Use /help to view all available commands."
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "=== Wallet & Multi-User Commands ===",
        "/setwallet <key> - register your private key securely (Private DM only, auto-deleted)",
        "/mywallet - view your connected wallet & settings",
        "/setbuyamount <eth> - set your custom ETH buy amount (e.g. /setbuyamount 0.005)",
        "/removewallet - remove your registered wallet from the bot",
        "/balance - check your wallet ETH balance",
        "",
        "=== Trading & Monitoring Commands ===",
        "/status - view bot and token status",
        "/quote - run discovery & quote cycle for your wallet now",
        "/dryrun - preview your prepared transaction without buying",
        "/authorize <executionId> - authorize your prepared trade for broadcast (admin)",
        "/price - latest quoted price for the target token",
        "",
        "=== Admin & Global Settings ===",
        "/autobuy on|off - toggle automatic background discovery loop (admin)",
        "/setca <address> - change target token contract address (admin)",
        "/reset - clear prepared trades (admin)",
        "/addadmin <userId> - approve a friend's Telegram ID (owner only)",
        "/removeadmin <userId> - revoke a friend's access (owner only)",
      ].join("\n")
    );
  });

  // --- Wallet Management Commands ---

  bot.command("setwallet", async (ctx) => {
    // Strictly enforce private 1-on-1 DM for security
    if (ctx.chat?.type !== "private") {
      try {
        await ctx.deleteMessage();
      } catch {
        // Ignore deletion errors if bot lacks permission
      }
      await ctx.reply(
        "For your security, /setwallet can only be used in a private DM with the bot. Your message in the group was deleted."
      );
      return;
    }

    // Immediately attempt to delete the message containing the private key
    try {
      await ctx.deleteMessage();
    } catch {
      // Best effort deletion
    }

    const parts = ctx.message.text.split(/\s+/);
    const rawKey = parts[1]?.trim();
    if (!rawKey) {
      await ctx.reply(
        "Usage: /setwallet <0x_private_key>\n\n" +
          "Your message will be automatically deleted immediately after sending."
      );
      return;
    }

    const formattedKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(formattedKey)) {
      await ctx.reply("Invalid key format. Must be a 32-byte hex string (64 hex characters).");
      return;
    }

    try {
      const account = privateKeyToAccount(formattedKey);
      const address = account.address;

      const encrypted = encryptPrivateKey(formattedKey, env.EFFECTIVE_ENCRYPTION_SECRET);

      app.repository.upsertUserWallet({
        userId: ctx.from.id,
        address,
        encryptedPrivateKey: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        buyAmountEth: null, // Defaults to env.MAX_BUY_ETH
      });

      // Auto-grant dynamic admin access to anyone who configures their wallet if approved
      if (!isAuthorizedUser(ctx.from.id, app.repository)) {
        app.repository.addDynamicAdmin(ctx.from.id, ctx.from.id);
      }

      const balance = await httpClient.getBalance({ address });

      await ctx.reply(
        "Wallet successfully encrypted and registered!\n\n" +
          `Address: ${address}\n` +
          `Balance: ${formatEther(balance)} ETH\n` +
          `Default Buy Amount: ${env.MAX_BUY_ETH} ETH (change with /setbuyamount)\n\n` +
          "Your message containing the private key was immediately deleted from chat history for secrecy."
      );
    } catch (err) {
      log.error({ err }, "failed to register user wallet");
      await ctx.reply("Failed to register wallet. Please check key validity.");
    }
  });

  bot.command("removewallet", async (ctx) => {
    const deleted = app.repository.deleteUserWallet(ctx.from.id);
    if (deleted) {
      await ctx.reply("Your wallet has been securely deleted from the bot.");
    } else {
      await ctx.reply("You do not have a wallet registered.");
    }
  });

  bot.command("mywallet", async (ctx) => {
    const wallet = app.repository.getUserWallet(ctx.from.id);
    if (!wallet) {
      await ctx.reply("You have not connected a wallet yet. Send /setwallet <key> in a private DM to connect.");
      return;
    }

    try {
      const balance = await httpClient.getBalance({ address: wallet.address as Address });
      await ctx.reply(
        "=== Your Registered Wallet ===\n\n" +
          `Address: ${wallet.address}\n` +
          `Balance: ${formatEther(balance)} ETH\n` +
          `Buy Amount: ${wallet.buyAmountEth ?? `${env.MAX_BUY_ETH} (default)`} ETH\n` +
          `Max Slippage: ${(env.MAX_SLIPPAGE_BPS / 100).toFixed(2)}%\n` +
          `Registered At: ${new Date(wallet.createdAt).toLocaleString()}`
      );
    } catch (err) {
      log.error({ err }, "mywallet balance fetch failed");
      await ctx.reply(`Address: ${wallet.address}\nFailed to fetch balance. Check RPC connection.`);
    }
  });

  bot.command("setbuyamount", async (ctx) => {
    const parts = ctx.message.text.split(/\s+/);
    const amount = Number(parts[1]);
    if (!amount || isNaN(amount) || amount <= 0) {
      await ctx.reply("Usage: /setbuyamount <amount_in_eth> (e.g. /setbuyamount 0.005)");
      return;
    }

    const wallet = app.repository.getUserWallet(ctx.from.id);
    if (!wallet) {
      await ctx.reply("Please register your wallet first using /setwallet <key>.");
      return;
    }

    app.repository.setUserBuyAmount(ctx.from.id, amount);
    await ctx.reply(`Your custom buy amount has been set to ${amount} ETH.`);
  });

  bot.command("balance", async (ctx) => {
    const userWallet = app.repository.getUserWallet(ctx.from.id);
    if (userWallet) {
      try {
        const balance = await httpClient.getBalance({ address: userWallet.address as Address });
        await ctx.reply(`Your Wallet: ${userWallet.address}\nBalance: ${formatEther(balance)} ETH`);
        return;
      } catch (err) {
        log.error({ err }, "balance fetch failed for user wallet");
      }
    }

    // Fallback to global signer address
    const globalAddress = await app.signer.getAddress();
    if (!globalAddress) {
      await ctx.reply("No wallet configured. Use /setwallet <key> in a private DM to register your wallet.");
      return;
    }

    try {
      const balance = await httpClient.getBalance({ address: globalAddress });
      await ctx.reply(`Global Wallet: ${globalAddress}\nBalance: ${formatEther(balance)} ETH`);
    } catch (err) {
      log.error({ err }, "balance check failed");
      await ctx.reply("Failed to fetch balance.");
    }
  });

  // --- Dynamic Admin Management Commands (Super Admin Only) ---

  bot.command("addadmin", superAdminOnly, async (ctx) => {
    const parts = ctx.message.text.split(/\s+/);
    const targetId = Number(parts[1]);
    if (!targetId || isNaN(targetId)) {
      await ctx.reply("Usage: /addadmin <numeric_telegram_user_id>");
      return;
    }

    app.repository.addDynamicAdmin(targetId, ctx.from.id);
    await ctx.reply(`User ${targetId} is now an authorized admin of this bot.`);
  });

  bot.command("removeadmin", superAdminOnly, async (ctx) => {
    const parts = ctx.message.text.split(/\s+/);
    const targetId = Number(parts[1]);
    if (!targetId || isNaN(targetId)) {
      await ctx.reply("Usage: /removeadmin <numeric_telegram_user_id>");
      return;
    }

    const removed = app.repository.removeDynamicAdmin(targetId);
    if (removed) {
      await ctx.reply(`User ${targetId} has been removed from authorized admins.`);
    } else {
      await ctx.reply(`User ${targetId} was not found in dynamic admins.`);
    }
  });

  // --- Target Token & Autobuy Configuration ---

  bot.command("setca", adminOnly, async (ctx) => {
    const parts = ctx.message.text.split(/\s+/);
    const input = parts[1];
    if (!input) {
      await ctx.reply("Usage: /setca <contract_address>");
      return;
    }
    try {
      const address = assertValidAddress(input);
      const info = await app.loadToken(address);
      await ctx.reply(
        `Token set:\n${info.name} (${info.symbol})\n${info.address}\nDecimals: ${info.decimals}`
      );
    } catch (err) {
      if (err instanceof TokenValidationError) {
        await ctx.reply(`Rejected: ${err.message}`);
      } else {
        log.error({ err }, "setca failed");
        await ctx.reply("Failed to load token. Check logs.");
      }
    }
  });

  bot.command("autobuy", adminOnly, async (ctx) => {
    const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
    if (arg !== "on" && arg !== "off") {
      await ctx.reply("Usage: /autobuy on|off");
      return;
    }
    app.autobuyEnabled = arg === "on";
    await ctx.reply(`Autobuy is now ${app.autobuyEnabled ? "ON" : "OFF"}.`);
  });

  bot.command("status", async (ctx) => {
    const t = app.tokenInfo;
    const userWallet = app.repository.getUserWallet(ctx.from.id);
    const userTrade = Array.from(app.lastReadyTrades.values())
      .reverse()
      .find((trade) => trade.userId === ctx.from.id) ?? app.lastReadyTrade;

    await ctx.reply(
      [
        `Mode: ${env.DRY_RUN ? "DRY RUN" : "LIVE"}`,
        `Autobuy: ${app.autobuyEnabled ? "ON" : "OFF"}`,
        `Target Token: ${t ? `${t.symbol} (${t.address})` : env.TOKEN_CA}`,
        `Your Wallet: ${userWallet ? userWallet.address : "(none configured)"}`,
        `Registered Wallets: ${app.repository.getAllUserWallets().length}`,
        userTrade
          ? `Last prepared trade: ${userTrade.executionId} via ${userTrade.candidate.quote.dex}`
          : "No trade currently prepared.",
      ].join("\n")
    );
  });

  bot.command("price", async (ctx) => {
    const trade = app.lastReadyTrade;
    if (!trade) {
      await ctx.reply("No recent quote available. Try /quote first.");
      return;
    }
    const q = trade.candidate.quote;
    await ctx.reply(
      `${q.dex}\nInput: ${formatEther(q.amountInWei)} ETH\nOutput: ${q.amountOutWei.toString()} (raw units)`
    );
  });

  bot.command("quote", async (ctx) => {
    await ctx.reply("Running discovery and quoting cycle for your wallet...");
    try {
      const result = await app.runCycle(ctx.from.id);
      if (!result) {
        await ctx.reply("No tradable route found yet (no liquidity, or it didn't pass safety checks).");
        return;
      }
      await ctx.reply(formatBuyCondition(app, result));
    } catch (err) {
      log.error({ err }, "quote cycle failed");
      await ctx.reply("Quote cycle failed. Check logs for details.");
    }
  });

  bot.command("dryrun", async (ctx) => {
    const trade = Array.from(app.lastReadyTrades.values())
      .reverse()
      .find((t) => t.userId === ctx.from.id) ?? app.lastReadyTrade;

    if (!trade) {
      await ctx.reply("No prepared trade for your wallet. Run /quote first.");
      return;
    }
    await ctx.reply(formatBuyCondition(app, trade));
  });

  bot.command("authorize", adminOnly, async (ctx) => {
    const executionId = ctx.message.text.split(/\s+/)[1];
    if (!executionId) {
      await ctx.reply("Usage: /authorize <executionId>");
      return;
    }
    if (env.DRY_RUN) {
      await ctx.reply(
        "DRY_RUN=true: nothing will be broadcast. This command only has real effect when DRY_RUN=false."
      );
    }
    try {
      const result = await app.authorizeAndSend(executionId, ctx.from.id);
      if ("dryRun" in result) {
        await ctx.reply("DRY RUN authorization complete. No transaction was sent.");
      } else {
        await ctx.reply(`LIVE transaction submitted!\nHash: ${result.hash}`);
      }
    } catch (err) {
      log.error({ err }, "authorize failed");
      await ctx.reply(`Authorization failed: ${(err as Error).message}`);
    }
  });

  bot.command("reset", adminOnly, async (ctx) => {
    app.lastReadyTrades.clear();
    app.lastReadyTrade = null;
    await ctx.reply("Cleared prepared trades (persisted execution history is untouched).");
  });

  return bot;
}

function formatBuyCondition(app: TradingApp, trade: ReadyTrade): string {
  const q = trade.candidate.quote;
  const pool = trade.candidate.discovered.pool;
  const tokenAddr = app.tokenAddress;
  return [
    "BUY CONDITION DETECTED",
    "",
    "Token:",
    tokenAddr,
    "",
    "Network:",
    env.CHAIN_ID === 8453 ? "Base Mainnet" : "Base Sepolia",
    "",
    `DEX: ${q.dex}`,
    "",
    `Pool: ${pool.address}`,
    "",
    "Input:",
    `${formatEther(q.amountInWei)} ETH`,
    "",
    `Expected output: ${q.amountOutWei.toString()} (raw units)`,
    "",
    `Minimum output: (see slippage) ${((q.amountOutWei * BigInt(10000 - env.MAX_SLIPPAGE_BPS)) / 10000n).toString()}`,
    "",
    "Slippage:",
    `${(env.MAX_SLIPPAGE_BPS / 100).toFixed(2)}%`,
    "",
    `Estimated gas: ${trade.tx.gas ? formatEther(trade.tx.gas * (trade.tx.maxFeePerGas ?? 0n)) : "unknown"} ETH`,
    "",
    `Router: ${trade.tx.to}`,
    "",
    "Transaction:",
    "READY FOR AUTHORIZATION",
    `Execution ID: ${trade.executionId}`,
    "",
    "Mode:",
    env.DRY_RUN ? "DRY RUN — NO TRANSACTION SENT" : "LIVE — requires /authorize " + trade.executionId,
  ].join("\n");
}
