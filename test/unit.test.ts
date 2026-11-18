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
