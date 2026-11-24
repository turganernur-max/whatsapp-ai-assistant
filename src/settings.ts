import { z } from "zod";
import { getDb } from "./db.js";

export const MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-2",
  "claude-opus-5",
  "claude-sonnet-5",
] as const;

export const SettingsSchema = z.object({
  ai_enabled: z.boolean(),
  business_name: z.string().max(200),
  owner_name: z.string().max(200),
  instructions: z.string().max(50_000),
  style_examples: z.string().max(20_000),
  auto_learn_style: z.boolean(),
  model: z.enum(MODELS),
  effort: z.enum(["low", "medium", "high"]),
  max_reply_chars: z.number().int().min(100).max(4000),
  history_messages: z.number().int().min(4).max(100),
  disclosure_enabled: z.boolean(),
  disclosure_text: z.string().max(1000),
  handoff_message: z.string().max(1000),
  owner_takeover_hours: z.number().min(0).max(720),
  pause_after_handoff: z.boolean(),
  monthly_budget_usd: z.number().min(0).max(100_000),
  max_ai_replies_per_hour: z.number().int().min(1).max(500),
  opt_out_words: z.string().max(500),
  opt_out_reply: z.string().max(500),
  retention_days: z.number().int().min(0).max(3650),
  send_read_receipts: z.boolean(),
  timezone: z.string().max(64),
  handoff_mode: z.enum(["rare", "balanced", "strict"]),
  followup_enabled: z.boolean(),
  followup_hours: z.number().min(0.5).max(20),
  followup_max: z.number().int().min(1).max(10),
  followup_persistent_all: z.boolean(),
  human_style: z.boolean(),
  human_delay: z.boolean(),
  sales_mode: z.boolean(),
  business_mode: z.enum(["sales", "recruiting", "general"]),
  vacancies: z.string().max(20_000),
  interview_schedule: z.string().max(5000),
  screening_questions: z.string().max(5000),
  payment_instructions: z.string().max(3000),
  delivery_info: z.string().max(5000),
  currency: z.string().max(10),
  template_price_usd: z.number().min(0).max(5),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  ai_enabled: false, // the owner switches AI on explicitly from the panel
  business_name: "",
  owner_name: "",
  instructions:
    "Ты отвечаешь клиентам от имени моего бизнеса.\n" +
    "- Отвечай вежливо, коротко и по делу.\n" +
    "- Цены, адреса, график работы и условия бери только из базы знаний.\n" +
    "- Если клиент хочет оформить заказ, уточни имя, что именно нужно и удобное время.\n",
  style_examples: "",
  auto_learn_style: true,
  model: "claude-opus-5-5",
  effort: "low",
  max_reply_chars: 1000,
  history_messages: 30,
  disclosure_enabled: true,
  disclosure_text:
    "Здравствуйте! Вам отвечает AI-помощник. Если нужно, я передам ваш вопрос владельцу.\n" +
    "Сәлеметсіз бе! Сізге AI-көмекші жауап беріп жатыр. Қажет болса, сұрағыңызды иесіне жеткіземін.",
  handoff_message:
    "Спасибо! Я передал ваш вопрос владельцу, он ответит вам лично в ближайшее время.",
  owner_takeover_hours: 12,
  pause_after_handoff: false, // AI keeps talking after a handoff; it stops only when the owner writes
  monthly_budget_usd: 10,
  max_ai_replies_per_hour: 20,
  opt_out_words: "стоп, stop, тоқта, отписаться",
  opt_out_reply:
    "Хорошо, автоматические ответы для вас отключены. Владелец ответит вам лично.",
  retention_days: 365,
  send_read_receipts: true,
  timezone: "Asia/Almaty",
  handoff_mode: "balanced",
  followup_enabled: false,
  followup_hours: 3,
  followup_max: 4,
  followup_persistent_all: false,
  human_style: true,
  human_delay: true,
  sales_mode: true,
  business_mode: "sales",
  vacancies: "",
  interview_schedule: "",
  screening_questions: "",
  payment_instructions: "",
  delivery_info: "",
  currency: "₸",
  template_price_usd: 0.05,
};

let cache: Settings | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache) return cache;
  const rows = await getDb().query<{ key: string; value: unknown }>(`SELECT key, value FROM settings`);
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) merged[r.key] = r.value;
  const parsed = SettingsSchema.safeParse(merged);
  cache = parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
  return cache;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const valid = SettingsSchema.partial().strict().parse(patch);
  const d = getDb();
  for (const [k, v] of Object.entries(valid)) {
    await d.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [k, JSON.stringify(v)],
    );
  }
  cache = null;
  return getSettings();
}

export function clearSettingsCache() {
  cache = null;
}
