import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

/**
 * WhatsApp plays only MP4 (H.264 video + AAC audio) up to 16 MB.
 * iPhone gives .mov files (often H.264, sometimes HEVC) and they can be large,
 * so every video is converted here: a fast remux when the codecs already fit,
 * otherwise a re-encode sized to stay under the limit.
 */
const MAX_BYTES = 15.5 * 1024 * 1024;
const require = createRequire(import.meta.url);

export class VideoError extends Error {}

function ffmpegPath(): string {
  const p = require("ffmpeg-static") as string | null;
  if (!p) throw new VideoError("Конвертер видео недоступен на сервере");
  return p;
}

function run(args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, _out, stderr) => {
      resolve({ code: err ? ((err as any).code ?? 1) : 0, stderr: String(stderr) });
    });
  });
}

export interface VideoInfo {
  durationSec: number;
  videoCodec: string | null;
  audioCodec: string | null;
}

export function parseProbe(stderr: string): VideoInfo {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const durationSec = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
  const v = /Stream #[^\n]*Video:\s*([a-z0-9_]+)/i.exec(stderr);
  const a = /Stream #[^\n]*Audio:\s*([a-z0-9_]+)/i.exec(stderr);
  return { durationSec, videoCodec: v ? v[1].toLowerCase() : null, audioCodec: a ? a[1].toLowerCase() : null };
}

/** Converts any video to a WhatsApp-compatible MP4 under 16 MB. */
export async function toWhatsAppMp4(input: Buffer): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-video-"));
  const id = crypto.randomBytes(4).toString("hex");
  const src = path.join(dir, `in-${id}`);
  const out = path.join(dir, `out-${id}.mp4`);
  try {
    await fs.writeFile(src, input);
    const probe = await run(["-hide_banner", "-i", src], 30_000);
    const info = parseProbe(probe.stderr);
    if (!info.videoCodec) throw new VideoError("Не удалось прочитать видео. Попробуйте другой файл.");

    // 1) Codecs already fine: just repackage into MP4 (takes a second).
    const audioOk = info.audioCodec === null || info.audioCodec === "aac";
    if (info.videoCodec === "h264" && audioOk) {
      const r = await run(["-hide_banner", "-y", "-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", out], 120_000);
      if (r.code === 0) {
        const buf = await fs.readFile(out);
        if (buf.length <= MAX_BYTES) return buf;
      }
    }

    // 2) Re-encode to H.264/AAC with a bitrate that fits the size limit.
    const duration = Math.max(1, info.durationSec || 30);
    const audioKbps = 96;
    const videoKbps = Math.floor((MAX_BYTES * 8) / 1000 / duration / 1.05) - audioKbps;
    if (videoKbps < 150) {
      throw new VideoError(
        `Видео слишком длинное (${Math.round(duration)} с). Чтобы уложиться в лимит WhatsApp 16 МБ, отправьте видео до ~2 минут или обрежьте его в «Фото».`,
      );
    }
    const kbps = Math.min(videoKbps, 1800);
    const r = await run(
      [
        "-hide_banner", "-y", "-i", src,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))',format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main",
        "-b:v", `${kbps}k`, "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`,
        "-c:a", "aac", "-b:a", `${audioKbps}k`, "-ac", "2",
        "-movflags", "+faststart",
        out,
      ],
      15 * 60_000,
    );
    if (r.code !== 0) throw new VideoError("Не удалось конвертировать видео. Попробуйте другой файл.");
    const buf = await fs.readFile(out);
    if (buf.length > 16 * 1024 * 1024) throw new VideoError("После сжатия видео всё ещё больше 16 МБ. Обрежьте его и попробуйте снова.");
    return buf;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
