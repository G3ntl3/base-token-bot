import type { Address, Log } from "viem";
import { createWsClient, httpClient } from "../base";
import { child } from "../../logging/logger";

const log = child("block-watcher");

export type NewBlockHandler = (blockNumber: bigint) => void | Promise<void>;
export type TokenActivityHandler = (logs: Log[]) => void | Promise<void>;

/**
 * Subscribes to new blocks over WebSocket and, per block, checks for
 * Transfer events involving the watched token (a simple, robust proxy for
 * "something happened with this token" that works even before a pool
 * exists). If the WS connection drops, viem's transport auto-reconnects;
 * this class additionally guards subscription setup itself with exponential
 * backoff so a failure to (re)subscribe doesn't go unnoticed.
 */
export class BlockWatcher {
  private unwatch: (() => void) | null = null;
  private backoffMs = 1000;
  private readonly maxBackoffMs = 30_000;
  private stopped = false;

  constructor(
    private readonly token: Address,
    private readonly onNewBlock: NewBlockHandler,
    private readonly onTokenActivity: TokenActivityHandler
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.subscribeWithRetry();
  }

  private async subscribeWithRetry(): Promise<void> {
    if (this.stopped) return;
    try {
      const ws = createWsClient();

      const unwatchBlocks = ws.watchBlockNumber({
        onBlockNumber: (blockNumber) => {
          this.backoffMs = 1000; // reset backoff on healthy activity
          void this.onNewBlock(blockNumber);
        },
        onError: (err) => {
          log.error({ err }, "block subscription error, will resubscribe with backoff");
          this.scheduleResubscribe();
        },
      });

      const unwatchLogs = ws.watchEvent({
        address: this.token,
        onLogs: (logs) => {
          void this.onTokenActivity(logs);
        },
        onError: (err) => {
          log.error({ err }, "log subscription error, will resubscribe with backoff");
          this.scheduleResubscribe();
        },
      });

      this.unwatch = () => {
        unwatchBlocks();
        unwatchLogs();
      };

      log.info({ token: this.token }, "block/log watcher subscribed");
    } catch (err) {
      log.error({ err }, "failed to establish subscription, retrying with backoff");
      this.scheduleResubscribe();
    }
  }

  private scheduleResubscribe(): void {
    if (this.stopped) return;
    this.unwatch?.();
    this.unwatch = null;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    setTimeout(() => void this.subscribeWithRetry(), delay);
  }

  stop(): void {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = null;
  }
}

/** Fallback polling path used only if WS is entirely unavailable at startup. */
export async function getLatestBlockNumberHttp(): Promise<bigint> {
  return httpClient.getBlockNumber();
}
