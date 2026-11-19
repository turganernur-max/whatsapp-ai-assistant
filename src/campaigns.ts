import { getDb } from "./db.js";
import { config } from "./config.js";
import { getSettings } from "./settings.js";
import { generateReply, type HistoryItem } from "./ai.js";
import { costUsd } from "./pricing.js";
import * as wa from "./whatsapp.js";
import { getKnowledge, insertMessage, logEvent, monthSpendUsd, recordUsage, updateContact } from "./store.js";
import { sendAndStore } from "./processor.js";

// =====================================================================
// 1) Follow-up: one gentle reminder when the client goes quiet.
//    Sent only inside WhatsApp's free 24-hour window.
// =====================================================================

export interface DueFollowup {
  wa_id: string;
  followup_mode: string;
  followup_count: number;
  final: boolean;
}

/**
 * Contacts that should get a reminder now. Everything stays inside WhatsApp's free
 * 24-hour window (counted from the client's last message), so reminders never cost money.
 *  - default: follows the global switch, one reminder
 *  - once: one reminder for this client
 *  - persistent: up to `max` reminders every `hours`, plus a last one ~21h after the
 *    client's message so the window is used before it closes
 *  - off: never
 * The counter resets whenever the client writes again.
 */
export async function dueFollowups(hours: number, globalOn: boolean, max: number): Promise<DueFollowup[]> {
  const rows = await getDb().query<DueFollowup & { last_inbound_at: Date }>(
    `SELECT c.wa_id, c.followup_mode, c.followup_count,
            (c.followup_mode = 'persistent' AND c.last_inbound_at < now() - interval '21 hours') AS final
     FROM contacts c
     JOIN LATERAL (SELECT sender, created_at FROM messages m
                   WHERE m.wa_id = c.wa_id AND NOT (m.direction = 'out' AND m.status = 'failed')
                   ORDER BY m.id DESC LIMIT 1) last ON TRUE
     WHERE c.ai_enabled AND NOT c.opted_out AND NOT c.needs_attention
       AND (c.paused_until IS NULL OR c.paused_until < now())
       AND c.last_inbound_at > now() - interval '23 hours'
       AND last.sender = 'ai'
       AND (
         (c.followup_mode = 'default' AND $2::boolean AND c.followup_count < 1
            AND last.created_at < now() - ($1::float8 * interval '1 hour'))
         OR (c.followup_mode = 'once' AND c.followup_count < 1
            AND last.created_at < now() - ($1::float8 * interval '1 hour'))
         OR (c.followup_mode = 'persistent' AND c.followup_count < $3::int
            AND (last.created_at < now() - ($1::float8 * interval '1 hour')
                 OR (c.last_inbound_at < now() - interval '21 hours' AND last.created_at < now() - interval '1 hour')))
       )
     LIMIT 20`,
    [hours, globalOn, max],
  );
  return rows;
}

let followupRunning = false;

export async function runFollowups(): Promise<number> {
  if (followupRunning) return 0;
  followupRunning = true;
  let sent = 0;
  try {
    const s = await getSettings();
    if (!s.ai_enabled || !config.waToken) return 0;
    if (s.monthly_budget_usd > 0 && (await monthSpendUsd()) >= s.monthly_budget_usd) return 0;
    const due = await dueFollowups(s.followup_hours, s.followup_enabled, s.followup_max);
    if (!due.length) return 0;
    const kb = await getKnowledge();
    for (const f of due) {
      const waId = f.wa_id;
      const attempt = f.followup_count + 1;
      // Count first so a crash or error never causes an extra reminder.
      await getDb().query(`UPDATE contacts SET followup_count = followup_count + 1, followup_sent_at = now() WHERE wa_id = $1`, [waId]);
      try {
        const hist = await getDb().query<{ sender: HistoryItem["sender"]; text: string | null; type: string }>(
          `SELECT sender, text, type FROM (SELECT id, sender, text, type FROM messages WHERE wa_id = $1
             AND NOT (direction = 'out' AND status = 'failed') ORDER BY id DESC LIMIT $2) t ORDER BY id`,
          [waId, s.history_messages],
        );
        const final = f.followup_mode === "persistent" && (f.final || attempt >= s.followup_max);
        const decision = await generateReply(
          s,
          kb,
          [],
          hist.map((h) => ({ sender: h.sender, text: h.text ?? `[${h.type}]` })),
          [],
          [],
          { followupHours: s.followup_hours, followupAttempt: attempt, followupFinal: final },
        );
        await recordUsage({
          kind: "chat",
          model: decision.model,
          wa_id: waId,
          input_tokens: decision.usage.input_tokens,
          output_tokens: decision.usage.output_tokens,
          cache_read_tokens: decision.usage.cache_read_input_tokens,
          cache_write_tokens: decision.usage.cache_creation_input_tokens,
          cost_usd: costUsd(decision.model, decision.usage),
        });
        if (!decision.reply.trim() || decision.handoff) {
          // AI judged a reminder inappropriate: stop reminding until the client writes again.
          await getDb().query(`UPDATE contacts SET followup_count = 99 WHERE wa_id = $1`, [waId]);
          continue;
        }
        await sendAndStore(waId, decision.reply, "ai");
        await logEvent("followup", waId, `#${attempt}: ${decision.reply.slice(0, 200)}`);
        sent++;
      } catch (e) {
        console.warn("[followup]", waId, (e as Error).message);
      }
    }
  } finally {
    followupRunning = false;
  }
  return sent;
}

// =====================================================================
// 2) Broadcasts: approved templates sent to chosen past clients.
// =====================================================================

export class BroadcastError extends Error {}

/** Clients a broadcast would reach: people who wrote to the business (and did not opt out). */
export async function audience(days: number): Promise<{ wa_id: string; name: string | null }[]> {
  return getDb().query(
    `SELECT wa_id, name FROM contacts
     WHERE NOT opted_out AND last_inbound_at IS NOT NULL
       AND ($1::int = 0 OR last_inbound_at > now() - ($1::int * interval '1 day'))
     ORDER BY last_inbound_at DESC LIMIT 5000`,
    [days],
  );
}

export async function createBroadcast(input: {
  template: wa.TemplateInfo;
  audienceDays: number;
  scheduledAt?: Date | null;
}) {
  const t = input.template;
  if (t.status !== "APPROVED") throw new BroadcastError("Этот шаблон ещё не одобрен Meta");
  if (t.params > 1) throw new BroadcastError("Поддерживаются шаблоны без переменных или с одной переменной {{1}} (имя клиента)");
  const people = await audience(input.audienceDays);
  if (!people.length) throw new BroadcastError("Нет получателей для выбранного периода");
  const [b] = await getDb().query<{ id: number }>(
    `INSERT INTO broadcasts (template_name, language, category, body, params, audience_days, scheduled_at, total)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, now()),$8) RETURNING id`,
    [t.name, t.language, t.category, t.body, t.params, input.audienceDays, input.scheduledAt ?? null, people.length],
  );
  return b.id;
}

export async function cancelBroadcast(id: number) {
  const rows = await getDb().query(
    `UPDATE broadcasts SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status IN ('scheduled','running') RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

export function renderBody(body: string, name: string | null) {
  return body.replace(/\{\{\s*1\s*\}\}/g, name?.trim() || "клиент");
}

let broadcastRunning = false;

/** Sends due broadcasts. Safe to call often; resumes after restarts. */
export async function runBroadcasts(maxPerRun = 200): Promise<number> {
  if (broadcastRunning || !config.waToken) return 0;
  broadcastRunning = true;
  let count = 0;
  try {
    const d = getDb();
    const due = await d.query<{ id: number; template_name: string; language: string; body: string; params: number; audience_days: number; status: string }>(
      `SELECT id, template_name, language, body, params, audience_days, status FROM broadcasts
       WHERE status IN ('scheduled','running') AND scheduled_at <= now() ORDER BY id LIMIT 1`,
    );
    const b = due[0];
    if (!b) return 0;
    if (b.status === "scheduled") {
      const people = await audience(b.audience_days);
      for (const p of people) {
        await d.query(
          `INSERT INTO broadcast_recipients (broadcast_id, wa_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [b.id, p.wa_id],
        );
      }
      await d.query(`UPDATE broadcasts SET status = 'running', total = $2 WHERE id = $1`, [b.id, people.length]);
    }
    const pending = await d.query<{ wa_id: string; name: string | null; opted_out: boolean }>(
      `SELECT r.wa_id, c.name, COALESCE(c.opted_out, false) AS opted_out FROM broadcast_recipients r
       LEFT JOIN contacts c ON c.wa_id = r.wa_id
       WHERE r.broadcast_id = $1 AND r.status = 'pending' LIMIT $2`,
      [b.id, maxPerRun],
    );
    for (const r of pending) {
      const [{ status }] = await d.query<{ status: string }>(`SELECT status FROM broadcasts WHERE id = $1`, [b.id]);
      if (status === "cancelled") break;
      if (r.opted_out) {
        await d.query(`UPDATE broadcast_recipients SET status = 'skipped', error = 'отписался' WHERE broadcast_id = $1 AND wa_id = $2`, [b.id, r.wa_id]);
        continue;
      }
      const text = renderBody(b.body, r.name);
      try {
        const msgId = await wa.sendTemplate(r.wa_id, b.template_name, b.language, b.params ? [r.name?.trim() || "клиент"] : []);
        await d.query(
          `UPDATE broadcast_recipients SET status = 'sent', wa_message_id = $3, sent_at = now() WHERE broadcast_id = $1 AND wa_id = $2`,
          [b.id, r.wa_id, msgId],
        );
        await d.query(`UPDATE broadcasts SET sent = sent + 1 WHERE id = $1`, [b.id]);
        await insertMessage({ wa_message_id: msgId || null, wa_id: r.wa_id, direction: "out", sender: "system", type: "template", text: `📢 ${text}`, status: "sent" });
        await updateContact(r.wa_id, { last_message_at: new Date() });
      } catch (e) {
        await d.query(
          `UPDATE broadcast_recipients SET status = 'failed', error = $3 WHERE broadcast_id = $1 AND wa_id = $2`,
          [b.id, r.wa_id, (e as Error).message.slice(0, 300)],
        );
        await d.query(`UPDATE broadcasts SET failed = failed + 1 WHERE id = $1`, [b.id]);
      }
      count++;
      await new Promise((res) => setTimeout(res, 300)); // gentle pace
    }
    const [{ n }] = await d.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'pending'`,
      [b.id],
    );
    if (n === 0) {
      await d.query(`UPDATE broadcasts SET status = 'done', finished_at = now() WHERE id = $1 AND status = 'running'`, [b.id]);
      await logEvent("broadcast", null, `Рассылка «${b.template_name}» завершена`);
    }
  } finally {
    broadcastRunning = false;
  }
  return count;
}

let timer: NodeJS.Timeout | null = null;
export function startCampaigns() {
  if (timer) return;
  timer = setInterval(() => {
    runBroadcasts().catch((e) => console.error("[broadcast]", e.message));
    runFollowups().catch((e) => console.error("[followup]", e.message));
  }, 60_000);
  timer.unref();
}
export function stopCampaigns() {
  if (timer) clearInterval(timer);
  timer = null;
}
