import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { env } from "../config/env";
import { child } from "../logging/logger";
import { isValidTransition, InvalidStateTransitionError, type ExecutionState } from "./state-machine";

const log = child("repository");

export interface ExecutionRecord {
  id: string;
  userId: number | null;
  tokenAddress: string;
  poolAddress: string | null;
  route: string | null;
  state: ExecutionState;
  executionKey: string | null;
  blockNumber: string | null;
  txHash: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UserWalletRecord {
  userId: number;
  address: string;
  encryptedPrivateKey: string;
  iv: string;
  authTag: string;
  buyAmountEth: number | null;
  createdAt: number;
  updatedAt: number;
}

export class ExecutionRepository {
  private db: Database.Database;

  constructor(databaseUrl: string = env.DATABASE_URL) {
    const dir = path.dirname(databaseUrl);
    if (dir && dir !== "." && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(databaseUrl);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    // 1. Ensure basic executions table exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        token_address TEXT NOT NULL,
        pool_address TEXT,
        route TEXT,
        state TEXT NOT NULL,
        execution_key TEXT,
        block_number TEXT,
        tx_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_executions_execution_key ON executions(execution_key);
      CREATE INDEX IF NOT EXISTS idx_executions_tx_hash ON executions(tx_hash);
    `);

    // 2. Add user_id column to existing executions table if missing
    const columns = this.db.pragma("table_info(executions)") as { name: string }[];
    const hasUserId = columns.some((c) => c.name === "user_id");
    if (!hasUserId) {
      this.db.exec(`ALTER TABLE executions ADD COLUMN user_id INTEGER;`);
    }

    // 3. Create user_id index and supporting tables
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_executions_user_id ON executions(user_id);

      CREATE TABLE IF NOT EXISTS kv_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_wallets (
        user_id INTEGER PRIMARY KEY,
        address TEXT NOT NULL,
        encrypted_private_key TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        buy_amount_eth REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dynamic_admins (
        user_id INTEGER PRIMARY KEY,
        added_by INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  createExecution(id: string, tokenAddress: string, userId: number | null = null): ExecutionRecord {
    const now = Date.now();
    const record: ExecutionRecord = {
      id,
      userId,
      tokenAddress,
      poolAddress: null,
      route: null,
      state: "WATCHING",
      executionKey: null,
      blockNumber: null,
      txHash: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO executions (id, user_id, token_address, pool_address, route, state, execution_key, block_number, tx_hash, created_at, updated_at)
         VALUES (@id, @userId, @tokenAddress, @poolAddress, @route, @state, @executionKey, @blockNumber, @txHash, @createdAt, @updatedAt)`
      )
      .run(record);
    return record;
  }

  getExecution(id: string): ExecutionRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM executions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToRecord(row) : undefined;
  }

  /** Transitions state, enforcing the state machine's valid-transition rules. */
  transition(
    id: string,
    to: ExecutionState,
    patch: Partial<Pick<ExecutionRecord, "poolAddress" | "route" | "executionKey" | "blockNumber" | "txHash">> = {}
  ): ExecutionRecord {
    const existing = this.getExecution(id);
    if (!existing) throw new Error(`No execution record with id ${id}`);
    if (!isValidTransition(existing.state, to)) {
      throw new InvalidStateTransitionError(existing.state, to);
    }

    const updated: ExecutionRecord = { ...existing, ...patch, state: to, updatedAt: Date.now() };
    this.db
      .prepare(
        `UPDATE executions SET pool_address=@poolAddress, route=@route, state=@state,
         execution_key=@executionKey, block_number=@blockNumber, tx_hash=@txHash, updated_at=@updatedAt
         WHERE id=@id`
      )
      .run(updated);

    log.info({ id, from: existing.state, to }, "execution state transitioned");
    return updated;
  }

  async hasExecutionKey(executionKey: string): Promise<boolean> {
    const row = this.db
      .prepare(`SELECT 1 FROM executions WHERE execution_key = ? AND state IN ('AUTHORIZED','SUBMITTED','CONFIRMED')`)
      .get(executionKey);
    return row !== undefined;
  }

  async hasCompletedOneShot(userId?: number | null): Promise<boolean> {
    if (userId !== undefined && userId !== null) {
      const row = this.db
        .prepare(`SELECT 1 FROM executions WHERE user_id = ? AND state IN ('SUBMITTED','CONFIRMED') LIMIT 1`)
        .get(userId);
      return row !== undefined;
    }
    const row = this.db
      .prepare(`SELECT 1 FROM executions WHERE state IN ('SUBMITTED','CONFIRMED') LIMIT 1`)
      .get();
    return row !== undefined;
  }

  hasTxHash(txHash: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM executions WHERE tx_hash = ?`).get(txHash);
    return row !== undefined;
  }

  // --- Dynamic Admin Management ---

  addDynamicAdmin(userId: number, addedBy: number): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO dynamic_admins (user_id, added_by, created_at) VALUES (?, ?, ?)`)
      .run(userId, addedBy, Date.now());
  }

  removeDynamicAdmin(userId: number): boolean {
    const result = this.db.prepare(`DELETE FROM dynamic_admins WHERE user_id = ?`).run(userId);
    return result.changes > 0;
  }

  isDynamicAdmin(userId: number): boolean {
    const row = this.db.prepare(`SELECT 1 FROM dynamic_admins WHERE user_id = ?`).get(userId);
    return row !== undefined;
  }

  getAllDynamicAdmins(): number[] {
    const rows = this.db.prepare(`SELECT user_id FROM dynamic_admins`).all() as { user_id: number }[];
    return rows.map((r) => r.user_id);
  }

  // --- User Wallet Management ---

  upsertUserWallet(wallet: Omit<UserWalletRecord, "createdAt" | "updatedAt">): UserWalletRecord {
    const existing = this.getUserWallet(wallet.userId);
    const now = Date.now();
    const record: UserWalletRecord = {
      ...wallet,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO user_wallets (user_id, address, encrypted_private_key, iv, auth_tag, buy_amount_eth, created_at, updated_at)
         VALUES (@userId, @address, @encryptedPrivateKey, @iv, @authTag, @buyAmountEth, @createdAt, @updatedAt)
         ON CONFLICT(user_id) DO UPDATE SET
           address = excluded.address,
           encrypted_private_key = excluded.encrypted_private_key,
           iv = excluded.iv,
           auth_tag = excluded.auth_tag,
           buy_amount_eth = COALESCE(excluded.buy_amount_eth, user_wallets.buy_amount_eth),
           updated_at = excluded.updated_at`
      )
      .run(record);
    return record;
  }

  getUserWallet(userId: number): UserWalletRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM user_wallets WHERE user_id = ?`).get(userId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      userId: row.user_id as number,
      address: row.address as string,
      encryptedPrivateKey: row.encrypted_private_key as string,
      iv: row.iv as string,
      authTag: row.auth_tag as string,
      buyAmountEth: row.buy_amount_eth !== null ? (row.buy_amount_eth as number) : null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  setUserBuyAmount(userId: number, buyAmountEth: number): boolean {
    const result = this.db
      .prepare(`UPDATE user_wallets SET buy_amount_eth = ?, updated_at = ? WHERE user_id = ?`)
      .run(buyAmountEth, Date.now(), userId);
    return result.changes > 0;
  }

  deleteUserWallet(userId: number): boolean {
    const result = this.db.prepare(`DELETE FROM user_wallets WHERE user_id = ?`).run(userId);
    return result.changes > 0;
  }

  getAllUserWallets(): UserWalletRecord[] {
    const rows = this.db.prepare(`SELECT * FROM user_wallets`).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      userId: row.user_id as number,
      address: row.address as string,
      encryptedPrivateKey: row.encrypted_private_key as string,
      iv: row.iv as string,
      authTag: row.auth_tag as string,
      buyAmountEth: row.buy_amount_eth !== null ? (row.buy_amount_eth as number) : null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }));
  }

  // --- Key-Value Settings ---

  getSetting(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM kv_settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO kv_settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  private rowToRecord(row: Record<string, unknown>): ExecutionRecord {
    return {
      id: row.id as string,
      userId: (row.user_id as number) ?? null,
      tokenAddress: row.token_address as string,
      poolAddress: (row.pool_address as string) ?? null,
      route: (row.route as string) ?? null,
      state: row.state as ExecutionState,
      executionKey: (row.execution_key as string) ?? null,
      blockNumber: (row.block_number as string) ?? null,
      txHash: (row.tx_hash as string) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  close(): void {
    this.db.close();
  }
}
