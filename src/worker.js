/**
 * Columbus (HACG) prototype - password protection Worker.
 *
 * Every request reaches this Worker first (assets.run_worker_first = true),
 * so the prototype in /public is never served without a valid session.
 *
 * Secrets (set in the Cloudflare dashboard, never in code):
 *   PROTOTYPE_PASSWORD  the shared password
 *   SESSION_SECRET      long random string used to sign session cookies
 * Bindings (wrangler.jsonc):
 *   ASSETS         the static prototype (public/index.html)
 *   LOGIN_LIMITER  rate limiter for password attempts (optional but recommended)
 */
import LOGIN_PAGE from "./login.html";

const COOKIE_NAME = "__Host-hacg_session";
const SESSION_TTL_SECONDS = 24 * 60 * 60;          // 24 hours
const MAX_BODY_BYTES = 2048;
const FAILED_ATTEMPT_DELAY_MS = 400;               // slows down guessing
const FALLBACK_LIMIT = { attempts: 5, windowMs: 60_000 }; // used only if LOGIN_LIMITER is missing

const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/api/auth/login":   return await handleLogin(request, env, url);
        case "/api/auth/session": return await handleSession(request, env);
        case "/api/auth/logout":  return handleLogout(request);
      }
      if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);

      if (!(await hasValidSession(request, env))) return denied(request, url);

      const res = await env.ASSETS.fetch(request);
      return secure(res, { cache: "private, no-store" });
    } catch (err) {
      console.error("worker error", err && err.stack || err);
      if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "server_error" }, 500);
      return new Response("Something went wrong.", { status: 500, headers: baseHeaders("text/plain; charset=utf-8") });
    }
  },
};

/* ---------------- routes ---------------- */

async function handleLogin(request, env, url) {
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, { Allow: "POST" });

  // Same-origin only: blocks other sites from submitting the form (login CSRF).
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ ok: false, error: "forbidden" }, 403);

  // Missing configuration = service unavailable (the screen shows the "could not check" message).
  if (!env.PROTOTYPE_PASSWORD || !env.SESSION_SECRET) {
    console.error("PROTOTYPE_PASSWORD or SESSION_SECRET is not set");
    return json({ ok: false, error: "not_configured" }, 503);
  }

  // Repeated attempts: 5 per minute per IP address.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await allowAttempt(env, ip))) {
    return json({ ok: false, error: "too_many_attempts" }, 429, { "Retry-After": "60" });
  }

  const password = await readPassword(request);
  const isForm = isFormPost(request);

  if (password === null || !(await passwordMatches(password, env.PROTOTYPE_PASSWORD))) {
    await sleep(FAILED_ATTEMPT_DELAY_MS);
    if (isForm) return redirect("/", null);
    return json({ ok: false }, 401);
  }

  const cookie = await createSessionCookie(env);
  if (isForm) return redirect("/", cookie);
  return json({ ok: true }, 200, { "Set-Cookie": cookie });
}

async function handleSession(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405, { Allow: "GET" });
  if (!env.SESSION_SECRET || !env.PROTOTYPE_PASSWORD) return json({ authenticated: false, error: "not_configured" }, 503);
  const ok = await hasValidSession(request, env);
  return json({ authenticated: ok }, ok ? 200 : 401);
}

function handleLogout(request) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  const clear = `${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
  return json({ ok: true }, 200, { "Set-Cookie": clear });
}

/* Not signed in: page navigations get the password screen (200, never cached),
   every other request (JS, CSS, images, data, other methods) gets a plain 401.
   The password screen is a separate page bundled in the Worker; it contains none
   of the prototype, so serving it with 200 exposes nothing. 200 is used instead of
   401 so proxies and browser extensions that treat 401 specially still show it. */
function denied(request, url) {
  const accept = request.headers.get("Accept") || "";
  const dest = request.headers.get("Sec-Fetch-Dest") || "";
  const wantsPage = (request.method === "GET" || request.method === "HEAD") &&
    (dest === "document" || accept.includes("text/html") || url.pathname === "/" || url.pathname.endsWith(".html"));
  if (wantsPage) {
    return new Response(request.method === "HEAD" ? null : LOGIN_PAGE, {
      status: 200,
      headers: { ...baseHeaders("text/html; charset=utf-8"), Vary: "Cookie, Accept" },
    });
  }
  return new Response("Authentication required.", { status: 401, headers: baseHeaders("text/plain; charset=utf-8") });
}

/* ---------------- password + rate limiting ---------------- */

async function readPassword(request) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  const type = request.headers.get("Content-Type") || "";
  try {
    if (type.includes("application/json")) {
      const body = JSON.parse(text);
      return typeof body.password === "string" ? body.password : null;
    }
    if (type.includes("application/x-www-form-urlencoded")) {
      const v = new URLSearchParams(text).get("password");
      return typeof v === "string" ? v : null;
    }
  } catch (_) { /* malformed body */ }
  return null;
}

function isFormPost(request) {
  return (request.headers.get("Content-Type") || "").includes("application/x-www-form-urlencoded");
}

/* Constant-time comparison: hash both values to equal length, then compare. */
async function passwordMatches(given, expected) {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  return timingSafeEqual(a, b);
}

const memoryAttempts = new Map(); // best-effort fallback, per Worker instance
async function allowAttempt(env, ip) {
  if (env.LOGIN_LIMITER && typeof env.LOGIN_LIMITER.limit === "function") {
    const { success } = await env.LOGIN_LIMITER.limit({ key: `login:${ip}` });
    return success;
  }
  const now = Date.now();
  const recent = (memoryAttempts.get(ip) || []).filter((t) => now - t < FALLBACK_LIMIT.windowMs);
  if (recent.length >= FALLBACK_LIMIT.attempts) { memoryAttempts.set(ip, recent); return false; }
  recent.push(now);
  memoryAttempts.set(ip, recent);
  if (memoryAttempts.size > 5000) memoryAttempts.clear();
  return true;
}

/* ---------------- signed session cookie ----------------
   Value: v1.<expires-unix>.<random-id>.<signature>
   signature = HMAC-SHA256(SESSION_SECRET, "v1.<expires>.<id>.<password-fingerprint>")
   The password fingerprint means changing PROTOTYPE_PASSWORD signs everyone out. */

async function createSessionCookie(env) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const id = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const sig = await sign(env, `v1.${expires}.${id}`);
  return `${COOKIE_NAME}=v1.${expires}.${id}.${sig}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

async function hasValidSession(request, env) {
  if (!env.SESSION_SECRET || !env.PROTOTYPE_PASSWORD) return false;
  const value = readCookie(request, COOKIE_NAME);
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const [, expStr, id, sig] = parts;
  const expires = Number(expStr);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(expires) || expires <= now || expires > now + SESSION_TTL_SECONDS + 60) return false;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return false;
  const expected = await sign(env, `v1.${expires}.${id}`);
  return timingSafeEqual(enc.encode(sig), enc.encode(expected));
}

const keyCache = new Map();
async function sign(env, payload) {
  let key = keyCache.get(env.SESSION_SECRET);
  if (!key) {
    key = await crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyCache.clear();
    keyCache.set(env.SESSION_SECRET, key);
  }
  const fingerprint = b64url(await sha256(`password:${env.PROTOTYPE_PASSWORD}`)).slice(0, 16);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${payload}.${fingerprint}`));
  return b64url(mac);
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/* ---------------- helpers ---------------- */

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

function timingSafeEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function baseHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "frame-ancestors 'none'",
  };
}

function json(body, status, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...baseHeaders("application/json; charset=utf-8"), ...extra } });
}

function redirect(location, cookie) {
  const headers = { Location: location, "Cache-Control": "no-store" };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(null, { status: 303, headers });
}

function secure(res, { cache }) {
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", cache);
  out.headers.set("X-Robots-Tag", "noindex, nofollow");
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "same-origin");
  out.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  out.headers.append("Vary", "Cookie");
  return out;
}
