import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { config, integrationStatus } from "./config.js";
import { getDb } from "./db.js";
import { COOKIE, SESSION_MAX_AGE, checkPassword, issueToken, loginBlocked, loginFailed, loginOk, verifyToken } from "./auth.js";
import { getSettings, updateSettings, SettingsSchema, MODELS } from "./settings.js";
import * as wa from "./whatsapp.js";
import { handleEvents, ownerSend, ownerSendFile, schedule } from "./processor.js";
import { addMedia, getMediaFile, listMedia, MediaError, MAX_RAW_UPLOAD } from "./media.js";
import { aiSalesContext, ORDER_STATUSES } from "./sales.js";
import { audience, BroadcastError, cancelBroadcast, createBroadcast, runBroadcasts } from "./campaigns.js";
import { generateReply, AiError } from "./ai.js";
import { costUsd } from "./pricing.js";
import { getContact, getKnowledge, monthSpendUsd, recordUsage, updateContact } from "./store.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

/** What happened to the most recent webhook calls — shown in the panel for troubleshooting. */
const startedAt = new Date().toISOString();
export const webhookStats = {
  okCount: 0,
  lastOkAt: null as string | null,
  badSignatureCount: 0,
  lastBadSignatureAt: null as string | null,
  notConfiguredCount: 0,
  lastEvents: 0,
};

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.nodeEnv === "test" ? "silent" : "info", redact: ["req.headers.cookie", "req.headers.authorization"] },
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  // Keep the exact raw body: required for webhook signature verification.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch {
      const err: any = new Error("Invalid JSON");
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // Raw file uploads from the panel (videos can be large; no base64 overhead).
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  await app.register(cookie);

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (config.nodeEnv === "production") reply.header("Strict-Transport-Security", "max-age=31536000");
    if (!req.url.startsWith("/webhook")) {
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    }
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    return payload;
  });

  // ---------------- Health ----------------
  app.get("/health", async () => {
    await getDb().query("SELECT 1");
    return { ok: true, time: new Date().toISOString() };
  });

  // ---------------- WhatsApp webhook ----------------
  app.get("/webhook", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q["hub.mode"] === "subscribe" && config.waVerifyToken && q["hub.verify_token"] === config.waVerifyToken) {
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    }
    return reply.code(403).send("Forbidden");
  });

  app.post("/webhook", async (req, reply) => {
    if (!config.waAppSecret) {
      req.log.error("META_APP_SECRET is not set — refusing unsigned webhook");
      webhookStats.notConfiguredCount++;
      return reply.code(503).send({ error: "not configured" });
    }
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!req.rawBody || !wa.verifySignature(req.rawBody, sig, config.waAppSecret)) {
      req.log.warn("Webhook signature mismatch — check META_APP_SECRET");
      webhookStats.badSignatureCount++;
      webhookStats.lastBadSignatureAt = new Date().toISOString();
      return reply.code(401).send({ error: "bad signature" });
    }
    const events = wa.parseWebhook(req.body, config.waPhoneNumberId);
    webhookStats.okCount++;
    webhookStats.lastOkAt = new Date().toISOString();
    webhookStats.lastEvents = events.length;
    req.log.info({ events: events.length }, "webhook accepted");
    await handleEvents(events); // fast DB inserts only; AI work runs in the background
    return reply.code(200).send({ ok: true });
  });

  // ---------------- Auth ----------------
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!verifyToken(req.cookies[COOKIE])) return reply.code(401).send({ error: "Нужно войти" });
    // CSRF protection for state-changing calls: SameSite=Strict cookie + custom header.
    if (req.method !== "GET" && req.headers["x-requested-with"] !== "panel") {
      return reply.code(403).send({ error: "Bad request origin" });
    }
  };

  app.post("/api/login", async (req, reply) => {
    const ip = req.ip;
    if (loginBlocked(ip)) return reply.code(429).send({ error: "Слишком много попыток. Подождите 15 минут." });
    const pw = String((req.body as any)?.password ?? "");
    if (!checkPassword(pw)) {
      loginFailed(ip);
      return reply.code(401).send({ error: "Неверный пароль" });
    }
    loginOk(ip);
    reply.setCookie(COOKIE, issueToken(), {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: config.nodeEnv === "production",
      maxAge: SESSION_MAX_AGE,
    });
    return { ok: true };
  });

  app.post("/api/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.register(async (api) => {
    api.addHook("preHandler", requireAuth);

    api.get("/api/overview", async () => {
      const d = getDb();
      const s = await getSettings();
      const [counts] = await d.query(
        `SELECT
           (SELECT COUNT(*)::int FROM contacts) AS contacts,
           (SELECT COUNT(*)::int FROM contacts WHERE needs_attention) AS attention,
           (SELECT COUNT(*)::int FROM contacts WHERE last_inbound_at > now() - interval '24 hours') AS active,
           (SELECT COUNT(*)::int FROM messages WHERE direction='in' AND created_at > now() - interval '24 hours') AS inbound_today,
           (SELECT COUNT(*)::int FROM messages WHERE sender='ai' AND created_at > now() - interval '24 hours') AS ai_today,
           (SELECT COUNT(*)::int FROM orders WHERE status IN ('new','payment_check')) AS orders_attention`,
      );
      return {
        ai_enabled: s.ai_enabled,
        wa_auth_error: wa.waHealth.authError,
        hints: {
          payment_missing: s.sales_mode && !s.payment_instructions.trim(),
          delivery_missing: s.sales_mode && !s.delivery_info.trim(),
          push_missing: !config.ntfyTopic,
        },
        month_spend: await monthSpendUsd(),
        monthly_budget: s.monthly_budget_usd,
        integrations: integrationStatus(),
        ...counts,
      };
    });

    api.post("/api/ai-toggle", async (req) => {
      const enabled = z.object({ enabled: z.boolean() }).parse(req.body).enabled;
      await updateSettings({ ai_enabled: enabled });
      return { ai_enabled: enabled };
    });

    api.get("/api/settings", async () => ({ settings: await getSettings(), models: MODELS }));
    api.put("/api/settings", async (req, reply) => {
      const parsed = SettingsSchema.partial().strict().safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "Неверные данные: " + parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ") });
      return { settings: await updateSettings(parsed.data) };
    });

    // ----- Conversations -----
    api.get("/api/contacts", async (req) => {
      const q = req.query as { filter?: string; q?: string };
      const where: string[] = [];
      const params: unknown[] = [];
      if (q.filter === "active") where.push(`(c.last_inbound_at > now() - interval '24 hours' OR c.needs_attention)`);
      if (q.filter === "attention") where.push(`c.needs_attention`);
      if (q.q) {
        params.push(`%${q.q}%`);
        where.push(`(c.name ILIKE $${params.length} OR c.wa_id ILIKE $${params.length})`);
      }
      return getDb().query(
        `SELECT c.*, (SELECT json_build_object('text', m.text, 'sender', m.sender, 'created_at', m.created_at)
                      FROM messages m WHERE m.wa_id = c.wa_id ORDER BY m.id DESC LIMIT 1) AS last_message
         FROM contacts c ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY c.needs_attention DESC, c.last_message_at DESC NULLS LAST LIMIT 300`,
        params,
      );
    });

    api.get("/api/contacts/:waId", async (req, reply) => {
      const { waId } = req.params as { waId: string };
      const contact = await getContact(waId);
      if (!contact) return reply.code(404).send({ error: "Не найдено" });
      const messages = await getDb().query(
        `SELECT * FROM (SELECT id, direction, sender, type, text, status, error, created_at FROM messages
          WHERE wa_id = $1 ORDER BY id DESC LIMIT 300) t ORDER BY id ASC`,
        [waId],
      );
      if (contact.unread) await updateContact(waId, { unread: 0 });
      return { contact, messages };
    });

    api.patch("/api/contacts/:waId", async (req, reply) => {
      const { waId } = req.params as { waId: string };
      const body = z
        .object({
          ai_enabled: z.boolean().optional(),
          pause_hours: z.number().min(0).max(720).optional(), // 0 = resume AI now
          needs_attention: z.boolean().optional(),
          note: z.string().max(2000).optional(),
          name: z.string().max(200).optional(),
          followup_mode: z.enum(["default", "off", "once", "persistent"]).optional(),
        })
        .strict()
        .parse(req.body);
      if (!(await getContact(waId))) return reply.code(404).send({ error: "Не найдено" });
      const patch: Record<string, unknown> = {};
      if (body.ai_enabled !== undefined) {
        patch.ai_enabled = body.ai_enabled;
        if (body.ai_enabled) patch.opted_out = false;
      }
      if (body.pause_hours !== undefined) patch.paused_until = body.pause_hours > 0 ? new Date(Date.now() + body.pause_hours * 3600_000) : null;
      if (body.needs_attention !== undefined) {
        patch.needs_attention = body.needs_attention;
        if (!body.needs_attention) patch.attention_reason = null;
      }
      if (body.note !== undefined) patch.note = body.note;
      if (body.name !== undefined) patch.name = body.name;
      if (body.followup_mode !== undefined) {
        patch.followup_mode = body.followup_mode;
        patch.followup_count = 0;
      }
      await updateContact(waId, patch as any);
      return { contact: await getContact(waId) };
    });

    api.post("/api/contacts/:waId/send", async (req, reply) => {
      const { waId } = req.params as { waId: string };
      const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(req.body);
      try {
        await ownerSend(waId, text);
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });

    api.post("/api/contacts/:waId/ai-reply-now", async (req, reply) => {
      const { waId } = req.params as { waId: string };
      const n = await getDb().query(
        `UPDATE messages SET status='pending', error=NULL WHERE id = (
           SELECT id FROM messages WHERE wa_id=$1 AND direction='in' ORDER BY id DESC LIMIT 1)
         AND created_at > now() - interval '23 hours' RETURNING id`,
        [waId],
      );
      if (!n.length) return reply.code(400).send({ error: "Нет свежего сообщения клиента (окно 24 часа)" });
      await updateContact(waId, { paused_until: null, needs_attention: false, attention_reason: null });
      schedule(waId, 100);
      return { ok: true };
    });

    api.delete("/api/contacts/:waId", async (req) => {
      const { waId } = req.params as { waId: string };
      await getDb().query(`DELETE FROM contacts WHERE wa_id = $1`, [waId]);
      await getDb().query(`UPDATE usage SET wa_id = NULL WHERE wa_id = $1`, [waId]);
      await getDb().query(`DELETE FROM events WHERE wa_id = $1`, [waId]);
      return { ok: true };
    });

    // ----- Knowledge base -----
    const KbSchema = z.object({
      title: z.string().trim().min(1).max(200),
      content: z.string().min(1).max(500_000),
      enabled: z.boolean().optional(),
    });
    api.get("/api/knowledge", async () => {
      const items = await getDb().query(`SELECT id, title, content, enabled, updated_at, length(content) AS chars FROM knowledge ORDER BY id`);
      return { items };
    });
    api.post("/api/knowledge", async (req) => {
      const b = KbSchema.parse(req.body);
      const [row] = await getDb().query(
        `INSERT INTO knowledge (title, content, enabled) VALUES ($1,$2,$3) RETURNING *`,
        [b.title, b.content, b.enabled ?? true],
      );
      return row;
    });
    api.put("/api/knowledge/:id", async (req, reply) => {
      const b = KbSchema.partial().parse(req.body);
      const id = Number((req.params as any).id);
      const [row] = await getDb().query(
        `UPDATE knowledge SET title = COALESCE($2, title), content = COALESCE($3, content),
           enabled = COALESCE($4, enabled), updated_at = now() WHERE id = $1 RETURNING *`,
        [id, b.title ?? null, b.content ?? null, b.enabled ?? null],
      );
      if (!row) return reply.code(404).send({ error: "Не найдено" });
      return row;
    });
    api.delete("/api/knowledge/:id", async (req) => {
      await getDb().query(`DELETE FROM knowledge WHERE id = $1`, [Number((req.params as any).id)]);
      return { ok: true };
    });

    // ----- Media library (photos, videos, files the AI may send) -----
    const UPLOAD_LIMIT = 25 * 1024 * 1024; // base64 of a 16 MB file + JSON overhead
    const decodeFile = (b64: string) => {
      const data = Buffer.from(b64, "base64");
      if (!data.length) throw new MediaError("Пустой файл");
      return data;
    };
    api.get("/api/media", async () => {
      const items = await listMedia();
      return { items, total_bytes: items.reduce((a, i) => a + Number(i.size), 0) };
    });
    api.post("/api/media", { bodyLimit: UPLOAD_LIMIT }, async (req, reply) => {
      const b = z
        .object({
          title: z.string().trim().min(1).max(200),
          description: z.string().max(1000).default(""),
          filename: z.string().max(200).default(""),
          mime: z.string().min(3).max(100),
          data: z.string().min(1),
        })
        .parse(req.body);
      try {
        return await addMedia({ title: b.title, description: b.description, filename: b.filename, mime: b.mime, data: decodeFile(b.data) });
      } catch (e) {
        if (e instanceof MediaError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });
    // Binary upload: body = file bytes, metadata in the query string.
    const RAW_LIMIT = MAX_RAW_UPLOAD + 1024 * 1024;
    const rawMeta = (q: unknown) =>
      z
        .object({
          title: z.string().trim().max(200).default(""),
          description: z.string().max(1000).default(""),
          filename: z.string().max(200).default(""),
          mime: z.string().min(3).max(100),
          caption: z.string().max(1024).optional(),
        })
        .parse(q);
    const rawBody = (b: unknown) => {
      if (!Buffer.isBuffer(b) || !b.length) throw new MediaError("Пустой файл");
      return b;
    };
    api.post("/api/media/raw", { bodyLimit: RAW_LIMIT }, async (req, reply) => {
      try {
        const m = rawMeta(req.query);
        if (!m.title) throw new MediaError("Напишите название");
        return await addMedia({ title: m.title, description: m.description, filename: m.filename, mime: m.mime, data: rawBody(req.body) });
      } catch (e) {
        if (e instanceof MediaError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });
    api.post("/api/contacts/:waId/send-file-raw", { bodyLimit: RAW_LIMIT }, async (req, reply) => {
      const { waId } = req.params as { waId: string };
      try {
        const m = rawMeta(req.query);
        await ownerSendFile(waId, { data: rawBody(req.body), mime: m.mime, filename: m.filename, caption: m.caption });
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });
    api.put("/api/media/:id", async (req, reply) => {
      const b = z
        .object({ title: z.string().trim().min(1).max(200).optional(), description: z.string().max(1000).optional(), enabled: z.boolean().optional() })
        .strict()
        .parse(req.body);
      const [row] = await getDb().query(
        `UPDATE media SET title = COALESCE($2, title), description = COALESCE($3, description), enabled = COALESCE($4, enabled)
         WHERE id = $1 RETURNING id, title, description, kind, mime, filename, size, enabled, created_at`,
        [Number((req.params as any).id), b.title ?? null, b.description ?? null, b.enabled ?? null],
      );
      if (!row) return reply.code(404).send({ error: "Не найдено" });
      return row;
    });
    api.delete("/api/media/:id", async (req) => {
      await getDb().query(`DELETE FROM media WHERE id = $1`, [Number((req.params as any).id)]);
      return { ok: true };
    });
    api.get("/api/media/:id/file", async (req, reply) => {
      const f = await getMediaFile(Number((req.params as any).id));
      if (!f) return reply.code(404).send({ error: "Не найдено" });
      return reply
        .header("Content-Type", f.mime)
        .header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`)
        .header("Cache-Control", "private, max-age=3600")
        .send(f.data);
    });
    api.post("/api/contacts/:waId/send-file", { bodyLimit: UPLOAD_LIMIT }, async (req, reply) => {
      const { waId } = req.params as { waId: string };
      const b = z
        .object({
          library_id: z.number().int().positive().optional(),
          filename: z.string().max(200).optional(),
          mime: z.string().max(100).optional(),
          data: z.string().optional(),
          caption: z.string().max(1024).optional(),
        })
        .parse(req.body);
      try {
        await ownerSendFile(waId, {
          libraryId: b.library_id,
          data: b.data ? decodeFile(b.data) : undefined,
          mime: b.mime,
          filename: b.filename,
          caption: b.caption,
        });
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });

    // ----- Catalog (products & services) -----
    const CatalogSchema = z.object({
      kind: z.enum(["product", "service"]).default("product"),
      name: z.string().trim().min(1).max(200),
      category: z.string().trim().max(100).default(""),
      price: z.number().min(0).max(1e9).default(0),
      price_note: z.string().trim().max(50).default(""),
      description: z.string().max(3000).default(""),
      in_stock: z.boolean().default(true),
      media_id: z.number().int().positive().nullable().default(null),
    });
    api.get("/api/catalog", async () => ({
      items: await getDb().query(`SELECT * FROM catalog ORDER BY category, name, id`),
    }));
    api.post("/api/catalog", async (req) => {
      const b = CatalogSchema.parse(req.body);
      const [row] = await getDb().query(
        `INSERT INTO catalog (kind, name, category, price, price_note, description, in_stock, media_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [b.kind, b.name, b.category, b.price, b.price_note, b.description, b.in_stock, b.media_id],
      );
      return row;
    });
    api.put("/api/catalog/:id", async (req, reply) => {
      const b = CatalogSchema.partial().parse(req.body);
      const keys = Object.keys(b) as (keyof typeof b)[];
      if (!keys.length) return reply.code(400).send({ error: "Нет изменений" });
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
      const [row] = await getDb().query(`UPDATE catalog SET ${sets} WHERE id = $1 RETURNING *`, [
        Number((req.params as any).id),
        ...keys.map((k) => (b as any)[k]),
      ]);
      if (!row) return reply.code(404).send({ error: "Не найдено" });
      return row;
    });
    api.delete("/api/catalog/:id", async (req) => {
      await getDb().query(`DELETE FROM catalog WHERE id = $1`, [Number((req.params as any).id)]);
      return { ok: true };
    });

    // ----- Orders -----
    api.get("/api/orders", async (req) => {
      const q = req.query as { status?: string };
      const where = q.status === "open"
        ? `WHERE o.status IN ('new','contacted','payment_check')`
        : q.status && (ORDER_STATUSES as readonly string[]).includes(q.status) ? `WHERE o.status = $1` : "";
      const params = where.includes("$1") ? [q.status] : [];
      const items = await getDb().query(
        `SELECT o.*, c.name AS contact_name FROM orders o LEFT JOIN contacts c ON c.wa_id = o.wa_id ${where} ORDER BY o.id DESC LIMIT 300`,
        params,
      );
      const [sum] = await getDb().query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('new','contacted','payment_check'))::int AS open,
           COUNT(*) FILTER (WHERE status = 'payment_check')::int AS payment_check,
           COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS month_orders,
           COALESCE(SUM(total) FILTER (WHERE status IN ('paid','shipped','done') AND created_at >= date_trunc('month', now())), 0)::float8 AS month_revenue,
           COUNT(*) FILTER (WHERE status IN ('paid','shipped','done') AND created_at >= date_trunc('month', now()))::int AS month_paid
         FROM orders`,
      );
      return { items, summary: sum };
    });
    api.patch("/api/orders/:id", async (req, reply) => {
      const b = z
        .object({
          status: z.enum(ORDER_STATUSES).optional(),
          owner_note: z.string().max(2000).optional(),
          total: z.number().min(0).max(1e10).optional(),
        })
        .strict()
        .parse(req.body);
      const keys = Object.keys(b) as (keyof typeof b)[];
      if (!keys.length) return reply.code(400).send({ error: "Нет изменений" });
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
      const [row] = await getDb().query(`UPDATE orders SET ${sets}, updated_at = now() WHERE id = $1 RETURNING *`, [
        Number((req.params as any).id),
        ...keys.map((k) => (b as any)[k]),
      ]);
      if (!row) return reply.code(404).send({ error: "Не найдено" });
      return row;
    });

    // ----- Templates & broadcasts -----
    api.get("/api/templates", async (_req, reply) => {
      try {
        return { items: await wa.listTemplates() };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });
    api.post("/api/templates", async (req, reply) => {
      const b = z
        .object({
          name: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{1,512}$/, "Название: только латинские буквы, цифры и _"),
          category: z.enum(["MARKETING", "UTILITY"]),
          language: z.enum(["kk", "ru", "en"]),
          body: z.string().trim().min(1).max(1024),
        })
        .parse(req.body);
      try {
        return { ok: true, result: await wa.createTemplate(b) };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });
    api.post("/api/broadcasts/preview", async (req) => {
      const b = z.object({ audience_days: z.number().int().min(0).max(3650) }).parse(req.body);
      const people = await audience(b.audience_days);
      const s = await getSettings();
      return { count: people.length, est_cost_usd: people.length * s.template_price_usd, price_per_message: s.template_price_usd };
    });
    api.get("/api/broadcasts", async () => {
      const items = await getDb().query(
        `SELECT id, template_name, language, category, audience_days, scheduled_at, status, total, sent, failed, created_at, finished_at
         FROM broadcasts ORDER BY id DESC LIMIT 50`,
      );
      return { items };
    });
    api.post("/api/broadcasts", async (req, reply) => {
      const b = z
        .object({
          template_name: z.string().min(1),
          language: z.string().min(2),
          audience_days: z.number().int().min(0).max(3650),
          scheduled_at: z.string().datetime({ offset: true }).optional().nullable(),
          confirm: z.literal(true),
        })
        .parse(req.body);
      try {
        const t = (await wa.listTemplates()).find((x) => x.name === b.template_name && x.language === b.language);
        if (!t) throw new BroadcastError("Шаблон не найден");
        const when = b.scheduled_at ? new Date(b.scheduled_at) : null;
        const id = await createBroadcast({ template: t, audienceDays: b.audience_days, scheduledAt: when });
        if (!when || when.getTime() <= Date.now()) void runBroadcasts().catch(() => {});
        return { ok: true, id };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });
    api.post("/api/broadcasts/:id/cancel", async (req, reply) => {
      const ok = await cancelBroadcast(Number((req.params as any).id));
      if (!ok) return reply.code(400).send({ error: "Рассылку уже нельзя отменить" });
      return { ok: true };
    });

    // ----- Test the AI without sending anything to WhatsApp -----
    api.post("/api/ai/test", async (req, reply) => {
      const b = z
        .object({ messages: z.array(z.object({ from: z.enum(["client", "assistant"]), text: z.string().max(4000) })).min(1).max(20) })
        .parse(req.body);
      const s = await getSettings();
      if (s.monthly_budget_usd > 0 && (await monthSpendUsd()) >= s.monthly_budget_usd) {
        return reply.code(400).send({ error: "Месячный лимит расходов исчерпан" });
      }
      try {
        const kb = await getKnowledge();
        const { catalog, media } = await aiSalesContext();
        const r = await generateReply(
          s,
          kb,
          [],
          b.messages.map((m) => ({ sender: m.from === "client" ? "contact" : "ai", text: m.text })),
          [],
          media,
          { catalog },
        );
        const cost = costUsd(r.model, r.usage);
        await recordUsage({
          kind: "chat",
          model: r.model,
          wa_id: null,
          input_tokens: r.usage.input_tokens,
          output_tokens: r.usage.output_tokens,
          cache_read_tokens: r.usage.cache_read_input_tokens,
          cache_write_tokens: r.usage.cache_creation_input_tokens,
          cost_usd: cost,
        });
        const files = r.mediaIds.map((id) => media.find((m) => m.id === id)?.title ?? `#${id}`);
        return {
          reply: r.reply,
          files,
          order: r.order,
          payment_claimed: r.paymentClaimed,
          handoff: r.handoff,
          handoff_reason: r.handoffReason,
          cost_usd: cost,
          model: r.model,
        };
      } catch (e) {
        return reply.code(400).send({ error: e instanceof AiError ? e.message : (e as Error).message });
      }
    });

    // ----- Statistics & costs -----
    api.get("/api/stats", async () => {
      const d = getDb();
      const days = await d.query(
        `SELECT to_char(g.day, 'YYYY-MM-DD') AS day,
           (SELECT COUNT(*)::int FROM messages m WHERE m.direction='in' AND m.created_at >= g.day AND m.created_at < g.day + interval '1 day') AS inbound,
           (SELECT COUNT(*)::int FROM messages m WHERE m.sender='ai' AND m.created_at >= g.day AND m.created_at < g.day + interval '1 day') AS ai,
           (SELECT COUNT(*)::int FROM messages m WHERE m.sender='owner' AND m.created_at >= g.day AND m.created_at < g.day + interval '1 day') AS owner,
           (SELECT COUNT(*)::int FROM events e WHERE e.kind='handoff' AND e.created_at >= g.day AND e.created_at < g.day + interval '1 day') AS handoffs,
           (SELECT COUNT(DISTINCT m.wa_id)::int FROM messages m WHERE m.direction='in' AND m.created_at >= g.day AND m.created_at < g.day + interval '1 day') AS people
         FROM generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') AS g(day)
         ORDER BY g.day`,
      );
      const [totals] = await d.query(
        `SELECT (SELECT COUNT(*)::int FROM contacts) AS contacts,
                (SELECT COUNT(*)::int FROM messages WHERE direction='in') AS inbound,
                (SELECT COUNT(*)::int FROM messages WHERE sender='ai') AS ai,
                (SELECT COUNT(*)::int FROM messages WHERE sender='owner') AS owner,
                (SELECT COUNT(*)::int FROM events WHERE kind='handoff') AS handoffs,
                (SELECT COUNT(*)::int FROM messages WHERE direction='out' AND status='failed') AS failed`,
      );
      const events = await d.query(
        `SELECT e.kind, e.wa_id, e.detail, e.created_at, c.name FROM events e LEFT JOIN contacts c ON c.wa_id = e.wa_id
         ORDER BY e.id DESC LIMIT 30`,
      );
      return { days, totals, events };
    });

    api.get("/api/costs", async () => {
      const d = getDb();
      const s = await getSettings();
      const byDay = await d.query(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, SUM(cost_usd)::float8 AS cost, COUNT(*)::int AS calls
         FROM usage WHERE created_at >= date_trunc('month', now()) GROUP BY 1 ORDER BY 1`,
      );
      const byModel = await d.query(
        `SELECT kind, model, COUNT(*)::int AS calls, SUM(input_tokens)::int AS input_tokens, SUM(output_tokens)::int AS output_tokens,
                SUM(cache_read_tokens)::int AS cache_read_tokens, SUM(cost_usd)::float8 AS cost
         FROM usage WHERE created_at >= date_trunc('month', now()) GROUP BY kind, model ORDER BY cost DESC`,
      );
      const months = await d.query(
        `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, SUM(cost_usd)::float8 AS cost
         FROM usage GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
      );
      const spend = await monthSpendUsd();
      const [aiCount] = await d.query(
        `SELECT COUNT(*)::int AS n FROM usage WHERE kind='chat' AND created_at >= date_trunc('month', now())`,
      );
      return {
        month_spend: spend,
        monthly_budget: s.monthly_budget_usd,
        avg_per_reply: aiCount.n ? spend / aiCount.n : 0,
        byDay,
        byModel,
        months,
      };
    });

    // ----- WhatsApp connection -----
    api.get("/api/whatsapp/status", async () => {
      const base = config.publicUrl ? config.publicUrl.replace(/\/$/, "") : "";
      const out: any = {
        integrations: integrationStatus(),
        webhook_url: base ? `${base}/webhook` : "(задайте PUBLIC_URL)",
        phone_number_id: config.waPhoneNumberId ? config.waPhoneNumberId : null,
        waba_id: config.waBusinessAccountId || null,
        graph_version: config.graphVersion,
        webhook: { ...webhookStats, since: startedAt },
      };
      if (config.waToken && config.waPhoneNumberId) {
        try {
          out.phone = await wa.getPhoneInfo();
        } catch (e) {
          out.phone_error = (e as Error).message;
        }
        if (config.waBusinessAccountId) {
          try {
            const subs = await wa.getSubscribedApps();
            out.subscribed = Array.isArray(subs?.data) && subs.data.length > 0;
          } catch (e) {
            out.subscribed_error = (e as Error).message;
          }
        }
      }
      return out;
    });

    api.post("/api/whatsapp/subscribe", async (_req, reply) => {
      try {
        return { ok: true, result: await wa.subscribeApp() };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });

    api.post("/api/whatsapp/test-message", async (req, reply) => {
      const b = z
        .object({
          to: z.string().regex(/^\+?\d{8,15}$/),
          confirm: z.literal(true),
          template: z.string().regex(/^[a-z0-9_]+$/).default("hello_world"),
          language: z.string().regex(/^[a-zA-Z_]+$/).default("en_US"),
        })
        .parse(req.body);
      try {
        const id = await wa.sendTemplate(b.to.replace(/^\+/, ""), b.template, b.language);
        return { ok: true, message_id: id };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "Неверные данные: " + err.issues.map((i) => i.path.join(".") + " " + i.message).join("; ") });
    }
    const code = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (code >= 500) req.log.error(err);
    return reply.code(code).send({ error: code >= 500 ? "Внутренняя ошибка сервера" : err.message });
  });

  // Privacy policy page: Meta's crawler checks this URL before an app can be published.
  // Always return the complete page (200, never a partial 206 response) and ask proxies
  // not to re-encode it — otherwise Meta reports "BAD_CONTENT_ENCODING".
  const publicDir = path.resolve(process.cwd(), "public");
  const privacyHtml = fs.readFileSync(path.join(publicDir, "privacy.html"));
  const sendPrivacy = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(200)
      .header("Content-Type", "text/html; charset=utf-8")
      .header("Cache-Control", "no-store, no-transform")
      .header("Accept-Ranges", "none")
      .send(privacyHtml);
  app.get("/privacy.html", sendPrivacy);
  app.get("/privacy", sendPrivacy);

  // no-cache: phones always revalidate, so a new panel version shows up right after a deploy.
  await app.register(fastifyStatic, {
    root: publicDir,
    index: ["index.html"],
    acceptRanges: false,
    cacheControl: false,
    setHeaders: (res) => res.header("Cache-Control", "no-cache"),
  });

  return app;
}
