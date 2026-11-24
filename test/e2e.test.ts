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
const uploads: string[] = [];
let outCounter = 0;
const createdTemplates: any[] = [];
const TEMPLATES = [
  { name: "aksiya", language: "kk", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Сәлем, {{1}}! Жеңілдік бар." }] },
  { name: "news_plain", language: "ru", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Новинки уже в продаже" }] },
  { name: "draft", language: "ru", status: "PENDING", category: "UTILITY", components: [{ type: "BODY", text: "x" }] },
];
let failSends = false;
let authFail = false;
const ownSent: any[] = [];
const unexpectedGraph: string[] = [];
const graph = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    const u = new URL(req.url ?? "/", "http://x");
    // ---- Embedded Signup endpoints ----
    if (u.pathname.endsWith("/oauth/access_token")) {
      if (u.searchParams.get("code") !== "GOODCODE1234" || u.searchParams.get("client_secret") !== "APPSECRET") {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: "Invalid verification code format." } }));
      }
      return res.end(JSON.stringify({ access_token: "EAABUSINESSTOKEN000000000000", token_type: "bearer" }));
    }
    if (u.pathname.endsWith("/debug_token")) {
      assert.equal(req.headers.authorization, "Bearer 1176|APPSECRET");
      return res.end(JSON.stringify({ data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["OWNWABA"] }] } }));
    }
    if (req.headers.authorization === "Bearer EAABUSINESSTOKEN000000000000") {
      if (u.pathname.endsWith("/OWNWABA/phone_numbers"))
        return res.end(JSON.stringify({ data: [{ id: "OWNPN", display_phone_number: "+7 707 959 56 80", verified_name: "Жан мен Тән" }] }));
      if (u.pathname.endsWith("/OWNWABA/subscribed_apps"))
        return res.end(req.method === "POST" ? '{"success":true}' : JSON.stringify({ data: [{ whatsapp_business_api_data: { id: "1176" } }] }));
      if (req.method === "POST" && u.pathname.endsWith("/OWNPN/messages")) {
        const ob = JSON.parse(body);
        if (ob.status === "read") return res.end('{"success":true}');
        ownSent.push(ob);
        return res.end(JSON.stringify({ messages: [{ id: "wamid.OWN" + ownSent.length }] }));
      }
      if (u.pathname.endsWith("/OWNPN")) return res.end(JSON.stringify({ display_phone_number: "+7 707 959 56 80", verified_name: "Жан мен Тән" }));
    }
    if (req.headers.authorization !== "Bearer EAATESTFAKE00000000000000000") {
      unexpectedGraph.push(`${req.method} ${u.pathname} (${String(req.headers.authorization).slice(0, 20)})`);
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: "unexpected token in test", code: 190 } }));
    }
    if (req.method === "POST" && req.url?.endsWith("/PN1/media")) {
      assert.match(String(req.headers["content-type"]), /multipart\/form-data/);
      uploads.push(body.length > 0 ? "ok" : "empty");
      return res.end(JSON.stringify({ id: "MEDIA" + uploads.length }));
    }
    if (req.method === "POST" && req.url?.endsWith("/PN1/messages")) {
      const b = JSON.parse(body);
      if (b.status === "read") return res.end('{"success":true}');
      if (b.to === "77070000001") {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: "(#131030) Recipient phone number not in allowed list", code: 131030 } }));
      }
      if (authFail) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 } }));
      }
      if (failSends) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: "Recipient not allowed", code: 131030 } }));
      }
      sent.push(b);
      return res.end(JSON.stringify({ messages: [{ id: "wamid.OUT" + (++outCounter) }] }));
    }
    if (req.method === "GET" && req.url?.includes("/PN1?")) {
      return res.end(JSON.stringify({ display_phone_number: "+1 555 0100", verified_name: "Test", quality_rating: "GREEN" }));
    }
    if (req.method === "GET" && req.url?.includes("/WABA1/message_templates")) return res.end(JSON.stringify({ data: TEMPLATES }));
    if (req.method === "POST" && req.url?.includes("/WABA1/message_templates")) {
      createdTemplates.push(JSON.parse(body));
      return res.end(JSON.stringify({ id: "TPL1", status: "PENDING" }));
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
    waToken: "EAATESTFAKE00000000000000000",
    waPhoneNumberId: "PN1",
    waBusinessAccountId: "WABA1",
    waAppSecret: "APPSECRET",
    waVerifyToken: "VERIFY",
    anthropicApiKey: "test",
    adminPassword: "pass123",
    sessionSecret: "s".repeat(32),
    debounceMs: 30,
    humanDelayScale: 0,
    ntfyTopic: "",
    metaAppId: "1176",
    esConfigId: "CFG1",
  });
  await initDb(process.env.TEST_DATABASE_URL ? { url: process.env.TEST_DATABASE_URL } : { dir: "memory" });
  startProcessor();
  (await import("../src/signup.js")).rememberEnvCredentials();
  app = await buildServer();
});

after(async () => {
  await app.close();
  await getDb().close();
  graph.close();
});

beforeEach(async () => {
  sent.length = 0;
  uploads.length = 0;
  claudeCalls.length = 0;
  failSends = false;
  nextReply = { reply: "Здравствуйте! Стрижка стоит 5000 ₸.", handoff: false, handoff_reason: "" };
  const d = getDb();
  await d.exec(`DELETE FROM messages; DELETE FROM contacts; DELETE FROM usage; DELETE FROM events; DELETE FROM settings; DELETE FROM knowledge; DELETE FROM orders; DELETE FROM catalog; DELETE FROM media; DELETE FROM broadcasts;`);
  clearSettingsCache();
  await updateSettings({ ai_enabled: true, human_style: false });
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

test("handoff with 'pause after handoff' on: owner notified, contact flagged and AI paused", async () => {
  await updateSettings({ pause_after_handoff: true });
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

test("privacy page is always served whole (Meta crawler sends Range requests)", async () => {
  for (const url of ["/privacy.html", "/privacy"]) {
    const r = await app.inject({ url, headers: { range: "bytes=0-100", "accept-encoding": "gzip, br" } });
    assert.equal(r.statusCode, 200, url);
    assert.match(String(r.headers["content-type"]), /text\/html/);
    assert.match(String(r.headers["cache-control"]), /no-transform/);
    assert.equal(r.headers["content-encoding"], undefined);
    assert.match(r.body, /Privacy Policy/);
  }
  const js = await app.inject({ url: "/app.js", headers: { range: "bytes=0-10" } });
  assert.equal(js.statusCode, 200);
});

test("webhook stats count accepted and rejected deliveries", async () => {
  const { webhookStats } = await import("../src/server.js");
  const before = { ok: webhookStats.okCount, bad: webhookStats.badSignatureCount };
  await postWebhook(inbound("77010000014", "hi"));
  await app.inject({ method: "POST", url: "/webhook", payload: JSON.stringify(inbound("77010000014", "x")), headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + "1".repeat(64) } });
  await drain();
  assert.equal(webhookStats.okCount, before.ok + 1);
  assert.equal(webhookStats.badSignatureCount, before.bad + 1);
  const h = await login();
  const st = (await app.inject({ url: "/api/whatsapp/status", headers: h })).json();
  assert.equal(st.webhook.badSignatureCount, webhookStats.badSignatureCount);
});

test("Kazakhstan test-number quirk: retries with the allow-list spelling (7 8707…)", async () => {
  await postWebhook(inbound("77070000001", "Сәлем"));
  await drain();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "787070000001");
  const [m] = await getDb().query(`SELECT status FROM messages WHERE wa_id = '77070000001' AND direction = 'out'`);
  assert.equal(m.status, "sent");
});

// 1x1 PNG
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("media library: AI sends a photo from the library, upload is reused", async () => {
  const h = await login();
  const up = await app.inject({ method: "POST", url: "/api/media", headers: h, payload: { title: "Прайс", description: "когда спрашивают цены", filename: "price.png", mime: "image/png", data: PNG_B64 } });
  assert.equal(up.statusCode, 200, up.body);
  const id = up.json().id;
  const list = await app.inject({ url: "/api/media", headers: h });
  assert.equal(list.json().items.length, 1);
  assert.equal(list.json().items[0].kind, "image");
  const file = await app.inject({ url: `/api/media/${id}/file`, headers: h });
  assert.equal(file.statusCode, 200);
  assert.equal(file.headers["content-type"], "image/png");

  nextReply = { reply: "Вот наш прайс 👇", handoff: false, handoff_reason: "", send_media: [id, 9999] };
  await postWebhook(inbound("77010000020", "Бағасы қанша?"));
  await drain();
  assert.match(claudeCalls[0].system[0].text, /ID \d+: фото «Прайс» — когда спрашивают цены/);
  assert.deepEqual(claudeCalls[0].output_config.format.schema.required.includes("send_media"), true);
  assert.equal(sent.length, 2, "text + one image (unknown id 9999 ignored)");
  assert.equal(sent[1].type, "image");
  assert.equal(sent[1].image.id, "MEDIA1");
  assert.equal(uploads.length, 1);

  await postWebhook(inbound("77010000020", "Тағы жіберіңізші"));
  await drain();
  assert.equal(uploads.length, 1, "cached WhatsApp media id reused");
  const rows = await getDb().query(`SELECT sender, type, text FROM messages WHERE wa_id = '77010000020' AND type = 'image'`);
  assert.equal(rows[0].text, "📷 Прайс");
});

test("owner sends a photo from the panel and from the library; bad files rejected", async () => {
  await updateSettings({ ai_enabled: false });
  await postWebhook(inbound("77010000021", "Фото жіберіңіз"));
  await drain();
  const h = await login();
  const one = await app.inject({ method: "POST", url: "/api/contacts/77010000021/send-file", headers: h, payload: { mime: "image/png", filename: "a.png", data: PNG_B64, caption: "Міне" } });
  assert.equal(one.statusCode, 200, one.body);
  assert.equal(sent.at(-1).type, "image");
  assert.equal(sent.at(-1).image.caption, "Міне");

  const heic = await app.inject({ method: "POST", url: "/api/media", headers: h, payload: { title: "x", mime: "image/heic", data: PNG_B64 } });
  assert.equal(heic.statusCode, 400);
  const big = Buffer.alloc(17 * 1024 * 1024, 1).toString("base64");
  const vid = await app.inject({ method: "POST", url: "/api/media", headers: h, payload: { title: "v", mime: "video/mp4", data: big } });
  assert.equal(vid.statusCode, 400);
  assert.ok(vid.json().error);

  // iPhone-style .mov is converted to MP4 and sent as a real video (raw binary upload).
  const fs = await import("node:fs");
  const mov = fs.readFileSync(new URL("./fixtures/mpeg4.mov", import.meta.url));
  const up = await app.inject({
    method: "POST",
    url: "/api/media/raw?title=" + encodeURIComponent("Видео зала") + "&filename=zal.mov&mime=video/quicktime",
    headers: { ...h, "content-type": "application/octet-stream" },
    payload: mov,
  });
  assert.equal(up.statusCode, 200, up.body);
  assert.equal(up.json().kind, "video");
  assert.equal(up.json().mime, "video/mp4");
  assert.equal(up.json().filename, "zal.mp4");
  const lib = await app.inject({ method: "POST", url: "/api/contacts/77010000021/send-file", headers: h, payload: { library_id: up.json().id } });
  assert.equal(lib.statusCode, 200, lib.body);
  assert.equal(sent.at(-1).type, "video");
  const h264 = fs.readFileSync(new URL("./fixtures/h264.mov", import.meta.url));
  const one2 = await app.inject({
    method: "POST",
    url: "/api/contacts/77010000021/send-file-raw?filename=IMG_0001.MOV&mime=video/quicktime&caption=" + encodeURIComponent("Зал"),
    headers: { ...h, "content-type": "application/octet-stream" },
    payload: h264,
  });
  assert.equal(one2.statusCode, 200, one2.body);
  assert.equal(sent.at(-1).type, "video");
  assert.equal(sent.at(-1).video.caption, "Зал");
  const broken = await app.inject({
    method: "POST",
    url: "/api/media/raw?title=x&filename=x.mov&mime=video/quicktime",
    headers: { ...h, "content-type": "application/octet-stream" },
    payload: Buffer.from("not a video"),
  });
  assert.equal(broken.statusCode, 400);
  const [c] = await getDb().query(`SELECT paused_until FROM contacts WHERE wa_id = '77010000021'`);
  assert.ok(new Date(c.paused_until) > new Date(), "owner takeover pauses AI");
});

test("media chosen by the AI is still sent when the conversation is handed to the owner", async () => {
  const h = await login();
  const up = await app.inject({ method: "POST", url: "/api/media", headers: h, payload: { title: "Видео", description: "как работает", filename: "v.png", mime: "image/png", data: PNG_B64 } });
  const id = up.json().id;
  nextReply = { reply: "Мына видеодан көріңіз 👇 Толығырақ Ернұр жазады.", handoff: true, handoff_reason: "детали товара", send_media: [id] };
  await postWebhook(inbound("77010000022", "Не сатасыңдар?"));
  await drain();
  assert.equal(sent.length, 2, "text + media");
  assert.equal(sent[1].type, "image");
  const [c] = await getDb().query(`SELECT needs_attention FROM contacts WHERE wa_id = '77010000022'`);
  assert.equal(c.needs_attention, true);
  assert.match(claudeCalls[0].system[0].text, /ОБЯЗАН указать его ID в send_media/);
});

test("panel files are served with no-cache so phones pick up new versions", async () => {
  for (const url of ["/", "/app.js", "/style.css"]) {
    const r = await app.inject({ url });
    assert.equal(r.statusCode, 200, url);
    assert.equal(r.headers["cache-control"], "no-cache", url);
  }
});


test("follow-up: one reminder when the client goes quiet, reset by a new message", async () => {
  const { runFollowups } = await import("../src/campaigns.js");
  await updateSettings({ followup_enabled: true, followup_hours: 0.5 });
  await postWebhook(inbound("77010000030", "Ойланайын"));
  await drain();
  assert.equal(sent.length, 1);
  assert.equal(await runFollowups(), 0, "too early");
  await getDb().query(`UPDATE messages SET created_at = now() - interval '1 hour' WHERE wa_id = '77010000030' AND sender = 'ai'`);
  nextReply = { reply: "Сұрақтарыңыз қалды ма? Көмектесейін бе?", handoff: false, handoff_reason: "", send_media: [] };
  assert.equal(await runFollowups(), 1);
  assert.equal(sent.at(-1).text.body, "Сұрақтарыңыз қалды ма? Көмектесейін бе?");
  const lastCall = claudeCalls.at(-1);
  const lastBlocks = lastCall.messages.at(-1).content.map((b: any) => b.text).join(" ");
  assert.match(lastBlocks, /не отвечает/);
  await getDb().query(`UPDATE messages SET created_at = now() - interval '2 hour' WHERE wa_id = '77010000030' AND sender = 'ai'`);
  assert.equal(await runFollowups(), 0, "only once per client message");

  // paused contacts never get reminders
  await getDb().query(`UPDATE contacts SET followup_count = 0, paused_until = now() + interval '1 hour' WHERE wa_id = '77010000030'`);
  assert.equal(await runFollowups(), 0);
  await updateSettings({ followup_enabled: false });
});

test("follow-up is skipped when the AI decides it is not appropriate", async () => {
  const { runFollowups } = await import("../src/campaigns.js");
  await updateSettings({ followup_enabled: true, followup_hours: 0.5 });
  await postWebhook(inbound("77010000031", "Рахмет, сау болыңыз"));
  await drain();
  await getDb().query(`UPDATE messages SET created_at = now() - interval '1 hour' WHERE wa_id = '77010000031' AND sender = 'ai'`);
  const before = sent.length;
  nextReply = { reply: "", handoff: false, handoff_reason: "", send_media: [] };
  assert.equal(await runFollowups(), 0);
  assert.equal(sent.length, before);
  await updateSettings({ followup_enabled: false });
});

test("broadcast: approved template with the client's name, opted-out skipped, schedule and cancel", async () => {
  const { runBroadcasts } = await import("../src/campaigns.js");
  await updateSettings({ ai_enabled: false });
  await postWebhook(inbound("77010000040", "Сәлем"));
  await postWebhook(inbound("77010000041", "Привет"));
  await postWebhook(inbound("77010000042", "стоп"));
  await drain();
  const h = await login();
  const tpl = await app.inject({ url: "/api/templates", headers: h });
  assert.equal(tpl.json().items.find((t: any) => t.name === "aksiya").params, 1);

  const pv = await app.inject({ method: "POST", url: "/api/broadcasts/preview", headers: h, payload: { audience_days: 30 } });
  assert.equal(pv.json().count, 2, "opted-out client excluded");

  const noConfirm = await app.inject({ method: "POST", url: "/api/broadcasts", headers: h, payload: { template_name: "aksiya", language: "kk", audience_days: 30 } });
  assert.equal(noConfirm.statusCode, 400);
  const pending = await app.inject({ method: "POST", url: "/api/broadcasts", headers: h, payload: { template_name: "draft", language: "ru", audience_days: 30, confirm: true } });
  assert.equal(pending.statusCode, 400, "not approved");

  sent.length = 0;
  const go = await app.inject({ method: "POST", url: "/api/broadcasts", headers: h, payload: { template_name: "aksiya", language: "kk", audience_days: 30, confirm: true } });
  assert.equal(go.statusCode, 200, go.body);
  for (let i = 0; i < 100; i++) {
    await runBroadcasts();
    const [b] = await getDb().query(`SELECT status FROM broadcasts WHERE id = $1`, [go.json().id]);
    if (b.status === "done") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const tplSends = sent.filter((m) => m.type === "template");
  assert.equal(tplSends.length, 2);
  assert.equal(tplSends[0].template.name, "aksiya");
  assert.match(tplSends[0].template.components[0].parameters[0].text, /Клиент 7701000004[01]/);
  const list = (await app.inject({ url: "/api/broadcasts", headers: h })).json().items;
  assert.equal(list[0].status, "done");
  assert.equal(list[0].sent, 2);
  const hist = await getDb().query(`SELECT text FROM messages WHERE wa_id = '77010000040' AND type = 'template'`);
  assert.match(hist[0].text, /^📢 Сәлем, Клиент 77010000040! Жеңілдік бар\.$/);

  // scheduled in the future: nothing sent until due; can be cancelled
  sent.length = 0;
  const later = new Date(Date.now() + 3600_000).toISOString();
  const sch = await app.inject({ method: "POST", url: "/api/broadcasts", headers: h, payload: { template_name: "news_plain", language: "ru", audience_days: 0, scheduled_at: later, confirm: true } });
  assert.equal(sch.statusCode, 200, sch.body);
  await runBroadcasts();
  assert.equal(sent.length, 0);
  const cancel = await app.inject({ method: "POST", url: `/api/broadcasts/${sch.json().id}/cancel`, headers: h });
  assert.equal(cancel.statusCode, 200);
  await getDb().query(`UPDATE broadcasts SET scheduled_at = now() - interval '1 minute' WHERE id = $1`, [sch.json().id]);
  await runBroadcasts();
  assert.equal(sent.length, 0, "cancelled broadcast never sends");
});

test("templates can be created from the panel; invalid names rejected", async () => {
  const h = await login();
  const bad = await app.inject({ method: "POST", url: "/api/templates", headers: h, payload: { name: "Акция!", category: "MARKETING", language: "kk", body: "x" } });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: "POST", url: "/api/templates", headers: h, payload: { name: "aksiya_dec", category: "MARKETING", language: "kk", body: "Сәлем, {{1}}! Желтоқсан жеңілдігі." } });
  assert.equal(ok.statusCode, 200, ok.body);
  const created = createdTemplates.at(-1);
  assert.equal(created.name, "aksiya_dec");
  assert.deepEqual(created.components[0].example.body_text, [["Айгерим"]]);
});

test("persistent reminders per client: repeat until reply, last one before the 24h window closes, never after", async () => {
  const { runFollowups } = await import("../src/campaigns.js");
  await updateSettings({ followup_enabled: false, followup_hours: 2, followup_max: 3 });
  await postWebhook(inbound("77010000050", "Ойланып көрейін"));
  await drain();
  const h = await login();
  const r = await app.inject({ method: "PATCH", url: "/api/contacts/77010000050", headers: h, payload: { followup_mode: "persistent" } });
  assert.equal(r.statusCode, 200);
  const age = (sql: string) => getDb().query(sql);
  const aiAgo = (hrs: number) => age(`UPDATE messages SET created_at = now() - interval '${hrs} hours' WHERE wa_id = '77010000050' AND sender = 'ai'`);
  const clientAgo = (hrs: number) => age(`UPDATE contacts SET last_inbound_at = now() - interval '${hrs} hours' WHERE wa_id = '77010000050'`);

  nextReply = { reply: "Еске салайын 🙂", handoff: false, handoff_reason: "", send_media: [] };
  await aiAgo(3); await clientAgo(3);
  assert.equal(await runFollowups(), 1, "reminder #1 (global switch off, but client is persistent)");
  assert.equal(await runFollowups(), 0, "not again right away");
  await aiAgo(3); await clientAgo(6);
  assert.equal(await runFollowups(), 1, "reminder #2");
  // near the end of the window: the final reminder goes out even before the interval passes
  await aiAgo(1.5); await clientAgo(21.5);
  assert.equal(await runFollowups(), 1, "final reminder #3 before the window closes");
  const lastPrompt = claudeCalls.at(-1).messages.at(-1).content.map((b: any) => b.text).join(" ");
  assert.match(lastPrompt, /последнее напоминание/);
  await aiAgo(3); await clientAgo(21.8);
  assert.equal(await runFollowups(), 0, "max reached");

  // client replies → counter resets; after 23h nothing is sent (paid zone)
  await postWebhook(inbound("77010000050", "Иә, жазыламын"));
  await drain();
  const [c] = await getDb().query(`SELECT followup_count FROM contacts WHERE wa_id = '77010000050'`);
  assert.equal(c.followup_count, 0);
  await aiAgo(5); await clientAgo(23.5);
  assert.equal(await runFollowups(), 0, "never outside the free window");

  // 'off' blocks reminders even when the global switch is on
  await updateSettings({ followup_enabled: true });
  await app.inject({ method: "PATCH", url: "/api/contacts/77010000050", headers: h, payload: { followup_mode: "off" } });
  await aiAgo(5); await clientAgo(5);
  assert.equal(await runFollowups(), 0);
  await updateSettings({ followup_enabled: false });
});

test("human style: no robotic self-intro rule, honest if asked, reply split into short bubbles", async () => {
  await updateSettings({ human_style: true, disclosure_enabled: false });
  nextReply = { reply: "Иә, бар 👍\n\nҚай күнге ыңғайлы?", handoff: false, handoff_reason: "", send_media: [] };
  await postWebhook(inbound("77010000060", "Ертеңге орын бар ма?"));
  await drain();
  assert.deepEqual(sent.map((m) => m.text.body), ["Иә, бар 👍", "Қай күнге ыңғайлы?"]);
  const sys = claudeCalls.at(-1).system[0].text as string;
  assert.match(sys, /КАК ЖИВОЙ МЕНЕДЖЕР/);
  assert.match(sys, /сам не заявляй, что ты бот/);
  assert.match(sys, /никогда не отрицай/);
  await updateSettings({ human_style: false });
  await postWebhook(inbound("77010000061", "Сәлем"));
  await drain();
  assert.doesNotMatch(claudeCalls.at(-1).system[0].text, /КАК ЖИВОЙ МЕНЕДЖЕР/);
});

test("sales: catalog in the prompt, product photo sent, confirmed order saved once, payment claim → check", async () => {
  const h = await login();
  await updateSettings({ payment_instructions: "Kaspi: +7 700 000 00 00 (Ернұр Т.)", delivery_info: "Барлық қалаға: 1500 ₸, 2–4 күн" });
  const photo = await app.inject({ method: "POST", url: "/api/media", headers: h, payload: { title: "Крем фото", filename: "c.png", mime: "image/png", data: PNG_B64 } });
  const photoId = photo.json().id;
  await app.inject({ method: "PUT", url: `/api/media/${photoId}`, headers: h, payload: { enabled: false } }); // only via catalog
  const c1 = await app.inject({ method: "POST", url: "/api/catalog", headers: h, payload: { name: "Крем 50 мл", category: "Күтім", price: 19500, description: "Ылғалдандырады", media_id: photoId } });
  assert.equal(c1.statusCode, 200, c1.body);
  await app.inject({ method: "POST", url: "/api/catalog", headers: h, payload: { kind: "service", name: "Массаж", price: 8000, price_note: "60 мин", in_stock: false } });

  nextReply = { reply: "Бізде Крем 50 мл бар — 19 500 ₸ 👇", handoff: false, handoff_reason: "", send_media: [photoId],
    order: { confirmed: false, items: "", total: 0, customer_name: "", city: "", address: "", delivery: "", comment: "" }, payment_claimed: false };
  await postWebhook(inbound("77010000070", "Бет кремі бар ма?"));
  await drain();
  const sys = claudeCalls.at(-1).system[0].text as string;
  assert.match(sys, /КАТАЛОГ/);
  assert.match(sys, /Крем 50 мл \(Күтім\) — 19\s?500 ₸ — фото: ID \d+/);
  assert.match(sys, /Массаж — 60 мин 8\s?000 ₸ — НЕТ В НАЛИЧИИ/);
  assert.match(sys, /ОПЛАТА\nKaspi: \+7 700/);
  assert.match(sys, /ПРОДАЖИ/);
  assert.equal(sent.at(-1).type, "image", "catalog photo sent even though hidden in the library");
  assert.equal((await getDb().query(`SELECT * FROM orders`)).length, 0, "no order before confirmation");

  const order = { confirmed: true, items: "Крем 50 мл ×2", total: 39000, customer_name: "Айгерим", city: "Алматы", address: "Абай 10", delivery: "курьер", comment: "" };
  nextReply = { reply: "Рахмет! Тапсырыс қабылданды. Kaspi: +7 700 000 00 00", handoff: false, handoff_reason: "", send_media: [], order, payment_claimed: false };
  await postWebhook(inbound("77010000070", "Иә, растаймын"));
  await drain();
  nextReply = { ...nextReply, order: { ...order, items: "Крем 50 мл ×3", total: 58500 } };
  await postWebhook(inbound("77010000070", "Жоқ, 3 дана болсын"));
  await drain();
  const orders = await getDb().query(`SELECT * FROM orders`);
  assert.equal(orders.length, 1, "same open order updated, not duplicated");
  assert.equal(orders[0].items, "Крем 50 мл ×3");
  assert.equal(orders[0].total, 58500);
  assert.equal(orders[0].city, "Алматы");

  nextReply = { reply: "Рахмет, тексеруге жібердім 🙏", handoff: false, handoff_reason: "", send_media: [], order: { ...order, confirmed: false }, payment_claimed: true };
  await postWebhook(inbound("77010000070", "Төледім"));
  await drain();
  const [o2] = await getDb().query(`SELECT status, payment_claimed_at FROM orders`);
  assert.equal(o2.status, "payment_check");
  assert.ok(o2.payment_claimed_at);

  const list = await app.inject({ url: "/api/orders?status=open", headers: h });
  assert.equal(list.json().items.length, 1);
  assert.equal(list.json().summary.payment_check, 1);
  const id = list.json().items[0].id;
  const paid = await app.inject({ method: "PATCH", url: `/api/orders/${id}`, headers: h, payload: { status: "paid" } });
  assert.equal(paid.statusCode, 200);
  const after = (await app.inject({ url: "/api/orders?status=", headers: h })).json();
  assert.equal(after.summary.month_revenue, 58500);
  assert.equal(after.summary.open, 0);
  const bad = await app.inject({ method: "PATCH", url: `/api/orders/${id}`, headers: h, payload: { status: "stolen" } });
  assert.equal(bad.statusCode, 400);
  const ov = (await app.inject({ url: "/api/overview", headers: h })).json();
  assert.equal(ov.orders_attention, 0);
});

test("sales mode off removes sales rules; unconfirmed orders are ignored", async () => {
  await updateSettings({ sales_mode: false });
  nextReply = { reply: "Сәлем!", handoff: false, handoff_reason: "", send_media: [],
    order: { confirmed: false, items: "Крем", total: 100, customer_name: "", city: "", address: "", delivery: "", comment: "" }, payment_claimed: false };
  await postWebhook(inbound("77010000071", "Сәлем"));
  await drain();
  assert.doesNotMatch(claudeCalls.at(-1).system[0].text, /ПРОДАЖИ \(ты ещё и продавец\)/);
  assert.equal((await getDb().query(`SELECT * FROM orders`)).length, 0);
  await updateSettings({ sales_mode: true });
});

test("default: after a handoff the AI keeps talking (one push per issue) until the owner writes", async () => {
  const { DEFAULT_SETTINGS } = await import("../src/settings.js");
  assert.equal(DEFAULT_SETTINGS.pause_after_handoff, false);
  nextReply = { reply: "Нені ойландырып тұр — бағасы ма, сапасы ма?", handoff: true, handoff_reason: "Клиент сомневается", send_media: [] };
  await postWebhook(inbound("77010000080", "Алмайтын сияқтымын"));
  await drain();
  nextReply = { reply: "Сапасы бойынша: сертификат бар, кепілдік 1 жыл.", handoff: false, handoff_reason: "", send_media: [] };
  await postWebhook(inbound("77010000080", "Сапасы"));
  await drain();
  assert.equal(sent.length, 2, "AI answered the client after the handoff");
  assert.match(sent[1].text.body, /кепілдік/);
  const [c] = await getDb().query(`SELECT needs_attention, paused_until FROM contacts WHERE wa_id = '77010000080'`);
  assert.equal(c.needs_attention, true, "still flagged for the owner");
  assert.equal(c.paused_until, null);
  // owner writes → AI stops
  const h = await login();
  await app.inject({ method: "POST", url: "/api/contacts/77010000080/send", headers: h, payload: { text: "Сәлем, Ернұр жазып тұр" } });
  await postWebhook(inbound("77010000080", "Жақсы"));
  await drain();
  assert.equal(claudeCalls.length, 2, "AI silent once the owner took over");
});

test("expired WhatsApp token is detected and shown in the panel, cleared when it works again", async () => {
  const h = await login();
  authFail = true;
  await postWebhook(inbound("77010000090", "Сәлем"));
  await drain();
  authFail = false;
  const ov = (await app.inject({ url: "/api/overview", headers: h })).json();
  assert.match(ov.wa_auth_error, /expired/);
  assert.ok(!String(ov.wa_auth_error).includes("EAATESTFAKE"), "token never leaks");
  await postWebhook(inbound("77010000091", "Сәлем"));
  await drain();
  const ov2 = (await app.inject({ url: "/api/overview", headers: h })).json();
  assert.equal(ov2.wa_auth_error, null);
  assert.equal(typeof ov2.hints.payment_missing, "boolean");
});

test("persistent reminders still run in a chat that is waiting for the owner", async () => {
  const { runFollowups } = await import("../src/campaigns.js");
  await updateSettings({ followup_hours: 1, followup_max: 2 });
  nextReply = { reply: "Нақтылап алайын…", handoff: true, handoff_reason: "сомневается", send_media: [] };
  await postWebhook(inbound("77010000092", "Ойланамын"));
  await drain();
  const h = await login();
  await app.inject({ method: "PATCH", url: "/api/contacts/77010000092", headers: h, payload: { followup_mode: "persistent" } });
  await getDb().query(`UPDATE messages SET created_at = now() - interval '2 hours' WHERE wa_id = '77010000092' AND sender = 'ai'`);
  nextReply = { reply: "Сұрағыңыз бойынша көмектесейін бе?", handoff: false, handoff_reason: "", send_media: [] };
  assert.equal(await runFollowups(), 1);
});


test("connect my own number (Embedded Signup): code → token → number → webhooks → AI answers from the own number", async () => {
  const h = await login();
  const st0 = (await app.inject({ url: "/api/whatsapp/status", headers: h })).json();
  assert.equal(st0.signup.ready, true);
  assert.equal(st0.signup.config_id, "CFG1");
  assert.equal(st0.connection.source, "env");

  const bad = await app.inject({ method: "POST", url: "/api/whatsapp/signup", headers: h, payload: { code: "WRONGCODE123" } });
  assert.equal(bad.statusCode, 400);
  assert.equal(config.waPhoneNumberId, "PN1", "nothing changed after a failed attempt");

  // the FINISH message may not arrive on iPhone: ids are discovered from the token
  const ok = await app.inject({ method: "POST", url: "/api/whatsapp/signup", headers: h, payload: { code: "GOODCODE1234" } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().phone, "+7 707 959 56 80");
  assert.equal(config.waPhoneNumberId, "OWNPN");
  assert.equal(config.waBusinessAccountId, "OWNWABA");
  const stored = await getDb().query(`SELECT value FROM settings WHERE key = '_wa_connection'`);
  assert.ok(!JSON.stringify(stored).includes("EAABUSINESSTOKEN"), "token stored encrypted");

  // incoming message for the own number is answered from the own number
  const msg = inbound("77010000099", "Сәлем");
  msg.entry[0].changes[0].value.metadata.phone_number_id = "OWNPN";
  await postWebhook(msg);
  await drain();
  assert.equal(ownSent.length, 1);
  // test-number events are now ignored
  await postWebhook(inbound("77010000098", "тест нөмірі"));
  await drain();
  assert.equal((await getDb().query(`SELECT * FROM contacts WHERE wa_id = '77010000098'`)).length, 0);

  // survives a restart
  const { loadConnection } = await import("../src/signup.js");
  Object.assign(config, { waPhoneNumberId: "PN1", waToken: "EAATESTFAKE00000000000000000", waBusinessAccountId: "WABA1" });
  await loadConnection();
  assert.equal(config.waPhoneNumberId, "OWNPN");

  const st1 = (await app.inject({ url: "/api/whatsapp/status", headers: h })).json();
  assert.equal(st1.connection.source, "own");
  assert.equal(st1.connection.phone, "+7 707 959 56 80");

  // switch back to the test number
  const off = await app.inject({ method: "POST", url: "/api/whatsapp/disconnect-own", headers: h });
  assert.equal(off.statusCode, 200);
  assert.equal(config.waPhoneNumberId, "PN1");
  assert.equal(config.waToken, "EAATESTFAKE00000000000000000");
});

test("panel CSP allows the Meta signup popup and nothing else external", async () => {
  const r = await app.inject({ url: "/" });
  const csp = String(r.headers["content-security-policy"]);
  assert.match(csp, /script-src 'self' https:\/\/connect\.facebook\.net;/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test("no Graph calls were made with an unexpected token", () => {
  assert.deepEqual(unexpectedGraph, []);
});
