import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ModelUsageStat, ProviderUsageStat, TokenUsageRow, UsagePeriod, UsageStore, UsageTotals } from "./types.js";
import { atomicWriteFile } from "../fsutil.js";

export function periodStart(period: UsagePeriod, now = Date.now()): number | undefined {
  switch (period) {
    case "today": { const start = new Date(now); start.setHours(0, 0, 0, 0); return start.getTime(); }
    case "week": return now - 7 * 24 * 60 * 60 * 1000;
    case "month": return now - 30 * 24 * 60 * 60 * 1000;
    case "all": return undefined;
  }
}

interface SqliteApi { DatabaseSync: new (location: string) => SqliteDatabase; }
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: any[]): void; get(...args: any[]): any; all(...args: any[]): any[] };
  close(): void;
}

let sqlitePromise: Promise<SqliteApi | undefined> | undefined;
async function loadSqlite(): Promise<SqliteApi | undefined> {
  if (sqlitePromise === undefined) sqlitePromise = import("node:sqlite").then((mod) => mod as unknown as SqliteApi).catch(() => undefined);
  return sqlitePromise;
}

export function sqliteAvailable(): Promise<boolean> { return loadSqlite().then((mod) => Boolean(mod)); }

export class SqliteUsageStore implements UsageStore {
  private readonly db: SqliteDatabase;
  private readonly insert: { run(...args: any[]): void };

  constructor(db: SqliteDatabase) {
    this.db = db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      estimated INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      created_at INTEGER NOT NULL
    )`);
    // Older databases predate the cache_write_tokens column.
    const columns = (this.db.prepare(`PRAGMA table_info(token_usage)`).all() as any[]).map((column) => column.name);
    if (!columns.includes("cache_write_tokens")) {
      this.db.exec(`ALTER TABLE token_usage ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_provider ON token_usage(provider)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_created ON token_usage(created_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_session ON token_usage(session_id)`);
    this.insert = this.db.prepare(`INSERT INTO token_usage
      (provider, model, input_tokens, output_tokens, total_tokens, cached_tokens, cache_write_tokens, reasoning_tokens, estimated, session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  }

  async record(row: TokenUsageRow): Promise<void> {
    this.insert.run(row.provider, row.model, row.inputTokens, row.outputTokens, row.totalTokens, row.cachedTokens, row.cacheWriteTokens, row.reasoningTokens, row.estimated ? 1 : 0, row.sessionId, row.createdAt);
  }

  private where(period?: UsagePeriod): { clause: string; args: number[] } {
    const start = period === undefined ? undefined : periodStart(period);
    return start === undefined ? { clause: "", args: [] } : { clause: "WHERE created_at >= ?", args: [start] };
  }

  async sessionTotals(sessionId: string): Promise<UsageTotals> {
    const row = this.db.prepare(`SELECT COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(total_tokens),0) AS totalTokens FROM token_usage WHERE session_id = ?`).get(sessionId) as any;
    return { inputTokens: Number(row.inputTokens), outputTokens: Number(row.outputTokens), totalTokens: Number(row.totalTokens) };
  }

  async providerStats(period?: UsagePeriod): Promise<ProviderUsageStat[]> {
    const { clause, args } = this.where(period);
    const rows = this.db.prepare(`SELECT provider, COALESCE(SUM(total_tokens),0) AS tokens, COUNT(*) AS requests FROM token_usage ${clause} GROUP BY provider ORDER BY tokens DESC, provider ASC`).all(...args) as any[];
    return rows.map((row) => ({ provider: row.provider, tokens: Number(row.tokens), requests: Number(row.requests) }));
  }

  async modelStats(period?: UsagePeriod): Promise<ModelUsageStat[]> {
    const { clause, args } = this.where(period);
    const rows = this.db.prepare(`SELECT provider, model, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cached_tokens),0) AS cachedTokens, COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens, COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens, COALESCE(SUM(total_tokens),0) AS tokens, COUNT(*) AS requests FROM token_usage ${clause} GROUP BY provider, model ORDER BY tokens DESC, provider ASC, model ASC`).all(...args) as any[];
    return rows.map((row) => ({ provider: row.provider, model: row.model, inputTokens: Number(row.inputTokens), outputTokens: Number(row.outputTokens), cachedTokens: Number(row.cachedTokens), cacheWriteTokens: Number(row.cacheWriteTokens), reasoningTokens: Number(row.reasoningTokens), tokens: Number(row.tokens), requests: Number(row.requests) }));
  }

  async totals(period?: UsagePeriod): Promise<UsageTotals> {
    const { clause, args } = this.where(period);
    const row = this.db.prepare(`SELECT COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(total_tokens),0) AS totalTokens FROM token_usage ${clause}`).get(...args) as any;
    return { inputTokens: Number(row.inputTokens), outputTokens: Number(row.outputTokens), totalTokens: Number(row.totalTokens) };
  }

  async close(): Promise<void> { this.db.close(); }
}

class MemoryUsageStore implements UsageStore {
  protected rows: TokenUsageRow[] = [];

  async record(row: TokenUsageRow): Promise<void> { this.rows.push(row); }
  private filter(period?: UsagePeriod): TokenUsageRow[] {
    const start = period === undefined ? undefined : periodStart(period);
    return start === undefined ? this.rows : this.rows.filter((row) => row.createdAt >= start!);
  }
  private sum(rows: TokenUsageRow[]): UsageTotals {
    return { inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0), outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0), totalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0) };
  }
  async sessionTotals(sessionId: string): Promise<UsageTotals> { return this.sum(this.rows.filter((row) => row.sessionId === sessionId)); }
  async providerStats(period?: UsagePeriod): Promise<ProviderUsageStat[]> {
    const grouped = new Map<string, { tokens: number; requests: number }>();
    for (const row of this.filter(period)) { const entry = grouped.get(row.provider) ?? { tokens: 0, requests: 0 }; entry.tokens += row.totalTokens; entry.requests++; grouped.set(row.provider, entry); }
    return [...grouped.entries()].map(([provider, value]) => ({ provider, ...value })).sort((a, b) => b.tokens - a.tokens || (a.provider < b.provider ? -1 : 1));
  }
  async modelStats(period?: UsagePeriod): Promise<ModelUsageStat[]> {
    const grouped = new Map<string, { provider: string; model: string; inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; reasoningTokens: number; tokens: number; requests: number }>();
    for (const row of this.filter(period)) { const key = `${row.provider}/${row.model}`; const entry = grouped.get(key) ?? { provider: row.provider, model: row.model, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, tokens: 0, requests: 0 }; entry.inputTokens += row.inputTokens; entry.outputTokens += row.outputTokens; entry.cachedTokens += row.cachedTokens; entry.cacheWriteTokens += row.cacheWriteTokens; entry.reasoningTokens += row.reasoningTokens; entry.tokens += row.totalTokens; entry.requests++; grouped.set(key, entry); }
    return [...grouped.values()].sort((a, b) => b.tokens - a.tokens || (a.provider < b.provider ? -1 : 1) || (a.model < b.model ? -1 : 1));
  }
  async totals(period?: UsagePeriod): Promise<UsageTotals> { return this.sum(this.filter(period)); }
  // Closing releases resources; in-memory rows are kept so stats stay readable
  // after close (matters for tests and the CLI reading a shared instance).
  async close(): Promise<void> {}
}

class JsonFileUsageStore extends MemoryUsageStore {
  private loadPromise?: Promise<void>;
  /** Serializes writes so an older snapshot can never overwrite newer rows. */
  private writeQueue: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) { super(); }
  private load(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = readFile(this.file, "utf8").then((text) => { this.rows = JSON.parse(text) as TokenUsageRow[]; }).catch(() => { this.rows = []; });
    return this.loadPromise;
  }
  private persist(): Promise<void> {
    const write = this.writeQueue.then(() => atomicWriteFile(this.file, `${JSON.stringify(this.rows, null, 2)}\n`));
    // Keep the queue alive even when a write fails, but surface the error.
    this.writeQueue = write.catch(() => {});
    return write;
  }
  override async record(row: TokenUsageRow): Promise<void> { await this.load(); await super.record(row); await this.persist(); }
  override async sessionTotals(sessionId: string): Promise<UsageTotals> { await this.load(); await this.writeQueue; return super.sessionTotals(sessionId); }
  override async providerStats(period?: UsagePeriod): Promise<ProviderUsageStat[]> { await this.load(); await this.writeQueue; return super.providerStats(period); }
  override async modelStats(period?: UsagePeriod): Promise<ModelUsageStat[]> { await this.load(); await this.writeQueue; return super.modelStats(period); }
  override async totals(period?: UsagePeriod): Promise<UsageTotals> { await this.load(); await this.writeQueue; return super.totals(period); }
}

export type StoreBackend = "sqlite" | "json" | "memory";

export function defaultUsageLocation(backend: StoreBackend): string {
  const base = process.env.AGENTX_USAGE_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agentx");
  return join(base, backend === "json" ? "usage.json" : "usage.db");
}

export function defaultStoreBackend(): StoreBackend {
  const value = process.env.AGENTX_USAGE_BACKEND;
  return value === "json" || value === "memory" || value === "sqlite" ? value : "sqlite";
}

async function sqliteOrFallback(sqliteLocation: string, jsonLocation: string): Promise<UsageStore> {
  const sqlite = await loadSqlite();
  if (!sqlite) return new JsonFileUsageStore(jsonLocation);
  try {
    if (sqliteLocation !== ":memory:") await mkdir(dirname(sqliteLocation), { recursive: true, mode: 0o700 });
    return new SqliteUsageStore(new sqlite.DatabaseSync(sqliteLocation));
  } catch {
    return new JsonFileUsageStore(jsonLocation);
  }
}

export async function createUsageStore(options: { location?: string; backend?: StoreBackend } = {}): Promise<UsageStore> {
  const backend = options.backend ?? "sqlite";
  if (backend === "memory") return new MemoryUsageStore();
  const jsonLocation = options.location ?? defaultUsageLocation("json");
  if (backend === "json") return new JsonFileUsageStore(jsonLocation);
  return sqliteOrFallback(options.location ?? defaultUsageLocation("sqlite"), jsonLocation);
}

/** Shared default store used by the adapter server and the CLI statistics command. */
export function defaultUsageStore(): Promise<UsageStore> {
  return createUsageStore({ backend: defaultStoreBackend() });
}
