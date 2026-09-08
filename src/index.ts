import { env, redactedConfigSummary } from "./config/env";
import { logger, child } from "./logging/logger";
import { verifyChainId } from "./blockchain/base";
import { BlockWatcher } from "./blockchain/monitoring/blockWatcher";
import { ExecutionRepository } from "./state/repository";
import { createSigner } from "./trading/signer";
import { TradingApp } from "./app";
import { createBot } from "./bot/telegram";

const log = child("index");

async function main() {
  logger.info({ config: redactedConfigSummary() }, "starting base-token-launch-bot");

  await verifyChainId();

  const repository = new ExecutionRepository(env.DATABASE_URL);
  const signer = createSigner();
  const app = new TradingApp(repository, signer, env.TOKEN_CA);

  await app.loadToken(env.TOKEN_CA);
  log.info({ token: app.tokenInfo }, "initial token loaded");

  const bot = createBot(app);

  // Poll-driven cycle (in addition to the block/log watcher below) so
  // /quote-worthy conditions are checked even if no Transfer event fires
  // (e.g. a pool is created without a token transfer in the same block).
  const POLL_INTERVAL_MS = 15_000;
  const pollTimer = setInterval(async () => {
    if (!app.autobuyEnabled) return;
    try {
      const readyTrades = await app.runCycleForAllUsers();
      if (readyTrades.length > 0) {
        for (const trade of readyTrades) {
          log.info(
            { executionId: trade.executionId, userId: trade.userId },
            "autobuy cycle produced a ready trade - awaiting manual authorization"
          );
        }
      }
    } catch (err) {
      log.error({ err }, "autobuy poll cycle failed");
    }
  }, POLL_INTERVAL_MS);

  const watcher = new BlockWatcher(
    env.TOKEN_CA,
    (blockNumber) => log.debug({ blockNumber: blockNumber.toString() }, "new block"),
    (logs) => log.info({ count: logs.length }, "token Transfer activity observed")
  );
  await watcher.start();

  await bot.launch();
  log.info("telegram bot launched");

  const shutdown = (signal: string) => {
    log.info({ signal }, "shutting down");
    clearInterval(pollTimer);
    watcher.stop();
    bot.stop(signal);
    repository.close();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
