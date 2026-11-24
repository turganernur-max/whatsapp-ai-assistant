import { config } from "./config.js";
import { getDb } from "./db.js";
import { AiError, generateReply, type HistoryItem, type ImageInput } from "./ai.js";
import { costUsd, STT_USD_PER_SECOND } from "./pricing.js";
import { getSettings } from "./settings.js";
import { estimateAudioSeconds, transcribe } from "./stt.js";
import { notifyOwner } from "./notify.js";
import * as wa from "./whatsapp.js";
import { mediaLabel, sendLibraryItem, sendOneOffFile } from "./media.js";
import { aiSalesContext, paymentClaimed, saveOrder } from "./sales.js";
import {
  getContact,
  getKnowledge,
  insertMessage,
  logEvent,
  monthSpendUsd,
  recordUsage,
  updateContact,
  upsertContact,
  type Message,
} from "./store.js";

const WINDOW_MS = 24 * 60 * 60 * 1000; // WhatsApp customer-service window
const timers = new Map<string, NodeJS.Timeout>();
const locks = new Map<string, Promise<void>>();
const retries = new Map<string, number>();
let stopped = false;

const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

function normalizeWords(s: string) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isOptOut(text: string, words: string): boolean {
  const t = normalizeWords(text);
  if (!t) return false;
  return words
    .split(",")
    .map((w) => normalizeWords(w))
    .filter(Boolean)
    .includes(t);
}

// ---------------- Webhook intake ----------------

export async function handleEvents(events: wa.WebhookEvent[]): Promise<void> {
  for (const ev of events) {
    try {
      if (ev.kind === "message") await onInbound(ev);
      else if (ev.kind === "status") await onStatus(ev);
      else if (ev.kind === "echo") await onEcho(ev);
    } catch (e) {
      console.error("[webhook] event failed", ev.kind, (e as Error).message);
    }
  }
}

async function onInbound(ev: wa.InboundMessage) {
  await upsertContact(ev.from, ev.name);
  const created = new Date(ev.timestamp * 1000);
  const msg = await insertMessage({
    wa_message_id: ev.waMessageId,
    wa_id: ev.from,
    direction: "in",
    sender: "contact",
    type: ev.type,
    text: ev.text ?? null,
    media_id: ev.mediaId ?? null,
    status: ev.type === "reaction" ? "skipped" : "pending",
    created_at: created,
  });
  if (!msg) return; // duplicate delivery from Meta — already handled
  await getDb().query(
    `UPDATE contacts SET last_inbound_at = GREATEST(COALESCE(last_inbound_at, $2), $2),
       last_message_at = GREATEST(COALESCE(last_message_at, $2), $2), unread = unread + 1,
       followup_count = 0 WHERE wa_id = $1`,
    [ev.from, created],
  );
  if (ev.type === "reaction") return;

  const s = await getSettings();
  if (ev.type === "text" && ev.text && isOptOut(ev.text, s.opt_out_words)) {
    await getDb().query(`UPDATE messages SET status = 'skipped' WHERE wa_id = $1 AND direction = 'in' AND status = 'pending'`, [ev.from]);
    await updateContact(ev.from, { opted_out: true, ai_enabled: false, needs_attention: true, attention_reason: "Клиент отключил автоответы" });
    await logEvent("optout", ev.from, ev.text);
    if (s.opt_out_reply.trim() && config.waToken) await sendAndStore(ev.from, s.opt_out_reply, "system");
    await notifyOwner("Клиент отключил автоответы", `${ev.name ?? ev.from} написал стоп-слово.`, `/#chat/${ev.from}`);
    return;
  }
  schedule(ev.from, config.debounceMs);
}

async function onStatus(ev: wa.StatusUpdate) {
  const rank = STATUS_RANK[ev.status];
  if (rank === undefined) return;
  await getDb().query(
    `UPDATE messages SET status = $2, error = COALESCE($3, error)
     WHERE wa_message_id = $1 AND direction = 'out'
       AND (CASE status WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 4 ELSE 0 END) < $4`,
    [ev.waMessageId, ev.status, ev.error ?? null, rank],
  );
  if (ev.status === "failed") {
    await logEvent("error", ev.recipient, `Сообщение не доставлено: ${ev.error ?? "неизвестно"}`);
  }
}

/** Owner replied from the WhatsApp Business app (coexistence): store it and let the owner lead. */
async function onEcho(ev: wa.EchoMessage) {
  await upsertContact(ev.to);
  const msg = await insertMessage({
    wa_message_id: ev.waMessageId,
    wa_id: ev.to,
    direction: "out",
    sender: "owner",
    type: ev.type,
    text: ev.text ?? null,
    status: "sent",
    created_at: new Date(ev.timestamp * 1000),
  });
  if (!msg) return;
  await ownerTookOver(ev.to);
}

async function ownerTookOver(waId: string) {
  const s = await getSettings();
  cancel(waId);
  await getDb().query(`UPDATE messages SET status = 'skipped' WHERE wa_id = $1 AND direction = 'in' AND status = 'pending'`, [waId]);
  await updateContact(waId, {
    paused_until: s.owner_takeover_hours > 0 ? new Date(Date.now() + s.owner_takeover_hours * 3600_000) : null,
    needs_attention: false,
    attention_reason: null,
    unread: 0,
    last_message_at: new Date(),
  });
}

// ---------------- Scheduling ----------------

export function schedule(waId: string, delayMs: number) {
  if (stopped) return;
  const t = timers.get(waId);
  if (t) clearTimeout(t);
  timers.set(
    waId,
    setTimeout(() => {
      timers.delete(waId);
      void runLocked(waId);
    }, delayMs),
  );
}

function cancel(waId: string) {
  const t = timers.get(waId);
  if (t) clearTimeout(t);
  timers.delete(waId);
}

async function runLocked(waId: string) {
  const prev = locks.get(waId) ?? Promise.resolve();
  const next = prev.then(() => processContact(waId)).catch((e) => console.error("[processor]", waId, e));
  locks.set(waId, next);
  await next;
  if (locks.get(waId) === next) locks.delete(waId);
}

/** Waits until all scheduled/in-flight work is done (used by tests). */
export async function drain() {
  while (timers.size || locks.size) {
    await new Promise((r) => setTimeout(r, 20));
    await Promise.all([...locks.values()]);
  }
}

export function stopProcessor() {
  stopped = true;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

export function startProcessor() {
  stopped = false;
}

/** After a crash/restart: retry unfinished work from the last 24h, skip anything older. */
export async function recover() {
  const d = getDb();
  await d.query(`UPDATE messages SET status = 'pending' WHERE direction = 'in' AND status = 'processing'`);
  await d.query(
    `UPDATE messages SET status = 'skipped', error = 'Устарело (сервер был недоступен более 24 часов)'
     WHERE direction = 'in' AND status = 'pending' AND created_at < now() - interval '23 hours'`,
  );
  const rows = await d.query<{ wa_id: string }>(
    `SELECT DISTINCT wa_id FROM messages WHERE direction = 'in' AND status = 'pending'`,
  );
  rows.forEach((r, i) => schedule(r.wa_id, 1000 + i * 500));
  return rows.length;
}

// ---------------- Core processing ----------------

async function release(ids: number[], status: string, error: string | null = null) {
  if (!ids.length) return;
  await getDb().query(`UPDATE messages SET status = $2, error = $3 WHERE id = ANY($1::int[])`, [ids, status, error]);
}

async function flagAttention(waId: string, reason: string, kind: string, notify = true) {
  const before = await getContact(waId);
  await updateContact(waId, { needs_attention: true, attention_reason: reason });
  await logEvent(kind, waId, reason);
  // One push per open issue: don't repeat while the chat is already waiting for the owner.
  if (notify && !(kind === "handoff" && before?.needs_attention)) {
    const c = await getContact(waId);
    await notifyOwner("Нужно ваше внимание", `${c?.name ?? "+" + waId}: ${reason}`, `/#chat/${waId}`);
  }
}

export async function processContact(waId: string): Promise<void> {
  const d = getDb();
  const claimed = await d.query<Message>(
    `UPDATE messages SET status = 'processing'
     WHERE wa_id = $1 AND direction = 'in' AND status = 'pending' RETURNING *`,
    [waId],
  );
  if (!claimed.length) return;
  claimed.sort((a, b) => a.id - b.id);
  const ids = claimed.map((m) => m.id);
  const s = await getSettings();
  const contact = await getContact(waId);
  if (!contact) return release(ids, "skipped", "Контакт не найден");

  // --- Gates: the owner decides when AI talks ---
  if (!s.ai_enabled) return release(ids, "skipped", "AI выключен");
  if (!contact.ai_enabled || contact.opted_out) return release(ids, "skipped", "AI выключен для контакта");
  if (contact.paused_until && new Date(contact.paused_until).getTime() > Date.now())
    return release(ids, "skipped", "Владелец ведёт переписку");
  const newest = claimed[claimed.length - 1];
  if (Date.now() - new Date(newest.created_at).getTime() > WINDOW_MS - 3600_000)
    return release(ids, "skipped", "Окно 24 часа закрыто");
  if (!config.waToken || !config.waPhoneNumberId) return release(ids, "pending", "WhatsApp не настроен");

  const recentAi = await d.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM messages WHERE wa_id = $1 AND sender = 'ai' AND created_at > now() - interval '1 hour'`,
    [waId],
  );
  if ((recentAi[0]?.n ?? 0) >= s.max_ai_replies_per_hour) {
    await release(ids, "skipped", "Слишком много сообщений за час");
    await updateContact(waId, { paused_until: new Date(Date.now() + 3600_000) });
    await flagAttention(waId, "Слишком много сообщений за час (защита от зацикливания) — AI на паузе 1 час", "loop_guard");
    return;
  }

  const spent = await monthSpendUsd();
  if (s.monthly_budget_usd > 0 && spent >= s.monthly_budget_usd) {
    await release(ids, "skipped", "Достигнут месячный лимит расходов");
    if (!contact.needs_attention) {
      await sendAndStore(waId, s.handoff_message, "system").catch(() => {});
      await flagAttention(waId, `Месячный лимит расходов $${s.monthly_budget_usd} исчерпан — AI не отвечает`, "budget");
    }
    return;
  }

  // --- Media: voice transcription & images ---
  const images: ImageInput[] = [];
  for (const m of claimed) {
    if (!m.media_id) continue;
    try {
      if (m.type === "audio") {
        if (!config.sttApiKey) {
          await d.query(`UPDATE messages SET text = $2 WHERE id = $1`, [m.id, "[голосовое сообщение — расшифровка не подключена]"]);
          continue;
        }
        const media = await wa.downloadMedia(m.media_id);
        const text = await transcribe(media.data, media.mimeType);
        const secs = estimateAudioSeconds(media.data.length);
        await recordUsage({ kind: "stt", model: config.sttModel, wa_id: waId, cost_usd: secs * STT_USD_PER_SECOND });
        await d.query(`UPDATE messages SET text = $2 WHERE id = $1`, [m.id, `🎤 ${text || "[неразборчиво]"}`]);
      } else if (m.type === "image") {
        const media = await wa.downloadMedia(m.media_id, 5 * 1024 * 1024);
        const mt = media.mimeType.split(";")[0] as ImageInput["mediaType"];
        if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mt)) {
          images.push({ mediaType: mt, base64: media.data.toString("base64") });
        }
        if (!m.text) await d.query(`UPDATE messages SET text = '[фото]' WHERE id = $1`, [m.id]);
      }
    } catch (e) {
      console.warn("[media]", (e as Error).message);
      const label = m.type === "audio" ? "[голосовое сообщение — не удалось распознать]" : "[фото — не удалось загрузить]";
      await d.query(`UPDATE messages SET text = COALESCE(text, $2) WHERE id = $1`, [m.id, label]);
    }
  }

  if (s.send_read_receipts && newest.wa_message_id) await wa.markReadAndTyping(newest.wa_message_id, true);

  const hist = await d.query<{ sender: HistoryItem["sender"]; text: string | null; type: string }>(
    `SELECT sender, text, type FROM (
       SELECT id, sender, text, type FROM messages
       WHERE wa_id = $1 AND NOT (direction = 'out' AND status = 'failed')
       ORDER BY id DESC LIMIT $2) t ORDER BY id ASC`,
    [waId, s.history_messages],
  );
  const history: HistoryItem[] = hist.map((h) => ({ sender: h.sender, text: h.text ?? `[${h.type}]` }));
  const kb = await getKnowledge();
  const learned = s.auto_learn_style
    ? (
        await d.query<{ text: string }>(
          `SELECT text FROM messages WHERE sender = 'owner' AND text IS NOT NULL AND length(text) > 3 ORDER BY id DESC LIMIT 12`,
        )
      ).map((r) => r.text)
    : [];

  let decision;
  try {
    const { catalog, media, busySlots } = await aiSalesContext();
    decision = await generateReply(s, kb, learned, history, images, media, { catalog, busySlots });
  } catch (e) {
    const err = e as AiError;
    const n = (retries.get(waId) ?? 0) + 1;
    if (err.retryable && n <= 5) {
      retries.set(waId, n);
      await release(ids, "pending", err.message);
      schedule(waId, Math.min(5 * 60_000, 5000 * 2 ** n));
      return;
    }
    retries.delete(waId);
    await release(ids, "skipped", err.message);
    await flagAttention(waId, `AI не смог ответить: ${err.message}`, "error");
    return;
  }
  retries.delete(waId);
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

  // Owner may have stepped in while the AI was thinking.
  const fresh = await getContact(waId);
  if (!fresh || !fresh.ai_enabled || (fresh.paused_until && new Date(fresh.paused_until).getTime() > Date.now())) {
    return release(ids, "skipped", "Владелец вмешался");
  }
  if (!(await getSettings()).ai_enabled) return release(ids, "skipped", "AI выключен");

  let text = decision.handoff ? decision.reply || s.handoff_message : decision.reply;
  if (s.disclosure_enabled && !fresh.disclosed && s.disclosure_text.trim()) {
    text = `${s.disclosure_text.trim()}\n\n${text}`;
  }
  try {
    if (text.trim()) {
      if (s.human_style) {
        // Send like a person: a few short bubbles with typing pauses in between.
        const bubbles = humanBubbles(text);
        for (let i = 0; i < bubbles.length; i++) {
          if (s.human_delay) await humanPause(bubbles[i], newest.wa_message_id);
          if (i > 0) {
            const now = await getContact(waId);
            if (!now?.ai_enabled || (now.paused_until && new Date(now.paused_until).getTime() > Date.now())) break;
          }
          await sendAndStore(waId, bubbles[i], "ai");
        }
      } else {
        await sendAndStore(waId, text, "ai");
      }
    }
    await release(ids, "processed");
    await updateContact(waId, { disclosed: fresh.disclosed || s.disclosure_enabled, unread: 0 });
  } catch (e) {
    await release(ids, "processed", `Ошибка отправки: ${(e as Error).message}`);
    await flagAttention(waId, `Не удалось отправить ответ: ${(e as Error).message}`, "error");
    return;
  }

  // Sales: a confirmed order becomes an order card; "I paid" moves it to payment check.
  if (decision.order) {
    try {
      await saveOrder(waId, decision.order);
    } catch (e) {
      console.error("[order]", (e as Error).message);
    }
  }
  if (decision.paymentClaimed) {
    try {
      await paymentClaimed(waId);
    } catch (e) {
      console.error("[payment]", (e as Error).message);
    }
  }

  for (const mediaId of decision.mediaIds) {
    try {
      await sendLibraryAndStore(waId, mediaId, "ai");
    } catch (e) {
      await flagAttention(waId, `Не удалось отправить файл из медиатеки: ${(e as Error).message}`, "error");
    }
  }

  if (decision.handoff) {
    if (s.pause_after_handoff) {
      await updateContact(waId, { paused_until: new Date(Date.now() + Math.max(1, s.owner_takeover_hours) * 3600_000) });
    }
    await flagAttention(waId, decision.handoffReason || "Нужен владелец", "handoff");
  }
}

/** Splits a reply on blank lines into at most 3 chat bubbles (keeps it whole if parts would be tiny or many). */
export function humanBubbles(text: string): string[] {
  const parts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1 || parts.length > 3) return [text.trim()];
  return parts;
}

/** Waits roughly as long as a person would need to type the message (2–9 s), showing "typing…". */
async function humanPause(text: string, replyToWaId: string | null) {
  const ms = Math.min(9000, 1500 + text.length * 35) * config.humanDelayScale;
  if (ms <= 0) return;
  if (replyToWaId) await wa.markReadAndTyping(replyToWaId, true);
  await new Promise((r) => setTimeout(r, ms));
}

/** Sends text (split into chunks if needed) and stores each chunk. Throws on failure after storing it as failed. */
export async function sendAndStore(waId: string, text: string, sender: "ai" | "owner" | "system") {
  for (const chunk of wa.splitMessage(text)) {
    try {
      const id = await wa.sendText(waId, chunk);
      await insertMessage({ wa_message_id: id || null, wa_id: waId, direction: "out", sender, text: chunk, status: "sent" });
    } catch (e) {
      await insertMessage({ wa_id: waId, direction: "out", sender, text: chunk, status: "failed", error: (e as Error).message });
      throw e;
    }
  }
  await updateContact(waId, { last_message_at: new Date() });
}

/** Owner writes from the control panel. Only allowed inside the 24h window (WhatsApp rule). */
export async function ownerSend(waId: string, text: string) {
  const c = await getContact(waId);
  if (!c) throw new Error("Контакт не найден");
  if (!c.last_inbound_at || Date.now() - new Date(c.last_inbound_at).getTime() > WINDOW_MS) {
    throw new Error(
      "Прошло больше 24 часов с последнего сообщения клиента. По правилам WhatsApp можно написать только через одобренный шаблон (или ответить из приложения WhatsApp Business).",
    );
  }
  await sendAndStore(waId, text, "owner");
  await ownerTookOver(waId);
}

async function requireOpenWindow(waId: string) {
  const c = await getContact(waId);
  if (!c) throw new Error("Контакт не найден");
  if (!c.last_inbound_at || Date.now() - new Date(c.last_inbound_at).getTime() > WINDOW_MS) {
    throw new Error(
      "Прошло больше 24 часов с последнего сообщения клиента. По правилам WhatsApp можно написать только через одобренный шаблон (или ответить из приложения WhatsApp Business).",
    );
  }
}

/** Sends a media-library item and records it in the chat history. */
export async function sendLibraryAndStore(waId: string, mediaId: number, sender: "ai" | "owner") {
  try {
    const { waId: msgId, item } = await sendLibraryItem(waId, mediaId);
    await insertMessage({
      wa_message_id: msgId || null,
      wa_id: waId,
      direction: "out",
      sender,
      type: item.kind,
      text: mediaLabel(item.kind, item.title),
      status: "sent",
    });
  } catch (e) {
    await insertMessage({ wa_id: waId, direction: "out", sender, type: "document", text: `📎 файл #${mediaId}`, status: "failed", error: (e as Error).message });
    throw e;
  }
  await updateContact(waId, { last_message_at: new Date() });
}

/** Owner sends a file from the panel (a one-off attachment or a media-library item). */
export async function ownerSendFile(
  waId: string,
  file: { libraryId?: number; data?: Buffer; mime?: string; filename?: string; caption?: string },
) {
  await requireOpenWindow(waId);
  if (file.libraryId) {
    await sendLibraryAndStore(waId, file.libraryId, "owner");
  } else if (file.data && file.mime) {
    const r = await sendOneOffFile(waId, { data: file.data, mime: file.mime, filename: file.filename ?? "", caption: file.caption });
    await insertMessage({
      wa_message_id: r.waId || null,
      wa_id: waId,
      direction: "out",
      sender: "owner",
      type: r.kind,
      text: mediaLabel(r.kind, file.caption?.trim() || r.filename),
      status: "sent",
    });
    await updateContact(waId, { last_message_at: new Date() });
  } else {
    throw new Error("Файл не выбран");
  }
  await ownerTookOver(waId);
}

// ---------------- Housekeeping ----------------

export async function cleanupOldData() {
  const s = await getSettings();
  if (s.retention_days <= 0) return;
  const d = getDb();
  await d.query(`DELETE FROM messages WHERE created_at < now() - ($1::int * interval '1 day')`, [s.retention_days]);
  await d.query(`DELETE FROM events WHERE created_at < now() - ($1::int * interval '1 day')`, [s.retention_days]);
  await d.query(`UPDATE usage SET wa_id = NULL WHERE wa_id IS NOT NULL AND created_at < now() - ($1::int * interval '1 day')`, [s.retention_days]);
  await d.query(
    `DELETE FROM contacts c WHERE c.last_message_at < now() - ($1::int * interval '1 day')
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.wa_id = c.wa_id)`,
    [s.retention_days],
  );
}
