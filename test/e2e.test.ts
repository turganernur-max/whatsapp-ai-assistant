import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.NODE_ENV = "test";
const { config } = await import("../src/config.js");
const { initDb, getDb } = await import("../src/db.js");
const { buildServer } = await import("../src/server.js");
const { drain, startProcessor, recover } = await import("../src/processor.js");
const { setClientForTests } = await import("../src/ai.js");
const { updateSettings, clearSettingsCache } = await import("../src/settings.js");

// ---------- Fake WhatsApp Graph API ----------
const sent: any[] = [];
let failSends = false;
const graph = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    assert.equal(req.headers.authorization, "Bearer TEST_TOKEN");
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url?.endsWith("/PN1/messages")) {
      const b = JSON.parse(body);
      if (b.status === "read") return res.end('{"success":true}');
      if (failSends) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: "Recipient not allowed", code: 131030 } }));
      }
      sent.push(b);
      return res.end(JSON.stringify({ messages: [{ id: "wamid.OUT" + sent.length }] }));
    }
    if (req.method === "GET" && req.url?.includes("/PN1?")) {
      return res.end(JSON.stringify({ display_phone_number: "+1 555 0100", verified_name: "Test", quality_rating: "GREEN" }));
    }
    if (req.url?.includes("/WABA1/subscribed_apps")) return res.end(JSON.stringify({ data: [{ id: 1 }], success: true }));
    res.statusCode = 404;
    res.end("{}");
  });
});

// ---------- Fake Claude ----------
const claudeCalls: any[] = [];
let nextReply: any = { reply: "Здравствуйте! Стрижка стоит 5000 ₸.", handoff: false, handoff_reason: "" };
let claudeError: Error | null = null;
setClientForTests({
  beta: {
    messages: {
      create: async (params: any) => {
        claudeCalls.push(params);
        if (claudeError) {
          const e = claudeError;
          claudeError = null;
          throw e;
        }
        return {
          model: params.model,
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(nextReply) }],
          usage: { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 1500 },
        };
      },
    },
  },
} as any);

let app: Awaited<ReturnType<typeof buildServer>>;
let msgCounter = 0;

function signed(payload: unknown) {
  const raw = JSON.stringify(payload);
  const sig = "sha256=" + crypto.createHmac("sha256", "APPSECRET").update(raw).digest("hex");
  return { raw, sig };
}
async function postWebhook(payload: unknown) {
  const { raw, sig } = signed(payload);
  return app.inject({ method: "POST", url: "/webhook", payload: raw, headers: { "content-type": "application/json", "x-hub-signature-256": sig } });
}
function inbound(from: string, text: string, id = `wamid.IN${++msgCounter}`) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "15550100", phone_number_id: "PN1" },
      contacts: [{ profile: { name: "Клиент " + from }, wa_id: from }],
      messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
    } }] }],
  };
}
async function login() {
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { password: "pass123" } });
  assert.equal(r.statusCode, 200);
  const c = r.cookies.find((x) => x.name === "wa_sid")!;
  return { cookie: `wa_sid=${c.value}`, "x-requested-with": "panel" };
}

before(async () => {
  await new Promise<void>((r) => graph.listen(0, "127.0.0.1", () => r()));
  const port = (graph.address() as AddressInfo).port;
  Object.assign(config, {
    graphBase: `http://127.0.0.1:${port}`,
    waToken: "TEST_TOKEN",
    waPhoneNumberId: "PN1",
    waBusinessAccountId: "WABA1",
    waAppSecret: "APPSECRET",
    waVerifyToken: "VERIFY",
    anthropicApiKey: "test",
    adminPassword: "pass123",
    sessionSecret: "s".repeat(32),
    debounceMs: 30,
    ntfyTopic: "",
  });
  await initDb(process.env.TEST_DATABASE_URL ? { url: process.env.TEST_DATABASE_URL } : { dir: "memory" });
  startProcessor();
  app = await buildServer();
});

after(async () => {
  await app.close();
  await getDb().close();
  graph.close();
});

beforeEach(async () => {
  sent.length = 0;
  claudeCalls.length = 0;
  failSends = false;
  nextReply = { reply: "Здравствуйте! Стрижка стоит 5000 ₸.", handoff: false, handoff_reason: "" };
  const d = getDb();
  await d.exec(`DELETE FROM messages; DELETE FROM contacts; DELETE FROM usage; DELETE FROM events; DELETE FROM settings; DELETE FROM knowledge;`);
  clearSettingsCache();
  await updateSettings({ ai_enabled: true });
});

test("webhook verification handshake", async () => {
  const ok = await app.inject({ url: "/webhook?hub.mode=subscribe&hub.verify_token=VERIFY&hub.challenge=12345" });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body, "12345");
  const bad = await app.inject({ url: "/webhook?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=1" });
  assert.equal(bad.statusCode, 403);
});

test("rejects unsigned or forged webhooks", async () => {
  const raw = JSON.stringify(inbound("77010000001", "hi"));
  const r1 = await app.inject({ method: "POST", url: "/webhook", payload: raw, headers: { "content-type": "application/json" } });
  assert.equal(r1.statusCode, 401);
  const r2 = await app.inject({ method: "POST", url: "/webhook", payload: raw, headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + "0".repeat(64) } });
  assert.equal(r2.statusCode, 401);
  await drain();
  assert.equal(sent.length, 0);
});

test("full flow: inbound -> Claude -> reply with AI disclosure, KB in prompt, dedup", async () => {
  await getDb().query(`INSERT INTO knowledge (title, content) VALUES ('Цены', 'Стрижка — 5000 ₸')`);
  const payload = inbound("77010000002", "Сколько стоит стрижка?", "wamid.DUP1");
  assert.equal((await postWebhook(payload)).statusCode, 200);
  assert.equal((await postWebhook(payload)).statusCode, 200); // Meta re-delivery
  await drain();
  assert.equal(claudeCalls.length, 1, "Claude called exactly once despite duplicate webhook");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "77010000002");
  assert.match(sent[0].text.body, /AI-помощник/);
  assert.match(sent[0].text.body, /5000 ₸/);
  const call = claudeCalls[0];
  assert.equal(call.model, "claude-opus-5-5");
  assert.match(call.system[0].text, /Стрижка — 5000 ₸/);
  assert.equal(call.system[0].cache_control.type, "ephemeral");
  assert.equal(call.output_config.format.type, "json_schema");
  assert.equal(call.fallbacks, "default");

  // Second message: no disclosure again, history included
  nextReply = { reply: "Да, записываю вас на 15:00.", handoff: false, handoff_reason: "" };
  await postWebhook(inbound("77010000002", "Можно на 15:00?"));
  await drain();
  assert.equal(sent.length, 2);
  assert.doesNotMatch(sent[1].text.body, /AI-помощник/);
  const msgs = claudeCalls[1].messages;
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[1].role, "assistant");

  // Delivery status update
  await postWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN1" }, statuses: [{ id: "wamid.OUT1", status: "read", recipient_id: "77010000002" }] } }] }] });
  const [m] = await getDb().query(`SELECT status FROM messages WHERE wa_message_id = 'wamid.OUT1'`);
  assert.equal(m.status, "read");
  const usage = await getDb().query(`SELECT * FROM usage`);
  assert.equal(usage.length, 2);
  assert.ok(usage[0].cost_usd > 0);
});

test("rapid messages are batched into one reply", async () => {
  await postWebhook(inbound("77010000003", "Здравствуйте"));
  await postWebhook(inbound("77010000003", "Есть доставка?"));
  await postWebhook(inbound("77010000003", "В Алматы"));
  await drain();
  assert.equal(claudeCalls.length, 1);
  assert.equal(sent.length, 1);
});

test("AI switched off globally or per contact -> no reply", async () => {
  await updateSettings({ ai_enabled: false });
  await postWebhook(inbound("77010000004", "Привет"));
  await drain();
  assert.equal(claudeCalls.length, 0);
  assert.equal(sent.length, 0);

  await updateSettings({ ai_enabled: true });
  const h = await login();
  const r = await app.inject({ method: "PATCH", url: "/api/contacts/77010000004", headers: h, payload: { ai_enabled: false } });
  assert.equal(r.statusCode, 200);
  await postWebhook(inbound("77010000004", "Ау?"));
  await drain();
  assert.equal(claudeCalls.length, 0);
});

test("handoff: owner notified, contact flagged and AI paused", async () => {
  nextReply = { reply: "", handoff: true, handoff_reason: "Клиент просит возврат денег" };
  await postWebhook(inbound("77010000005", "Верните деньги!"));
  await drain();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text.body, /передал ваш вопрос владельцу/);
  const [c] = await getDb().query(`SELECT * FROM contacts WHERE wa_id = '77010000005'`);
  assert.equal(c.needs_attention, true);
  assert.equal(c.attention_reason, "Клиент просит возврат денег");
  assert.ok(new Date(c.paused_until) > new Date());
  await postWebhook(inbound("77010000005", "Ну что?"));
  await drain();
  assert.equal(claudeCalls.length, 1, "AI stays silent after handoff");
});

test("owner takeover from WhatsApp Business app (echo) pauses AI", async () => {
  await postWebhook(inbound("77010000006", "Здравствуйте"));
  await postWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "smb_message_echoes", value: { metadata: { phone_number_id: "PN1" }, message_echoes: [{ id: "wamid.ECHO1", from: "15550100", to: "77010000006", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Сейчас отвечу лично" } }] } }] }] });
  await drain();
  assert.equal(claudeCalls.length, 0, "pending message skipped because owner replied");
  const rows = await getDb().query(`SELECT sender, text FROM messages WHERE wa_id = '77010000006' ORDER BY id`);
  assert.deepEqual(rows.map((r: any) => r.sender), ["contact", "owner"]);
});

test("owner sends from the panel; 24h window enforced; CSRF header required", async () => {
  await updateSettings({ ai_enabled: false });
  await postWebhook(inbound("77010000007", "Есть кто?"));
  await drain();
  const h = await login();
  const noCsrf = await app.inject({ method: "POST", url: "/api/contacts/77010000007/send", headers: { cookie: h.cookie }, payload: { text: "x" } });
  assert.equal(noCsrf.statusCode, 403);
  const ok = await app.inject({ method: "POST", url: "/api/contacts/77010000007/send", headers: h, payload: { text: "Да, слушаю вас" } });
  assert.equal(ok.statusCode, 200);
  assert.equal(sent.at(-1).text.body, "Да, слушаю вас");
  await getDb().query(`UPDATE contacts SET last_inbound_at = now() - interval '25 hours' WHERE wa_id = '77010000007'`);
  const late = await app.inject({ method: "POST", url: "/api/contacts/77010000007/send", headers: h, payload: { text: "Ещё" } });
  assert.equal(late.statusCode, 400);
  assert.match(late.json().error, /24 час/);
});

test("monthly budget cap stops AI calls", async () => {
  await updateSettings({ monthly_budget_usd: 1 });
  await getDb().query(`INSERT INTO usage (kind, model, cost_usd) VALUES ('chat', 'claude-opus-5-5', 1.5)`);
  await postWebhook(inbound("77010000008", "Привет"));
  await drain();
  assert.equal(claudeCalls.length, 0);
  const [c] = await getDb().query(`SELECT needs_attention, attention_reason FROM contacts WHERE wa_id = '77010000008'`);
  assert.equal(c.needs_attention, true);
  assert.match(c.attention_reason, /лимит/);
});

test("opt-out word disables AI for the contact", async () => {
  await postWebhook(inbound("77010000009", "СТОП"));
  await drain();
  assert.equal(claudeCalls.length, 0);
  assert.match(sent[0].text.body, /отключены/);
  const [c] = await getDb().query(`SELECT ai_enabled, opted_out FROM contacts WHERE wa_id = '77010000009'`);
  assert.equal(c.ai_enabled, false);
  assert.equal(c.opted_out, true);
});

test("loop guard caps AI replies per hour", async () => {
  await updateSettings({ max_ai_replies_per_hour: 2 });
  for (let i = 0; i < 4; i++) {
    await postWebhook(inbound("77010000010", "msg " + i));
    await drain();
  }
  assert.equal(sent.length, 2);
  const [c] = await getDb().query(`SELECT needs_attention FROM contacts WHERE wa_id = '77010000010'`);
  assert.equal(c.needs_attention, true);
});

test("send failure is recorded and flagged", async () => {
  failSends = true;
  await postWebhook(inbound("77010000011", "Привет"));
  await drain();
  const [m] = await getDb().query(`SELECT status, error FROM messages WHERE wa_id = '77010000011' AND direction='out'`);
  assert.equal(m.status, "failed");
  assert.match(m.error, /Recipient not allowed/);
});

test("panel auth: login required, wrong password rejected, settings round-trip", async () => {
  assert.equal((await app.inject({ url: "/api/overview" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/login", payload: { password: "nope" } })).statusCode, 401);
  const h = await login();
  const ov = await app.inject({ url: "/api/overview", headers: h });
  assert.equal(ov.statusCode, 200);
  const put = await app.inject({ method: "PUT", url: "/api/settings", headers: h, payload: { instructions: "Новые инструкции", model: "claude-sonnet-5-5" } });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().settings.model, "claude-sonnet-5-5");
  const bad = await app.inject({ method: "PUT", url: "/api/settings", headers: h, payload: { model: "gpt-4" } });
  assert.equal(bad.statusCode, 400);
  for (const url of ["/api/stats", "/api/costs", "/api/knowledge", "/api/contacts?filter=active", "/api/whatsapp/status"]) {
    const r = await app.inject({ url, headers: h });
    assert.equal(r.statusCode, 200, url);
  }
  const ws = await app.inject({ url: "/api/whatsapp/status", headers: h });
  assert.equal(ws.json().phone.verified_name, "Test");
  assert.equal(ws.json().subscribed, true);
  const t = await app.inject({ method: "POST", url: "/api/ai/test", headers: h, payload: { messages: [{ from: "client", text: "Сәлем" }] } });
  assert.equal(t.statusCode, 200);
  assert.ok(t.json().reply);
  assert.equal(sent.length, 0, "AI test sends nothing to WhatsApp");
  const tm = await app.inject({ method: "POST", url: "/api/whatsapp/test-message", headers: h, payload: { to: "77010000099" } });
  assert.equal(tm.statusCode, 400, "test message needs explicit confirmation");
});

test("panel is served with security headers", async () => {
  const r = await app.inject({ url: "/" });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /AI-помощник WhatsApp/);
  assert.match(String(r.headers["content-security-policy"]), /default-src 'self'/);
  assert.equal(r.headers["x-frame-options"], "DENY");
});

test("crash recovery: unfinished messages are answered after restart, stale ones skipped", async () => {
  const d = getDb();
  await d.query(`INSERT INTO contacts (wa_id, name, last_inbound_at) VALUES ('77010000012', 'R', now())`);
  await d.query(`INSERT INTO messages (wa_message_id, wa_id, direction, sender, text, status) VALUES ('wamid.R1', '77010000012', 'in', 'contact', 'Ау', 'processing')`);
  await d.query(`INSERT INTO contacts (wa_id, name) VALUES ('77010000013', 'Old')`);
  await d.query(`INSERT INTO messages (wa_message_id, wa_id, direction, sender, text, status, created_at) VALUES ('wamid.R2', '77010000013', 'in', 'contact', 'Старое', 'pending', now() - interval '2 days')`);
  const n = await recover();
  assert.equal(n, 1);
  await new Promise((r) => setTimeout(r, 1200));
  await drain();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "77010000012");
  const [old] = await d.query(`SELECT status FROM messages WHERE wa_message_id = 'wamid.R2'`);
  assert.equal(old.status, "skipped");
});
