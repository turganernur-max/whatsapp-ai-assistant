import crypto from "node:crypto";
import { config } from "./config.js";
import { getDb } from "./db.js";

/**
 * Connecting the owner's own WhatsApp Business app number (coexistence) through Meta's
 * Embedded Signup. The popup returns a short-lived code; the server exchanges it for a
 * business token (does not expire), finds the WhatsApp Business Account and phone number,
 * subscribes this app to its webhooks and switches the assistant to that number.
 * The token is stored encrypted in the database (key derived from SESSION_SECRET).
 */

const KEY_NAME = "_wa_connection";

export interface WaConnection {
  token: string;
  phoneNumberId: string;
  wabaId: string;
  displayPhone?: string;
  verifiedName?: string;
  connectedAt: string;
}

export class SignupError extends Error {}

function key() {
  return crypto.createHash("sha256").update(`wa-connection|${config.sessionSecret}`).digest();
}
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}
export function decrypt(blob: string): string {
  const [iv, tag, data] = blob.split(".").map((p) => Buffer.from(p, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

const envDefaults = { token: "", phoneNumberId: "", wabaId: "" };
let current: WaConnection | null = null;

/** Remembers the values from Render (env) so we can switch back to them. */
export function rememberEnvCredentials() {
  envDefaults.token = config.waToken;
  envDefaults.phoneNumberId = config.waPhoneNumberId;
  envDefaults.wabaId = config.waBusinessAccountId;
}

function apply(c: WaConnection | null) {
  current = c;
  config.waToken = c ? c.token : envDefaults.token;
  config.waPhoneNumberId = c ? c.phoneNumberId : envDefaults.phoneNumberId;
  config.waBusinessAccountId = c ? c.wabaId : envDefaults.wabaId;
}

/** On start-up: use the connected own number if there is one. */
export async function loadConnection() {
  rememberEnvCredentials();
  const [row] = await getDb().query<{ value: { enc: string } }>(`SELECT value FROM settings WHERE key = $1`, [KEY_NAME]);
  if (!row?.value?.enc) return;
  try {
    apply(JSON.parse(decrypt(row.value.enc)));
  } catch {
    console.error("[signup] stored WhatsApp connection could not be decrypted (SESSION_SECRET changed?) — using env values");
  }
}

export function connectionInfo() {
  return current
    ? { source: "own" as const, phone: current.displayPhone ?? null, name: current.verifiedName ?? null, connected_at: current.connectedAt }
    : { source: "env" as const };
}

export function signupConfig() {
  const missing: string[] = [];
  if (!config.metaAppId) missing.push("META_APP_ID");
  if (!config.esConfigId) missing.push("META_ES_CONFIG_ID");
  if (!config.waAppSecret) missing.push("META_APP_SECRET");
  return {
    ready: missing.length === 0,
    missing,
    app_id: config.metaAppId || null,
    config_id: config.esConfigId || null,
    graph_version: config.graphVersion,
    session_info_version: config.esSessionInfoVersion,
    page_origin: config.publicUrl || null,
  };
}

async function graph(method: "GET" | "POST", path: string, token?: string, body?: unknown) {
  const url = `${config.graphBase}/${config.graphVersion}/${path.replace(/^\//, "")}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = String(json?.error?.error_user_msg || json?.error?.message || `HTTP ${res.status}`);
    throw new SignupError(msg.replace(/EAA[A-Za-z0-9_-]{10,}/g, "EAA…"));
  }
  return json;
}

/** Finishes Embedded Signup: code → token → WABA/phone → webhooks → switch. */
export async function completeSignup(input: { code: string; phoneNumberId?: string; wabaId?: string }) {
  const cfg = signupConfig();
  if (!cfg.ready) throw new SignupError(`Не заданы переменные в Render: ${cfg.missing.join(", ")}`);

  // 1) Exchange the one-time code for a business token.
  const q = new URLSearchParams({ client_id: config.metaAppId, client_secret: config.waAppSecret, code: input.code });
  const tok = await graph("GET", `oauth/access_token?${q}`);
  const token = String(tok.access_token || "");
  if (!token) throw new SignupError("Meta не вернула токен");

  // 2) Which WhatsApp account and number were shared?
  let wabaId = input.wabaId || "";
  if (!wabaId) {
    const dbg = await graph("GET", `debug_token?input_token=${encodeURIComponent(token)}`, `${config.metaAppId}|${config.waAppSecret}`);
    const scopes: any[] = dbg?.data?.granular_scopes ?? [];
    const s = scopes.find((x) => x.scope === "whatsapp_business_management") ?? scopes.find((x) => x.scope === "whatsapp_business_messaging");
    wabaId = String(s?.target_ids?.[0] ?? "");
  }
  if (!wabaId) throw new SignupError("Не удалось определить аккаунт WhatsApp Business. Попробуйте подключить ещё раз.");

  let phoneNumberId = input.phoneNumberId || "";
  const numbers = await graph("GET", `${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,platform_type`, token);
  const list: any[] = numbers?.data ?? [];
  if (!phoneNumberId) phoneNumberId = String(list[0]?.id ?? "");
  const phone = list.find((p) => String(p.id) === phoneNumberId);
  if (!phoneNumberId || !phone) throw new SignupError("Номер не найден в подключённом аккаунте. Попробуйте ещё раз.");

  // 3) Deliver this account's messages to our webhook.
  await graph("POST", `${wabaId}/subscribed_apps`, token);

  // 4) Save (encrypted) and switch.
  const conn: WaConnection = {
    token,
    phoneNumberId,
    wabaId,
    displayPhone: phone.display_phone_number,
    verifiedName: phone.verified_name,
    connectedAt: new Date().toISOString(),
  };
  await getDb().query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY_NAME, JSON.stringify({ enc: encrypt(JSON.stringify(conn)) })],
  );
  apply(conn);
  return { phone: phone.display_phone_number, name: phone.verified_name, phone_number_id: phoneNumberId, waba_id: wabaId };
}

/** Switch back to the number configured in Render (e.g. the Meta test number). */
export async function disconnectOwnNumber() {
  await getDb().query(`DELETE FROM settings WHERE key = $1`, [KEY_NAME]);
  apply(null);
}
