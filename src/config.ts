// All secrets come from environment variables only. Nothing secret is stored in git.
function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  port: Number(env("PORT", "3000")),
  publicUrl: env("PUBLIC_URL"), // e.g. https://my-assistant.onrender.com
  nodeEnv: env("NODE_ENV", "development"),

  // Database: Postgres URL in production; otherwise an embedded Postgres (PGlite) in DATA_DIR.
  databaseUrl: env("DATABASE_URL"),
  dataDir: env("DATA_DIR", "./data"),

  // Control panel
  adminPassword: env("ADMIN_PASSWORD"),
  sessionSecret: env("SESSION_SECRET"),

  // WhatsApp Cloud API (Meta)
  waToken: env("WHATSAPP_TOKEN"),
  waPhoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"),
  waBusinessAccountId: env("WHATSAPP_BUSINESS_ACCOUNT_ID"),
  waAppSecret: env("META_APP_SECRET"),
  waVerifyToken: env("WEBHOOK_VERIFY_TOKEN"),
  graphVersion: env("GRAPH_API_VERSION", "v23.0"),
  graphBase: env("GRAPH_API_BASE", "https://graph.facebook.com"),

  // Claude
  anthropicApiKey: env("ANTHROPIC_API_KEY"),

  // Optional speech-to-text (any OpenAI-compatible /audio/transcriptions endpoint, e.g. Groq or OpenAI)
  sttApiKey: env("STT_API_KEY"),
  sttBaseUrl: env("STT_BASE_URL", "https://api.groq.com/openai/v1"),
  sttModel: env("STT_MODEL", "whisper-large-v3"),

  // Optional push notifications to the owner's phone via the free ntfy app (https://ntfy.sh)
  ntfyTopic: env("NTFY_TOPIC"),
  ntfyServer: env("NTFY_SERVER", "https://ntfy.sh"),

  // Message batching: wait this long for follow-up messages before answering
  debounceMs: Number(env("DEBOUNCE_MS", "4000")),
};

export function missingRequired(): string[] {
  const req: Array<[string, string]> = [
    ["ADMIN_PASSWORD", config.adminPassword],
    ["SESSION_SECRET", config.sessionSecret],
  ];
  const out = req.filter(([, v]) => !v).map(([k]) => k);
  if (config.adminPassword && config.adminPassword.length < 10) out.push("ADMIN_PASSWORD (минимум 10 символов)");
  if (config.sessionSecret && config.sessionSecret.length < 16) out.push("SESSION_SECRET (минимум 16 символов)");
  return out;
}

export function integrationStatus() {
  return {
    whatsapp: Boolean(config.waToken && config.waPhoneNumberId),
    webhookSignature: Boolean(config.waAppSecret),
    webhookVerifyToken: Boolean(config.waVerifyToken),
    claude: Boolean(config.anthropicApiKey),
    speechToText: Boolean(config.sttApiKey),
    notifications: Boolean(config.ntfyTopic),
    database: config.databaseUrl ? "postgres" : "embedded",
  };
}
