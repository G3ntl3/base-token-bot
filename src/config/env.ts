import "dotenv/config";
import { z } from "zod";
import { isAddress, getAddress, type Address } from "viem";

const addressSchema = z
  .string()
  .refine((v) => isAddress(v), { message: "must be a valid 0x address" })
  .transform((v) => getAddress(v) as Address);

const csvAddressList = z
  .string()
  .optional()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => getAddress(s) as Address)
  );

const csvNumberList = z
  .string()
  .optional()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Number(s))
  );

const boolFromString = z
  .string()
  .optional()
  .default("false")
  .transform((v) => v.toLowerCase() === "true");

const envSchema = z.object({
  CHAIN_ID: z.coerce.number().int().refine((v) => v === 8453 || v === 84532, {
    message: "CHAIN_ID must be 8453 (Base Mainnet) or 84532 (Base Sepolia)",
  }),
  BASE_RPC_URL: z.string().url(),
  BASE_WS_RPC_URL: z.string().url(),
  BASE_RPC_FALLBACK_URLS: z
    .string()
    .optional()
    .default("")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),

  TELEGRAM_BOT_TOKEN: z.string().min(10, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ADMIN_IDS: csvNumberList,

  TOKEN_CA: addressSchema,
  MAX_BUY_ETH: z.coerce.number().positive(),
  MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(2000),
  MIN_LIQUIDITY_ETH: z.coerce.number().nonnegative(),
  QUOTE_TTL_SECONDS: z.coerce.number().int().positive().default(20),

  ROUTER_ALLOWLIST: csvAddressList,
  ZEROX_API_KEY: z.string().optional().default(""),

  DRY_RUN: boolFromString,
  BUY_ONCE: boolFromString,

  SIGNER_MODE: z.enum(["dryrun", "privatekey"]).default("dryrun"),
  WALLET_PRIVATE_KEY: z
    .string()
    .optional()
    .default("")
    .refine(
      (v) => v === "" || /^0x[0-9a-fA-F]{64}$/.test(v),
      "WALLET_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string"
    ),

  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.string().optional().default("info"),
  ENCRYPTION_SECRET: z.string().optional().default(""),
});

export type Env = Omit<z.infer<typeof envSchema>, "MAX_BUY_ETH"> & {
  /** Max buy amount, kept as the raw number for display, plus wei as BigInt. */
  MAX_BUY_ETH: number;
  MAX_BUY_WEI: bigint;
  /** Secret key used to encrypt and decrypt private keys at rest */
  EFFECTIVE_ENCRYPTION_SECRET: string;
};

function parseEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Never dump full process.env; only show the validation issues.
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const data = parsed.data;

  // Fall back to a hash of the bot token if ENCRYPTION_SECRET is not explicitly set
  const effectiveEncryptionSecret =
    data.ENCRYPTION_SECRET.trim().length > 0
      ? data.ENCRYPTION_SECRET
      : `secret_salt_${data.TELEGRAM_BOT_TOKEN}`;

  // Convert MAX_BUY_ETH to wei using BigInt-safe integer math (avoid floats).
  // We work in a fixed 18-decimal representation.
  const [whole, frac = ""] = data.MAX_BUY_ETH.toString().split(".");
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  const maxBuyWei = BigInt(whole) * 10n ** 18n + BigInt(fracPadded || "0");

  return { ...data, MAX_BUY_WEI: maxBuyWei, EFFECTIVE_ENCRYPTION_SECRET: effectiveEncryptionSecret };
}

export const env: Env = parseEnv();

/** Redacts any secret-shaped values before logging config for diagnostics. */
export function redactedConfigSummary(): Record<string, unknown> {
  return {
    CHAIN_ID: env.CHAIN_ID,
    BASE_RPC_URL: env.BASE_RPC_URL,
    TOKEN_CA: env.TOKEN_CA,
    MAX_BUY_ETH: env.MAX_BUY_ETH,
    MAX_SLIPPAGE_BPS: env.MAX_SLIPPAGE_BPS,
    MIN_LIQUIDITY_ETH: env.MIN_LIQUIDITY_ETH,
    DRY_RUN: env.DRY_RUN,
    BUY_ONCE: env.BUY_ONCE,
    SIGNER_MODE: env.SIGNER_MODE,
    WALLET_PRIVATE_KEY: env.WALLET_PRIVATE_KEY ? "[REDACTED]" : "(not set)",
    ROUTER_ALLOWLIST: env.ROUTER_ALLOWLIST,
    ADMIN_COUNT: env.TELEGRAM_ADMIN_IDS.length,
  };
}
