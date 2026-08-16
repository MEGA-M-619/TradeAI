import { timingSafeEqual } from "node:crypto";

/**
 * Gates the two internal AI-assessment endpoints (queue drain, reaper)
 * that exist for the deployment-agnostic executor: whatever cron or
 * scheduler the eventual host provides calls these, not a user session.
 *
 * Fails closed: if INTERNAL_API_SECRET is not configured, every request
 * is denied rather than the check being silently skipped. Comparison is
 * constant-time to avoid leaking the secret's value through response
 * timing.
 */
export function verifyInternalSecret(request: Request): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return false;

  const provided = request.headers.get("x-internal-secret") ?? "";
  const secretBuf = Buffer.from(secret);
  const providedBuf = Buffer.from(provided);
  if (secretBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(secretBuf, providedBuf);
}
