import { config } from "./config.js";

/**
 * Push notification to the owner's iPhone via the free ntfy app (JSON publish API).
 * Only the contact name and reason are sent — never message contents (privacy).
 */
export async function notifyOwner(title: string, body: string, clickPath = "/") {
  if (!config.ntfyTopic) return;
  try {
    await fetch(config.ntfyServer.replace(/\/$/, ""), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: config.ntfyTopic,
        title,
        message: body,
        priority: 4,
        tags: ["speech_balloon"],
        ...(config.publicUrl ? { click: `${config.publicUrl.replace(/\/$/, "")}${clickPath}` } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.warn("[notify] failed:", (e as Error).message);
  }
}
