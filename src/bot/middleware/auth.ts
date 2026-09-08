import type { Context, MiddlewareFn } from "telegraf";
import { env } from "../../config/env";
import { child } from "../../logging/logger";
import type { ExecutionRepository } from "../../state/repository";

const log = child("auth-middleware");

export function isAuthorizedUser(userId: number, repository?: ExecutionRepository): boolean {
  if (env.TELEGRAM_ADMIN_IDS.includes(userId)) return true;
  if (repository && repository.isDynamicAdmin(userId)) return true;
  return false;
}

export function isSuperAdmin(userId: number): boolean {
  return env.TELEGRAM_ADMIN_IDS.includes(userId);
}

/**
 * Creates middleware checking if user is an authorized admin (static or dynamic).
 */
export function createAdminMiddleware(repository: ExecutionRepository): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !isAuthorizedUser(userId, repository)) {
      log.warn({ userId, chatId: ctx.chat?.id }, "rejected non-admin command attempt");
      await ctx.reply("Unauthorized. You must be an authorized admin to use this command.");
      return;
    }
    return next();
  };
}

/**
 * Middleware restricted to super admins (configured in .env).
 */
export const superAdminOnly: MiddlewareFn<Context> = async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || !isSuperAdmin(userId)) {
    log.warn({ userId, chatId: ctx.chat?.id }, "rejected non-super-admin command attempt");
    await ctx.reply("This action is restricted to the bot owner (configured in TELEGRAM_ADMIN_IDS).");
    return;
  }
  return next();
};
