import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

let db: Db | null = null;

export function getDb(): Db {
  if (!db) throw new Error("Database not initialised");
  return db;
}

/** Opens Postgres (DATABASE_URL) or the embedded PGlite database (or in-memory when dir === "memory"). */
export async function initDb(opts: { url?: string; dir?: string } = {}): Promise<Db> {
  const url = opts.url ?? config.databaseUrl;
  if (url) {
    const pg = (await import("pg")).default;
    const needsSsl = !/localhost|127\.0\.0\.1/.test(url) && !/sslmode=disable/.test(url);
    const pool = new pg.Pool({
      connectionString: url,
      max: 5,
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    });
    pool.on("error", (e) => console.error("[db] pool error", e.message));
    db = {
      async query(sql, params = []) {
        return (await pool.query(sql, params as any[])).rows;
      },
      async exec(sql) {
        await pool.query(sql);
      },
      async close() {
        await pool.end();
      },
    };
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = opts.dir ?? path.join(config.dataDir, "pglite");
    let lite;
    if (dir === "memory") lite = new PGlite();
    else {
      fs.mkdirSync(dir, { recursive: true });
      lite = new PGlite(dir);
    }
    await lite.waitReady;
    db = {
      async query(sql, params = []) {
        return (await lite.query(sql, params as any[])).rows as any[];
      },
      async exec(sql) {
        await lite.exec(sql);
      },
      async close() {
        await lite.close();
      },
    };
  }
  await migrate(db);
  return db;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value JSONB NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE TABLE IF NOT EXISTS contacts (
     wa_id TEXT PRIMARY KEY,
     name TEXT,
     ai_enabled BOOLEAN NOT NULL DEFAULT TRUE,
     paused_until TIMESTAMPTZ,
     disclosed BOOLEAN NOT NULL DEFAULT FALSE,
     opted_out BOOLEAN NOT NULL DEFAULT FALSE,
     needs_attention BOOLEAN NOT NULL DEFAULT FALSE,
     attention_reason TEXT,
     note TEXT,
     last_inbound_at TIMESTAMPTZ,
     last_message_at TIMESTAMPTZ,
     unread INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE TABLE IF NOT EXISTS messages (
     id SERIAL PRIMARY KEY,
     wa_message_id TEXT UNIQUE,
     wa_id TEXT NOT NULL REFERENCES contacts(wa_id) ON DELETE CASCADE,
     direction TEXT NOT NULL,           -- in | out
     sender TEXT NOT NULL,              -- contact | ai | owner | system
     type TEXT NOT NULL DEFAULT 'text',
     text TEXT,
     media_id TEXT,
     status TEXT NOT NULL,              -- in: pending|processing|processed|skipped ; out: queued|sent|delivered|read|failed
     error TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS messages_wa_id_idx ON messages (wa_id, id);
   CREATE INDEX IF NOT EXISTS messages_status_idx ON messages (status) WHERE direction = 'in';
   CREATE TABLE IF NOT EXISTS knowledge (
     id SERIAL PRIMARY KEY,
     title TEXT NOT NULL,
     content TEXT NOT NULL,
     enabled BOOLEAN NOT NULL DEFAULT TRUE,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE TABLE IF NOT EXISTS usage (
     id SERIAL PRIMARY KEY,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     kind TEXT NOT NULL,                -- chat | stt
     model TEXT,
     wa_id TEXT,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cache_read_tokens INTEGER NOT NULL DEFAULT 0,
     cache_write_tokens INTEGER NOT NULL DEFAULT 0,
     cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0
   );
   CREATE INDEX IF NOT EXISTS usage_created_idx ON usage (created_at);
   CREATE TABLE IF NOT EXISTS events (
     id SERIAL PRIMARY KEY,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     wa_id TEXT,
     kind TEXT NOT NULL,                -- handoff | error | takeover | budget | optout | loop_guard
     detail TEXT
   );
   CREATE INDEX IF NOT EXISTS events_created_idx ON events (created_at);`,
  `CREATE TABLE IF NOT EXISTS media (
     id SERIAL PRIMARY KEY,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     kind TEXT NOT NULL,                -- image | video | document
     mime TEXT NOT NULL,
     filename TEXT NOT NULL,
     size INTEGER NOT NULL,
     data BYTEA NOT NULL,
     enabled BOOLEAN NOT NULL DEFAULT TRUE,
     wa_media_id TEXT,
     wa_uploaded_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,
];

async function migrate(d: Db) {
  await d.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const rows = await d.query<{ version: number }>(`SELECT version FROM schema_version LIMIT 1`);
  let current = rows.length ? rows[0].version : 0;
  if (!rows.length) await d.query(`INSERT INTO schema_version (version) VALUES (0)`);
  for (let i = current; i < MIGRATIONS.length; i++) {
    await d.exec(MIGRATIONS[i]);
    await d.query(`UPDATE schema_version SET version = $1`, [i + 1]);
    current = i + 1;
  }
}
