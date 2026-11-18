import { config, missingRequired, integrationStatus } from "./config.js";
import { initDb, getDb } from "./db.js";
import { buildServer } from "./server.js";
import { cleanupOldData, recover, startProcessor, stopProcessor } from "./processor.js";

async function main() {
  const missing = missingRequired();
  if (missing.length) {
    console.error(`Не заданы обязательные переменные окружения: ${missing.join(", ")}`);
    process.exit(1);
  }
  await initDb();
  startProcessor();
  const app = await buildServer();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log("Integrations:", JSON.stringify(integrationStatus()));
  const n = await recover();
  if (n) console.log(`Recovered pending work for ${n} contact(s)`);

  const housekeeping = setInterval(() => {
    cleanupOldData().catch((e) => console.error("[cleanup]", e.message));
  }, 6 * 3600_000);
  housekeeping.unref();
  void cleanupOldData().catch(() => {});

  const shutdown = async (sig: string) => {
    console.log(`${sig} received, shutting down…`);
    stopProcessor();
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
