import pino from "pino";
import { env } from "../config/env";

/**
 * Global logger. Redaction paths cover the shapes of objects most likely to
 * carry secrets (env dumps, signer internals, raw tx objects that might be
 * mistakenly logged with a `privateKey` field attached upstream).
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "privateKey",
      "*.privateKey",
      "WALLET_PRIVATE_KEY",
      "*.WALLET_PRIVATE_KEY",
      "env.WALLET_PRIVATE_KEY",
      "TELEGRAM_BOT_TOKEN",
      "*.TELEGRAM_BOT_TOKEN",
      "authorization",
      "*.authorization",
    ],
    censor: "[REDACTED]",
  },
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } },
});

export function child(scope: string) {
  return logger.child({ scope });
}
