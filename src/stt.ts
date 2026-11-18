import { config } from "./config.js";

/** Transcribes audio with any OpenAI-compatible /audio/transcriptions endpoint (Groq, OpenAI, ...). */
export async function transcribe(audio: Buffer, mimeType: string): Promise<string> {
  if (!config.sttApiKey) throw new Error("Распознавание речи не подключено");
  const ext = mimeType.includes("mpeg") ? "mp3" : mimeType.includes("mp4") || mimeType.includes("aac") ? "m4a" : mimeType.includes("amr") ? "amr" : "ogg";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType.split(";")[0] || "audio/ogg" }), `voice.${ext}`);
  form.append("model", config.sttModel);
  form.append("response_format", "json");
  form.append("temperature", "0");
  const res = await fetch(`${config.sttBaseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.sttApiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`STT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json: any = await res.json();
  return String(json.text ?? "").trim();
}

/** Rough duration estimate for WhatsApp voice notes (OGG/Opus ≈ 2 KB/s) — used only for the cost tracker. */
export function estimateAudioSeconds(bytes: number) {
  return Math.max(1, Math.round(bytes / 2000));
}
