import crypto from "node:crypto";
import { config } from "./config.js";

const SESSION_DAYS = 30;
export const COOKIE = "wa_sid";

function key() {
  return crypto.createHash("sha256").update(`${config.sessionSecret}|${config.adminPassword}`).digest();
}

export function checkPassword(input: string): boolean {
  if (!config.adminPassword) return false;
  const a = crypto.createHash("sha256").update(String(input)).digest();
  const b = crypto.createHash("sha256").update(config.adminPassword).digest();
  return crypto.timingSafeEqual(a, b);
}

export function issueToken(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 86400_000, n: crypto.randomBytes(8).toString("hex") })).toString("base64url");
  const sig = crypto.createHmac("sha256", key()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token || !config.sessionSecret || !config.adminPassword) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = crypto.createHmac("sha256", key()).update(payload).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

export const SESSION_MAX_AGE = SESSION_DAYS * 86400;

// Brute-force protection: 5 failed logins per IP per 15 minutes.
const attempts = new Map<string, { n: number; until: number }>();
export function loginBlocked(ip: string) {
  const a = attempts.get(ip);
  return !!a && a.n >= 5 && a.until > Date.now();
}
export function loginFailed(ip: string) {
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) attempts.set(ip, { n: 1, until: Date.now() + 15 * 60_000 });
  else a.n++;
}
export function loginOk(ip: string) {
  attempts.delete(ip);
}
