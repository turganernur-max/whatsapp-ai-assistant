import { getDb } from "./db.js";
import type { CatalogItem, OrderDraft } from "./ai.js";
import { getContact, logEvent } from "./store.js";
import { notifyOwner } from "./notify.js";
import { listMedia } from "./media.js";
import { getSettings } from "./settings.js";
import type { MediaOption } from "./ai.js";

/** Everything the AI needs to sell: the catalog plus the files it may send (library + product photos). */
/** Interview times already booked (open, not cancelled) — the AI must not offer them again. */
export async function busyInterviewSlots(): Promise<string[]> {
  const rows = await getDb().query<{ address: string; items: string }>(
    `SELECT address, items FROM orders WHERE status NOT IN ('cancelled','done') AND address <> ''
       AND created_at > now() - interval '60 days' ORDER BY id DESC LIMIT 200`,
  );
  return rows.map((r) => `${r.address}${r.items ? " (" + r.items + ")" : ""}`);
}

export async function aiSalesContext(): Promise<{ catalog: CatalogItem[]; media: MediaOption[]; busySlots: string[] }> {
  const busySlots = await busyInterviewSlots();
  const catalog = await listCatalog();
  const wanted = new Set(catalogMediaIds(catalog));
  const all = await listMedia(false);
  const media = all
    .filter((m) => m.enabled || wanted.has(m.id))
    .map((m) => ({ id: m.id, title: m.title, description: m.description, kind: m.kind }));
  return { catalog, media, busySlots };
}

/** Converts a local wall-clock time in a time zone to a Date (UTC). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asLocal = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess - (asLocal - guess));
}

/** Reads "ДД.ММ.ГГГГ ЧЧ:ММ" (also "ДД.ММ ЧЧ:ММ") from the interview field. */
export function parseInterviewTime(text: string, tz: string, now = new Date()): Date | null {
  const m = /(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\D{0,12}?(\d{1,2})[:.](\d{2})/.exec(text || "");
  if (!m) return null;
  let y = m[3] ? Number(m[3]) : now.getUTCFullYear();
  if (y < 100) y += 2000;
  const [d, mo, h, mi] = [Number(m[1]), Number(m[2]), Number(m[4]), Number(m[5])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  let at = zonedToUtc(y, mo, d, h, mi, tz);
  if (!m[3] && at.getTime() < now.getTime() - 30 * 86400_000) at = zonedToUtc(y + 1, mo, d, h, mi, tz);
  return at;
}

/** Candidate confirmed attendance: mark the upcoming interview. */
export async function interviewConfirmed(waId: string) {
  const rows = await getDb().query<{ id: number }>(
    `UPDATE orders SET confirmed_at = now(), status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END, updated_at = now()
     WHERE id = (SELECT id FROM orders WHERE wa_id = $1 AND status IN ('new','contacted') ORDER BY id DESC LIMIT 1)
     RETURNING id`,
    [waId],
  );
  if (rows.length) await logEvent("order", waId, `Кандидат подтвердил собеседование #${rows[0].id}`);
}

export const ORDER_STATUSES = ["new", "contacted", "payment_check", "paid", "shipped", "done", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
const OPEN = ["new", "contacted", "payment_check"];

export async function listCatalog(): Promise<CatalogItem[]> {
  return getDb().query<CatalogItem>(
    `SELECT id, kind, name, category, price, price_note, description, in_stock, media_id FROM catalog ORDER BY category, name, id`,
  );
}

/** Media ids referenced by the catalog (the AI may send these as product photos). */
export function catalogMediaIds(items: CatalogItem[]): number[] {
  return [...new Set(items.map((i) => i.media_id).filter((x): x is number => typeof x === "number"))];
}

function money(n: number) {
  return n > 0 ? `${Math.round(n).toLocaleString("ru-RU")} ₸` : "сумма не указана";
}

/**
 * Saves a confirmed order from the conversation. If the client already has an open order
 * from the last 24 hours, it is updated instead of creating a duplicate.
 */
export async function saveOrder(waId: string, o: OrderDraft): Promise<{ id: number; created: boolean }> {
  const d = getDb();
  const [open] = await d.query<{ id: number }>(
    `SELECT id FROM orders WHERE wa_id = $1 AND status = ANY($2::text[]) AND created_at > now() - interval '24 hours'
     ORDER BY id DESC LIMIT 1`,
    [waId, OPEN],
  );
  const st = await getSettings();
  const interviewAt = st.business_mode === "recruiting" ? parseInterviewTime(o.address, st.timezone || "Asia/Almaty") : null;
  const vals = [o.items, o.total, o.customer_name, o.city, o.address, o.delivery, o.comment, interviewAt];
  if (open) {
    await d.query(
      `UPDATE orders SET items=$2, total=$3, customer_name=$4, city=$5, address=$6, delivery=$7, comment=$8,
         reminder_sent_at = CASE WHEN interview_at IS DISTINCT FROM $9 THEN NULL ELSE reminder_sent_at END,
         confirmed_at = CASE WHEN interview_at IS DISTINCT FROM $9 THEN NULL ELSE confirmed_at END,
         interview_at=$9, updated_at=now() WHERE id=$1`,
      [open.id, ...vals],
    );
    await logEvent("order", waId, `Заказ #${open.id} изменён: ${o.items} — ${money(o.total)}`);
    return { id: open.id, created: false };
  }
  const [row] = await d.query<{ id: number }>(
    `INSERT INTO orders (wa_id, items, total, customer_name, city, address, delivery, comment, interview_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [waId, ...vals],
  );
  await logEvent("order", waId, `Новый заказ #${row.id}: ${o.items} — ${money(o.total)}`);
  const c = await getContact(waId);
  const recruiting = st.business_mode === "recruiting";
  await notifyOwner(
    recruiting ? `🗓 Запись на собеседование: ${o.address || "время не указано"}` : `🛒 Новый заказ #${row.id} — ${money(o.total)}`,
    recruiting
      ? `${o.customer_name || c?.name || "+" + waId} — ${o.items}${o.city ? ", " + o.city : ""}`
      : `${o.customer_name || c?.name || "+" + waId}${o.city ? ", " + o.city : ""}: ${o.items}`,
    `/#orders`,
  );
  return { id: row.id, created: true };
}

/** Client says they paid: move the latest open order to "check payment" and alert the owner. */
export async function paymentClaimed(waId: string) {
  const d = getDb();
  const [o] = await d.query<{ id: number; total: number; status: string }>(
    `SELECT id, total, status FROM orders WHERE wa_id = $1 AND status <> 'cancelled' ORDER BY id DESC LIMIT 1`,
    [waId],
  );
  const c = await getContact(waId);
  const who = c?.name || "+" + waId;
  if (o && (o.status === "new" || o.status === "contacted")) {
    await d.query(`UPDATE orders SET status = 'payment_check', payment_claimed_at = now(), updated_at = now() WHERE id = $1`, [o.id]);
  }
  await logEvent("payment", waId, o ? `Клиент сообщил об оплате заказа #${o.id}` : "Клиент сообщил об оплате (заказ не найден)");
  await notifyOwner(
    "💳 Проверьте оплату в Kaspi",
    o ? `${who} — заказ #${o.id}, ${money(o.total)}` : `${who} сообщил об оплате`,
    `/#orders`,
  );
}
