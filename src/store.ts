import { getDb } from "./db.js";

export interface Contact {
  wa_id: string;
  name: string | null;
  ai_enabled: boolean;
  paused_until: Date | null;
  disclosed: boolean;
  opted_out: boolean;
  needs_attention: boolean;
  attention_reason: string | null;
  note: string | null;
  last_inbound_at: Date | null;
  last_message_at: Date | null;
  unread: number;
  followup_sent_at: Date | null;
  created_at: Date;
}
export interface Message {
  id: number;
  wa_message_id: string | null;
  wa_id: string;
  direction: "in" | "out";
  sender: "contact" | "ai" | "owner" | "system";
  type: string;
  text: string | null;
  media_id: string | null;
  status: string;
  error: string | null;
  created_at: Date;
}

export async function upsertContact(waId: string, name?: string | null) {
  await getDb().query(
    `INSERT INTO contacts (wa_id, name) VALUES ($1, $2)
     ON CONFLICT (wa_id) DO UPDATE SET name = COALESCE(EXCLUDED.name, contacts.name)`,
    [waId, name ?? null],
  );
}

export async function getContact(waId: string): Promise<Contact | null> {
  const r = await getDb().query<Contact>(`SELECT * FROM contacts WHERE wa_id = $1`, [waId]);
  return r[0] ?? null;
}

export async function updateContact(waId: string, patch: Partial<Omit<Contact, "wa_id" | "created_at">>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await getDb().query(`UPDATE contacts SET ${sets} WHERE wa_id = $1`, [waId, ...keys.map((k) => (patch as any)[k])]);
}

/** Inserts a message; returns null when the WhatsApp message id was already stored (duplicate webhook). */
export async function insertMessage(m: {
  wa_message_id?: string | null;
  wa_id: string;
  direction: "in" | "out";
  sender: Message["sender"];
  type?: string;
  text?: string | null;
  media_id?: string | null;
  status: string;
  error?: string | null;
  created_at?: Date;
}): Promise<Message | null> {
  const r = await getDb().query<Message>(
    `INSERT INTO messages (wa_message_id, wa_id, direction, sender, type, text, media_id, status, error, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10, now()))
     ON CONFLICT (wa_message_id) DO NOTHING
     RETURNING *`,
    [
      m.wa_message_id || null,
      m.wa_id,
      m.direction,
      m.sender,
      m.type ?? "text",
      m.text ?? null,
      m.media_id ?? null,
      m.status,
      m.error ?? null,
      m.created_at ?? null,
    ],
  );
  return r[0] ?? null;
}

export async function logEvent(kind: string, waId: string | null, detail: string) {
  await getDb().query(`INSERT INTO events (kind, wa_id, detail) VALUES ($1, $2, $3)`, [kind, waId, detail.slice(0, 1000)]);
}

export async function recordUsage(u: {
  kind: "chat" | "stt";
  model: string;
  wa_id: string | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd: number;
}) {
  await getDb().query(
    `INSERT INTO usage (kind, model, wa_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [u.kind, u.model, u.wa_id, u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_tokens ?? 0, u.cache_write_tokens ?? 0, u.cost_usd],
  );
}

export async function monthSpendUsd(): Promise<number> {
  const r = await getDb().query<{ s: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS s FROM usage WHERE created_at >= date_trunc('month', now())`,
  );
  return Number(r[0]?.s ?? 0);
}

export async function getKnowledge(): Promise<{ title: string; content: string }[]> {
  return getDb().query(`SELECT title, content FROM knowledge WHERE enabled ORDER BY id`);
}
