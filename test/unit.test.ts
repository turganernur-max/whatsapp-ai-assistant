import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { parseWebhook, splitMessage, verifySignature } from "../src/whatsapp.js";
import { isOptOut } from "../src/processor.js";
import { costUsd } from "../src/pricing.js";
import { buildMessages } from "../src/ai.js";

test("webhook signature verification", () => {
  const body = Buffer.from('{"a":1}');
  const sig = "sha256=" + crypto.createHmac("sha256", "secret").update(body).digest("hex");
  assert.equal(verifySignature(body, sig, "secret"), true);
  assert.equal(verifySignature(body, sig, "other"), false);
  assert.equal(verifySignature(Buffer.from('{"a":2}'), sig, "secret"), false);
  assert.equal(verifySignature(body, undefined, "secret"), false);
  assert.equal(verifySignature(body, "sha256=abc", "secret"), false);
  assert.equal(verifySignature(body, sig, ""), false);
});

test("parseWebhook extracts messages, statuses, echoes and ignores other numbers", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "PN1" },
              contacts: [{ wa_id: "7701", profile: { name: "Айгерим" } }],
              messages: [
                { id: "m1", from: "7701", timestamp: "1700000000", type: "text", text: { body: "Сәлем" } },
                { id: "m2", from: "7701", timestamp: "1700000001", type: "audio", audio: { id: "AUD", mime_type: "audio/ogg" } },
              ],
              statuses: [{ id: "o1", status: "delivered", recipient_id: "7701" }],
            },
          },
          { field: "messages", value: { metadata: { phone_number_id: "OTHER" }, messages: [{ id: "x", from: "1", type: "text", text: { body: "no" } }] } },
          { field: "smb_message_echoes", value: { metadata: { phone_number_id: "PN1" }, message_echoes: [{ id: "e1", from: "biz", to: "7701", timestamp: "1700000002", type: "text", text: { body: "Я сам" } }] } },
        ],
      },
    ],
  };
  const ev = parseWebhook(payload, "PN1");
  assert.equal(ev.length, 4);
  assert.deepEqual(ev[0], { kind: "message", waMessageId: "m1", from: "7701", name: "Айгерим", timestamp: 1700000000, type: "text", text: "Сәлем" });
  assert.equal(ev[1].kind === "message" && ev[1].mediaId, "AUD");
  assert.equal(ev[2].kind, "status");
  assert.equal(ev[3].kind === "echo" && ev[3].text, "Я сам");
  assert.deepEqual(parseWebhook({ object: "page" }, "PN1"), []);
});

test("splitMessage keeps chunks under the limit", () => {
  const long = ("Предложение номер один. ".repeat(400)).trim();
  const parts = splitMessage(long, 4000);
  assert.ok(parts.length >= 3);
  assert.ok(parts.every((p) => p.length <= 4000));
  assert.equal(parts.join(" ").replace(/\s+/g, " "), long.replace(/\s+/g, " "));
  assert.deepEqual(splitMessage("short"), ["short"]);
});

test("opt-out words match whole message only", () => {
  const w = "стоп, stop, тоқта";
  assert.equal(isOptOut("Стоп!", w), true);
  assert.equal(isOptOut("тоқта", w), true);
  assert.equal(isOptOut("не стоп, расскажите ещё", w), false);
});

test("cost calculation", () => {
  const c = costUsd("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 });
  assert.ok(Math.abs(c - (4 + 2 + 0.2)) < 1e-9);
  assert.ok(costUsd("unknown-model", { input_tokens: 1000, output_tokens: 0 }) > 0);
});

test("buildMessages alternates roles, starts and ends with user", () => {
  const msgs = buildMessages(
    [
      { sender: "ai", text: "Здравствуйте" },
      { sender: "contact", text: "Привет" },
      { sender: "contact", text: "Цена?" },
      { sender: "owner", text: "1000" },
      { sender: "contact", text: "Ок" },
    ],
    [],
    "now",
  );
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(msgs[0].content, "Привет\nЦена?");
  const last = msgs[2].content as any[];
  assert.equal(last[0].text, "Ок");
});

test("token pasted together with Meta's curl example is cleaned; secrets are redacted", async () => {
  const { cleanToken, tokenProblem } = await import("../src/config.js");
  const { redact } = await import("../src/whatsapp.js");
  const tok = "EAAFAKEtokenFORtests0000000000000000000000";
  const curl = `curl -i -X POST \`https://graph.facebook.com/v25.0/123/messages\` -H 'Authorization: Bearer ${tok}' -H 'Content-Type: application/json' -d '{}'`;
  assert.equal(cleanToken(curl), tok);
  assert.equal(cleanToken(`  Bearer ${tok}\n`), tok);
  assert.equal(cleanToken(tok), tok);
  assert.equal(tokenProblem(tok), null);
  assert.ok(tokenProblem("EAA abc def ghi jkl mno pqr"));
  assert.ok(!redact(`Headers.append: "Bearer ${tok}" is invalid`).includes(tok));
  assert.ok(!redact(`token ${tok} here`).includes(tok));
});

test("alternate recipient spelling for KZ/RU numbers", async () => {
  const { alternateRecipient } = await import("../src/whatsapp.js");
  assert.equal(alternateRecipient("77071234567"), "787071234567");
  assert.equal(alternateRecipient("787071234567"), "77071234567");
  assert.equal(alternateRecipient("15551234567"), null);
});

test("videos are converted to WhatsApp MP4 (remux for H.264, re-encode otherwise)", async () => {
  const fs = await import("node:fs");
  const { toWhatsAppMp4, parseProbe } = await import("../src/video.js");
  const { execFileSync } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const ff = createRequire(import.meta.url)("ffmpeg-static") as string;
  const probe = (buf: Buffer) => {
    const f = `${process.env.TMPDIR || "/tmp"}/probe-${Date.now()}.mp4`;
    fs.writeFileSync(f, buf);
    try {
      execFileSync(ff, ["-hide_banner", "-i", f], { stdio: "pipe" });
    } catch (e: any) {
      return parseProbe(String(e.stderr));
    } finally {
      fs.rmSync(f, { force: true });
    }
    return parseProbe("");
  };
  for (const name of ["h264.mov", "mpeg4.mov"]) {
    const out = await toWhatsAppMp4(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
    const info = probe(out);
    assert.equal(info.videoCodec, "h264", name);
    assert.equal(info.audioCodec, "aac", name);
    assert.ok(out.length < 16 * 1024 * 1024);
  }
});

test("handoff mode changes the rules given to the AI", async () => {
  const { buildSystem } = await import("../src/ai.js");
  const { DEFAULT_SETTINGS } = await import("../src/settings.js");
  const text = (mode: "rare" | "balanced" | "strict") => (buildSystem({ ...DEFAULT_SETTINGS, handoff_mode: mode }, [], [])[0] as any).text as string;
  assert.equal(DEFAULT_SETTINGS.handoff_mode, "balanced");
  assert.match(text("rare"), /ТОЛЬКО если/);
  assert.match(text("balanced"), /не передавай владельцу без необходимости/);
  assert.match(text("strict"), /ты не уверен/);
  assert.doesNotMatch(text("rare"), /\{HANDOFF_RULES\}/);
});

test("humanBubbles splits on blank lines into at most 3 bubbles", async () => {
  const { humanBubbles } = await import("../src/processor.js");
  assert.deepEqual(humanBubbles("Сәлем!\n\nҚалайсыз?"), ["Сәлем!", "Қалайсыз?"]);
  assert.deepEqual(humanBubbles("бір жол\nекінші жол"), ["бір жол\nекінші жол"]);
  assert.equal(humanBubbles("a\n\nb\n\nc\n\nd").length, 1, "too many parts → keep as one message");
});
