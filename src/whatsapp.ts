import crypto from "node:crypto";
import { config, tokenProblem } from "./config.js";

/** Removes access tokens from any text before it is logged or shown in the panel. */
export function redact(text: string): string {
  let out = String(text ?? "");
  if (config.waToken && config.waToken.length >= 8) out = out.split(config.waToken).join("EAA…(скрыто)");
  return out.replace(/EAA[A-Za-z0-9_\-]{10,}/g, "EAA…(скрыто)").replace(/Bearer\s+\S+/g, "Bearer …(скрыто)");
}

export class WhatsAppError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: number,
    public retryable = false,
  ) {
    super(redact(message));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function graphUrl(p: string) {
  return `${config.graphBase}/${config.graphVersion}/${p.replace(/^\//, "")}`;
}

// Simple global pacing so we never burst messages (WhatsApp throughput & quality rules).
let lastSendAt = 0;
const MIN_SEND_GAP_MS = 250;
async function pace() {
  const wait = lastSendAt + MIN_SEND_GAP_MS - Date.now();
  lastSendAt = Math.max(Date.now(), lastSendAt + MIN_SEND_GAP_MS);
  if (wait > 0) await sleep(wait);
}

async function graph(method: "GET" | "POST", p: string, body?: unknown, attempts = 3): Promise<any> {
  if (!config.waToken) throw new WhatsAppError("WHATSAPP_TOKEN не настроен", 0);
  const problem = tokenProblem(config.waToken);
  if (problem) throw new WhatsAppError(problem, 0);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(p.startsWith("http") ? p : graphUrl(p), {
        method,
        headers: {
          Authorization: `Bearer ${config.waToken}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      let json: any = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text };
      }
      if (res.ok) return json;
      const err = json?.error ?? {};
      const retryable = res.status === 429 || res.status >= 500 || err.is_transient === true;
      const msg = [err.message, err.error_data?.details].filter(Boolean).join(" — ") || `HTTP ${res.status}`;
      lastErr = new WhatsAppError(msg, res.status, err.code, retryable);
      if (!retryable) throw lastErr;
    } catch (e) {
      if (e instanceof WhatsAppError && !e.retryable) throw e;
      lastErr = e;
    }
    await sleep(500 * 2 ** i);
  }
  if (lastErr instanceof WhatsAppError) throw lastErr;
  throw new WhatsAppError(`Сеть недоступна: ${(lastErr as Error)?.message ?? lastErr}`, 0, undefined, true);
}

/** Splits long text into WhatsApp-sized chunks (max 4096 chars), preferring paragraph/sentence boundaries. */
export function splitMessage(text: string, max = 4000): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(". ", max) + 1;
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Meta's test-number allow list stores Kazakhstan/Russia numbers with an extra "8"
 * after the country code (7 8707… instead of 7 707…), while incoming messages use the
 * normal wa_id. When Meta answers #131030 "Recipient phone number not in allowed list",
 * we retry with that alternate spelling and remember which one works.
 */
export function alternateRecipient(to: string): string | null {
  if (/^7[67]\d{9}$/.test(to)) return "78" + to.slice(1);
  if (/^78[67]\d{9}$/.test(to)) return "7" + to.slice(2);
  return null;
}
const recipientOverride = new Map<string, string>();

/** Sends any message payload to `to`, retrying with the allow-list spelling on #131030. */
async function sendMessage(to: string, payload: Record<string, unknown>): Promise<string> {
  const send = async (recipient: string) => {
    await pace();
    const res = await graph("POST", `${config.waPhoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      ...payload,
    });
    return res?.messages?.[0]?.id ?? "";
  };
  const first = recipientOverride.get(to) ?? to;
  try {
    return await send(first);
  } catch (e) {
    const alt = first === to ? alternateRecipient(to) : null;
    if (!(e instanceof WhatsAppError) || e.code !== 131030 || !alt) throw e;
    const id = await send(alt);
    recipientOverride.set(to, alt);
    return id;
  }
}

export async function sendText(to: string, body: string): Promise<string> {
  return sendMessage(to, { type: "text", text: { body, preview_url: false } });
}

export type MediaKind = "image" | "video" | "document";

/** WhatsApp limits and accepted formats for media sent by a business. */
export const MEDIA_RULES: Record<MediaKind, { maxBytes: number; mimes: string[] }> = {
  image: { maxBytes: 5 * 1024 * 1024, mimes: ["image/jpeg", "image/png"] },
  video: { maxBytes: 16 * 1024 * 1024, mimes: ["video/mp4", "video/3gpp"] },
  document: { maxBytes: 16 * 1024 * 1024, mimes: [] }, // any type
};

/** Uploads a file to WhatsApp and returns its media id (valid ~30 days). */
export async function uploadMedia(data: Buffer, mimeType: string, filename: string): Promise<string> {
  if (!config.waToken) throw new WhatsAppError("WHATSAPP_TOKEN не настроен", 0);
  const problem = tokenProblem(config.waToken);
  if (problem) throw new WhatsAppError(problem, 0);
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([new Uint8Array(data)], { type: mimeType }), filename);
  const res = await fetch(graphUrl(`${config.waPhoneNumberId}/media`), {
    method: "POST",
    headers: { Authorization: `Bearer ${config.waToken}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json?.id) {
    const err = json?.error ?? {};
    throw new WhatsAppError(
      [err.message, err.error_data?.details].filter(Boolean).join(" — ") || `Не удалось загрузить файл: HTTP ${res.status}`,
      res.status,
      err.code,
    );
  }
  return String(json.id);
}

export async function sendMediaMessage(
  to: string,
  kind: MediaKind,
  mediaId: string,
  caption?: string,
  filename?: string,
): Promise<string> {
  const body: Record<string, unknown> = { id: mediaId };
  if (caption) body.caption = caption.slice(0, 1024);
  if (kind === "document" && filename) body.filename = filename;
  return sendMessage(to, { type: kind, [kind]: body });
}

/** Sends an approved template (the only way to write first / after the 24h window). */
export async function sendTemplate(to: string, name: string, languageCode: string, bodyParams: string[] = []): Promise<string> {
  const template: Record<string, unknown> = { name, language: { code: languageCode } };
  if (bodyParams.length) {
    template.components = [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }];
  }
  return sendMessage(to, { type: "template", template });
}

export interface TemplateInfo {
  name: string;
  language: string;
  status: string;
  category: string;
  body: string;
  params: number;
  rejected_reason?: string;
}

/** Number of {{n}} variables in a template body. */
export function countParams(body: string): number {
  const nums = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

export async function listTemplates(): Promise<TemplateInfo[]> {
  if (!config.waBusinessAccountId) throw new WhatsAppError("WHATSAPP_BUSINESS_ACCOUNT_ID не настроен", 0);
  const res = await graph(
    "GET",
    `${config.waBusinessAccountId}/message_templates?fields=name,language,status,category,components,rejected_reason&limit=200`,
    undefined,
    2,
  );
  return (res?.data ?? []).map((t: any) => {
    const body = String((t.components ?? []).find((c: any) => c.type === "BODY")?.text ?? "");
    return {
      name: t.name,
      language: t.language,
      status: t.status,
      category: t.category,
      body,
      params: countParams(body),
      rejected_reason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : undefined,
    };
  });
}

/** Creates a simple text template; {{1}} (optional) is the client's name. Meta reviews it before use. */
export async function createTemplate(input: { name: string; category: "MARKETING" | "UTILITY"; language: string; body: string }) {
  if (!config.waBusinessAccountId) throw new WhatsAppError("WHATSAPP_BUSINESS_ACCOUNT_ID не настроен", 0);
  const params = countParams(input.body);
  const component: Record<string, unknown> = { type: "BODY", text: input.body };
  if (params) component.example = { body_text: [Array.from({ length: params }, (_, i) => (i === 0 ? "Айгерим" : `пример ${i + 1}`))] };
  return graph("POST", `${config.waBusinessAccountId}/message_templates`, {
    name: input.name,
    category: input.category,
    language: input.language,
    components: [component],
  }, 1);
}

/** Marks a message as read and shows "typing…" to the customer (best effort). */
export async function markReadAndTyping(messageId: string, typing = true): Promise<void> {
  try {
    await graph(
      "POST",
      `${config.waPhoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        ...(typing ? { typing_indicator: { type: "text" } } : {}),
      },
      1,
    );
  } catch (e) {
    console.warn("[wa] mark read failed:", (e as Error).message);
  }
}

export async function downloadMedia(mediaId: string, maxBytes = 16 * 1024 * 1024) {
  const meta = await graph("GET", mediaId);
  if (!meta?.url) throw new WhatsAppError("Нет URL медиафайла", 0);
  if (meta.file_size && meta.file_size > maxBytes) throw new WhatsAppError("Файл слишком большой", 0);
  const res = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${config.waToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new WhatsAppError(`Не удалось скачать файл: HTTP ${res.status}`, res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  return { data: buf, mimeType: String(meta.mime_type ?? res.headers.get("content-type") ?? "") };
}

export async function getPhoneInfo() {
  return graph(
    "GET",
    `${config.waPhoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,name_status,platform_type,throughput,messaging_limit_tier`,
    undefined,
    1,
  );
}

export async function getSubscribedApps() {
  if (!config.waBusinessAccountId) throw new WhatsAppError("WHATSAPP_BUSINESS_ACCOUNT_ID не настроен", 0);
  return graph("GET", `${config.waBusinessAccountId}/subscribed_apps`, undefined, 1);
}

export async function subscribeApp() {
  if (!config.waBusinessAccountId) throw new WhatsAppError("WHATSAPP_BUSINESS_ACCOUNT_ID не настроен", 0);
  return graph("POST", `${config.waBusinessAccountId}/subscribed_apps`, undefined, 1);
}

/** Validates Meta's X-Hub-Signature-256 header against the raw request body. */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!appSecret || !header || !header.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const got = header.slice("sha256=".length);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(expected, "utf8"));
}

// ---------- Webhook payload parsing ----------

export interface InboundMessage {
  kind: "message";
  waMessageId: string;
  from: string;
  name?: string;
  timestamp: number;
  type: string;
  text?: string;
  mediaId?: string;
  mimeType?: string;
}
export interface StatusUpdate {
  kind: "status";
  waMessageId: string;
  status: string;
  recipient: string;
  error?: string;
}
export interface EchoMessage {
  kind: "echo"; // message the owner sent from the WhatsApp Business app (coexistence mode)
  waMessageId: string;
  to: string;
  timestamp: number;
  type: string;
  text?: string;
}
export type WebhookEvent = InboundMessage | StatusUpdate | EchoMessage;

function describe(m: any): { text?: string; mediaId?: string; mimeType?: string } {
  switch (m.type) {
    case "text":
      return { text: m.text?.body ?? "" };
    case "audio":
      return { mediaId: m.audio?.id, mimeType: m.audio?.mime_type };
    case "image":
      return { mediaId: m.image?.id, mimeType: m.image?.mime_type, text: m.image?.caption };
    case "video":
      return { mediaId: m.video?.id, text: m.video?.caption ? `[видео] ${m.video.caption}` : "[видео]" };
    case "document":
      return {
        mediaId: m.document?.id,
        text: `[документ: ${m.document?.filename ?? "файл"}]${m.document?.caption ? " " + m.document.caption : ""}`,
      };
    case "sticker":
      return { text: "[стикер]" };
    case "location": {
      const l = m.location ?? {};
      return { text: `[геолокация] ${[l.name, l.address].filter(Boolean).join(", ")} (${l.latitude}, ${l.longitude})` };
    }
    case "contacts":
      return { text: `[контакт] ${(m.contacts ?? []).map((c: any) => c?.name?.formatted_name).join(", ")}` };
    case "button":
      return { text: m.button?.text ?? "" };
    case "interactive":
      return {
        text: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "[интерактивный ответ]",
      };
    case "reaction":
      return { text: m.reaction?.emoji ? `[реакция ${m.reaction.emoji}]` : "[реакция снята]" };
    default:
      return { text: `[${m.type ?? "unknown"}]` };
  }
}

/** Extracts events for our phone number from a webhook payload. Anything else is ignored. */
export function parseWebhook(payload: any, phoneNumberId: string): WebhookEvent[] {
  const out: WebhookEvent[] = [];
  if (payload?.object !== "whatsapp_business_account") return out;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const pid = v.metadata?.phone_number_id;
      if (phoneNumberId && pid && pid !== phoneNumberId) continue;
      if (change.field === "messages") {
        const names = new Map<string, string>();
        for (const c of v.contacts ?? []) names.set(c.wa_id, c.profile?.name);
        for (const m of v.messages ?? []) {
          if (!m?.id || !m?.from) continue;
          out.push({
            kind: "message",
            waMessageId: m.id,
            from: m.from,
            name: names.get(m.from),
            timestamp: Number(m.timestamp) || Math.floor(Date.now() / 1000),
            type: m.type,
            ...describe(m),
          });
        }
        for (const s of v.statuses ?? []) {
          if (!s?.id) continue;
          out.push({
            kind: "status",
            waMessageId: s.id,
            status: s.status,
            recipient: s.recipient_id,
            error: s.errors?.[0] ? `${s.errors[0].code}: ${s.errors[0].title}` : undefined,
          });
        }
      } else if (change.field === "smb_message_echoes") {
        for (const m of v.message_echoes ?? []) {
          if (!m?.id || !m?.to) continue;
          out.push({
            kind: "echo",
            waMessageId: m.id,
            to: m.to,
            timestamp: Number(m.timestamp) || Math.floor(Date.now() / 1000),
            type: m.type,
            text: describe(m).text,
          });
        }
      }
    }
  }
  return out;
}
