import { config, missingRequired, integrationStatus } from "./config.js";
import { initDb, getDb } from "./db.js";
import { buildServer } from "./server.js";
import { cleanupOldData, recover, startProcessor, stopProcessor } from "./processor.js";
import { startCampaigns, stopCampaigns } from "./campaigns.js";
import { getPhoneInfo, waHealth } from "./whatsapp.js";
import { notifyOwner } from "./notify.js";
import { loadConnection } from "./signup.js";

/** Checks the WhatsApp token every 30 min and alerts the owner once when it stops working. */
function startHealthWatch() {
  let alerted = false;
  const check = async () => {
    if (!config.waToken || !config.waPhoneNumberId) return;
    try {
      await getPhoneInfo();
    } catch {
      /* waHealth is updated inside */
    }
    if (waHealth.authError && !alerted) {
      alerted = true;
      await notifyOwner("⚠️ WhatsApp отключён", "Токен WhatsApp недействителен или истёк — AI не может отвечать клиентам. Обновите WHATSAPP_TOKEN в Render.", "/#whatsapp");
    }
    if (!waHealth.authError) alerted = false;
  };
  setTimeout(() => void check(), 15_000).unref();
  setInterval(() => void check(), 30 * 60_000).unref();

  // Render's free plan sleeps after 15 min without traffic; reminders and scheduled
  // broadcasts would then not run on time. A light self-ping keeps the service awake
  // (a single service running all month fits in the free 750 instance hours).
  if (process.env.RENDER && config.publicUrl && process.env.KEEP_AWAKE !== "0") {
    const url = `${config.publicUrl.replace(/\/$/, "")}/health`;
    setInterval(() => {
      fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => {});
    }, 10 * 60_000).unref();
  }
}

async function main() {
  const missing = missingRequired();
  if (missing.length) {
    console.error(`Не заданы обязательные переменные окружения: ${missing.join(", ")}`);
    process.exit(1);
  }
  await initDb();
  await loadConnection();
  startProcessor();
  const app = await buildServer();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log("Integrations:", JSON.stringify(integrationStatus()));
  startCampaigns();
  startHealthWatch();
  const n = await recover();
  if (n) console.log(`Recovered pending work for ${n} contact(s)`);
  // Pick up anything a previous instance left half-done once it has surely stopped.
  setTimeout(() => void recover().catch(() => {}), 6 * 60_000).unref();

  const housekeeping = setInterval(() => {
    cleanupOldData().catch((e) => console.error("[cleanup]", e.message));
  }, 6 * 3600_000);
  housekeeping.unref();
  void cleanupOldData().catch(() => {});

  const shutdown = async (sig: string) => {
    console.log(`${sig} received, shutting down…`);
    stopProcessor();
    stopCampaigns();
    clearInterval(housekeeping);
    await app.close().catch(() => {});
    await getDb().close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
  process.on("uncaughtException", (e) => {
    console.error("[uncaughtException]", e);
    // Let the platform restart us cleanly; pending work is recovered from the database.
    process.exit(1);
  });
}

main().catch((e) => {
  console.error("Fatal start-up error:", e);
  process.exit(1);
});
