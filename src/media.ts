import { getDb } from "./db.js";
import { MEDIA_RULES, sendMediaMessage, uploadMedia, type MediaKind } from "./whatsapp.js";
import { toWhatsAppMp4, VideoError } from "./video.js";

export interface MediaItem {
  id: number;
  title: string;
  description: string;
  kind: MediaKind;
  mime: string;
  filename: string;
  size: number;
  enabled: boolean;
  created_at: Date;
}

const LIBRARY_LIMIT_BYTES = 200 * 1024 * 1024; // keeps the free database small
const REUPLOAD_AFTER_MS = 25 * 24 * 3600_000; // WhatsApp media ids expire after ~30 days

export class MediaError extends Error {}

export const MAX_RAW_UPLOAD = 80 * 1024 * 1024; // before video conversion

/**
 * Normalises an uploaded file for WhatsApp: any video becomes an MP4 (H.264/AAC) under 16 MB.
 * Returns the bytes to store/send plus the final type and name.
 */
export async function prepareFile(data: Buffer, mime: string, filename: string) {
  const m = (mime || "").toLowerCase().split(";")[0].trim();
  if (m.startsWith("video/")) {
    if (data.length > MAX_RAW_UPLOAD) throw new MediaError("Видео больше 80 МБ. Обрежьте его в «Фото» и попробуйте снова.");
    let mp4: Buffer;
    try {
      mp4 = await toWhatsAppMp4(data);
    } catch (e) {
      throw new MediaError(e instanceof VideoError ? e.message : "Не удалось обработать видео");
    }
    const base = (filename || "video").replace(/\.[^.]+$/, "");
    return { data: mp4, mime: "video/mp4", filename: `${base}.mp4`, kind: "video" as MediaKind };
  }
  const kind = validateFile(m, data.length);
  return { data, mime: m, filename, kind };
}

/** Picks how WhatsApp should show a file. Unsupported video formats (e.g. iPhone .mov) go as documents. */
export function classify(mime: string): MediaKind {
  const m = mime.toLowerCase().split(";")[0].trim();
  if (MEDIA_RULES.image.mimes.includes(m)) return "image";
  if (MEDIA_RULES.video.mimes.includes(m)) return "video";
  return "document";
}

export function validateFile(mime: string, size: number): MediaKind {
  if (!mime) throw new MediaError("Неизвестный тип файла");
  if (mime.startsWith("image/") && classify(mime) !== "image") {
    throw new MediaError("Фото должно быть JPEG или PNG");
  }
  const kind = classify(mime);
  const max = MEDIA_RULES[kind].maxBytes;
  if (size <= 0) throw new MediaError("Пустой файл");
  if (size > max) {
    throw new MediaError(
      `Файл слишком большой: ${(size / 1024 / 1024).toFixed(1)} МБ. WhatsApp разрешает до ${Math.round(max / 1024 / 1024)} МБ для ${kind === "image" ? "фото" : kind === "video" ? "видео" : "файлов"}.`,
    );
  }
  return kind;
}

export function safeFilename(name: string, mime: string): string {
  const cleaned = String(name || "").replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 100).trim();
  if (cleaned) return cleaned;
  const ext = mime.split("/")[1]?.split(";")[0] || "bin";
  return `file.${ext}`;
}

export async function listMedia(enabledOnly = false): Promise<MediaItem[]> {
  return getDb().query<MediaItem>(
    `SELECT id, title, description, kind, mime, filename, size, enabled, created_at FROM media
     ${enabledOnly ? "WHERE enabled" : ""} ORDER BY id`,
  );
}

export async function addMedia(raw: { title: string; description: string; filename: string; mime: string; data: Buffer }) {
  const prepared = await prepareFile(raw.data, raw.mime, raw.filename);
  const input = { ...raw, ...prepared };
  const kind = prepared.kind;
  const [{ total }] = await getDb().query<{ total: number }>(`SELECT COALESCE(SUM(size),0)::float8 AS total FROM media`);
  if (Number(total) + input.data.length > LIBRARY_LIMIT_BYTES) {
    throw new MediaError("Медиатека заполнена (200 МБ). Удалите ненужные файлы.");
  }
  const [row] = await getDb().query<MediaItem>(
    `INSERT INTO media (title, description, kind, mime, filename, size, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, title, description, kind, mime, filename, size, enabled, created_at`,
    [input.title, input.description, kind, input.mime, safeFilename(input.filename, input.mime), input.data.length, input.data],
  );
  return row;
}

export async function getMediaFile(id: number) {
  const [row] = await getDb().query<{ data: Uint8Array; mime: string; filename: string; kind: MediaKind }>(
    `SELECT data, mime, filename, kind FROM media WHERE id = $1`,
    [id],
  );
  if (!row) return null;
  return { ...row, data: Buffer.from(row.data) };
}

/** Makes sure the library item has a fresh WhatsApp media id; uploads it if needed. */
async function ensureUploaded(id: number): Promise<{ mediaId: string; item: MediaItem }> {
  const [row] = await getDb().query<MediaItem & { wa_media_id: string | null; wa_uploaded_at: Date | null }>(
    `SELECT id, title, description, kind, mime, filename, size, enabled, created_at, wa_media_id, wa_uploaded_at
     FROM media WHERE id = $1`,
    [id],
  );
  if (!row) throw new MediaError(`Файл #${id} не найден в медиатеке`);
  if (row.wa_media_id && row.wa_uploaded_at && Date.now() - new Date(row.wa_uploaded_at).getTime() < REUPLOAD_AFTER_MS) {
    return { mediaId: row.wa_media_id, item: row };
  }
  const file = await getMediaFile(id);
  if (!file) throw new MediaError(`Файл #${id} не найден`);
  const mediaId = await uploadMedia(file.data, file.mime, file.filename);
  await getDb().query(`UPDATE media SET wa_media_id = $2, wa_uploaded_at = now() WHERE id = $1`, [id, mediaId]);
  return { mediaId, item: row };
}

/** Sends a library item; returns the WhatsApp message id and a short label for the chat history. */
export async function sendLibraryItem(to: string, id: number) {
  const send = async () => {
    const { mediaId, item } = await ensureUploaded(id);
    const caption = item.kind === "document" ? item.title : undefined;
    const waId = await sendMediaMessage(to, item.kind, mediaId, caption, item.filename);
    return { waId, item };
  };
  try {
    return await send();
  } catch (e) {
    // A cached media id may have expired on WhatsApp's side: upload once more and retry.
    await getDb().query(`UPDATE media SET wa_media_id = NULL WHERE id = $1`, [id]);
    return await send().catch(() => {
      throw e;
    });
  }
}

/** Sends a one-off file (owner attaches it in the chat); nothing is stored. */
export async function sendOneOffFile(to: string, raw: { data: Buffer; mime: string; filename: string; caption?: string }) {
  const file = { ...raw, ...(await prepareFile(raw.data, raw.mime, raw.filename)) };
  const kind = file.kind;
  const filename = safeFilename(file.filename, file.mime);
  const mediaId = await uploadMedia(file.data, file.mime, filename);
  const waId = await sendMediaMessage(to, kind, mediaId, file.caption, filename);
  return { waId, kind, filename };
}

export function mediaLabel(kind: MediaKind, title: string): string {
  const icon = kind === "image" ? "📷" : kind === "video" ? "🎬" : "📎";
  return `${icon} ${title}`;
}
