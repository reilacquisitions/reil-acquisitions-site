/**
 * POST /api/lead — lead capture for reilacquisitions.com
 *
 * Leads are EMAILED. Delivery happens server-side; the browser never opens a
 * mail client, never hands off to a third-party form service, and no chat
 * platform is involved.
 *
 * Env vars (set in Vercel):
 *   RESEND_API_KEY  - Resend API key (required)
 *   RESEND_FROM     - From header. reilacquisitions.com is verified in Resend,
 *                     so leads are sent as website@reilacquisitions.com.
 *   LEAD_TO         - destination, defaults to hello@reilacquisitions.com
 *   LEAD_BCC        - optional extra recipient
 *
 * Responses:
 *   200 {ok:true, id}          accepted by Resend
 *   400 {ok:false,error}       validation failure
 *   502 {ok:false,failed}      provider rejected the send
 *   503 {ok:false,error}       no provider configured
 *
 * Zero npm dependencies - uses global fetch (Node 18+).
 */

const REQUIRED = ["name", "email"];

function parseBody(req) {
  const b = req.body;
  if (typeof b === "string") {
    try { return JSON.parse(b); } catch (e) {
      const out = {};
      new URLSearchParams(b).forEach((v, k) => { out[k] = v; });
      return out;
    }
  }
  return b || {};
}

const clean = (s, max) => String(s == null ? "" : s).trim().slice(0, max || 4000);
const esc = (s) => String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

function rows(d) {
  return [
    ["Name", clean(d.name, 200)],
    ["Email", clean(d.email, 200)],
    ["Company", clean(d.company, 200)],
    ["Phone", clean(d.phone, 60)],
    ["Looking to", clean(d.intent, 80)],
    ["Source", clean(d.source, 120) || "Website contact form"],
  ].filter((r) => r[1]);
}

/* ---------------- attribution ----------------
   Where did this lead come from? Captured server-side, so it still works for
   visitors without JavaScript and never depends on a third-party tracker.  */

const SEARCH_SOURCES = ["google.", "bing.", "duckduckgo.", "yahoo.", "ecosia.", "brave.", "startpage.", "qwant.", "yandex.", "marginalia."];
const SOCIAL_SOURCES = ["facebook.", "fb.", "instagram.", "linkedin.", "lnkd.in", "twitter.", "x.com", "t.co", "reddit.", "youtube.", "youtu.be", "tiktok.", "pinterest.", "threads.", "nextdoor."];

function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./i, "").toLowerCase(); } catch (e) { return ""; }
}

function classifyChannel(referrer, utmMedium, utmSource) {
  const m = clean(utmMedium, 60).toLowerCase();
  const s = clean(utmSource, 60).toLowerCase();
  if (m) return s ? `${m} / ${s}` : m;
  if (s) return s;
  const host = hostOf(referrer);
  if (!host) return "direct or unknown";
  if (host === "reilacquisitions.com" || host.slice(-19) === ".reilacquisitions.com") return "internal";
  if (SEARCH_SOURCES.some((d) => host.indexOf(d) !== -1)) return "organic search";
  if (SOCIAL_SOURCES.some((d) => host.indexOf(d) !== -1)) return "social";
  return `referral: ${host}`;
}

function deviceOf(ua) {
  const u = String(ua || "").toLowerCase();
  if (!u) return "";
  if (/ipad|tablet|playbook|silk/.test(u) || /android(?!.*mobile)/.test(u)) return "tablet";
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/.test(u)) return "mobile";
  return "desktop";
}

function attribution(req, d) {
  const h = req.headers || {};
  const hdr = (k) => clean(h[k], 300);
  const referer = hdr("referer");

  // UTM tags reach us either from the form (persisted client-side) or in the
  // query string of the page URL the browser sends as Referer. Accept either.
  const refUtms = {};
  let externalReferrer = "";
  try {
    const u = new URL(referer);
    if (u.hostname.replace(/^www\./i, "").toLowerCase() === "reilacquisitions.com") {
      u.searchParams.forEach((v, k) => { if (/^utm_/.test(k)) refUtms[k] = v; });
    } else {
      externalReferrer = referer;
    }
  } catch (e) {}

  const utm = {};
  ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach((k) => {
    utm[k] = clean(d[k], 160) || refUtms[k] || "";
  });

  const referrer = clean(d.referrer, 300) || externalReferrer;
  let city = hdr("x-vercel-ip-city");
  try { city = decodeURIComponent(city); } catch (e) {}

  return {
    channel: classifyChannel(referrer || referer, utm.utm_medium, utm.utm_source),
    referrer: referrer || (referer ? "(internal page)" : "(none - direct)"),
    landing: clean(d.landing, 300),
    page: clean(d.page, 200),
    utm_source: utm.utm_source,
    utm_medium: utm.utm_medium,
    utm_campaign: utm.utm_campaign,
    utm_term: utm.utm_term,
    utm_content: utm.utm_content,
    location: [city, hdr("x-vercel-ip-country-region"), hdr("x-vercel-ip-country")].filter(Boolean).join(", "),
    device: deviceOf(hdr("user-agent")),
    first_touch: clean(d.ts, 40),
  };
}

function attributionRows(a) {
  if (!a) return [];
  return [
    ["Channel", a.channel],
    ["Landed on", a.landing],
    ["Submitted from", a.page],
    ["Referrer", a.referrer],
    ["UTM source", a.utm_source],
    ["UTM medium", a.utm_medium],
    ["UTM campaign", a.utm_campaign],
    ["UTM term", a.utm_term],
    ["UTM content", a.utm_content],
    ["Location", a.location],
    ["Device", a.device],
    ["First seen", a.first_touch],
  ].filter((r) => r[1]);
}

/* ---------------- spam defences ----------------
   Layered friction, cheapest first. Order matters: the "not a browser" gates
   run before anything that costs a network call or an email.

     1. honeypot          - hidden field; real people never fill it in
     2. origin gate       - a real browser POST carries Origin/Referer/Sec-Fetch
     3. timing token      - humans take longer than MIN_FILL_MS to fill a form
     4. proof of work     - requires an actual JavaScript engine to run
     5. per-IP rate limit - caps bursts (per warm instance; a damper, not a ledger)
     6. email hygiene     - temporary inboxes and free throwaway TLDs
     7. content score     - URL-stuffed and pitch-shaped submissions
     8. Turnstile         - only active when TURNSTILE_SECRET is set in the env

   Bot-signature failures (2, 3, 4, 8) return a fake {ok:true} so automated
   senders get no signal to adapt against. Human-class failures (6, 7) return a
   real 400 with a message a person can act on, because a mistyped address must
   not silently vanish. Every rejection is logged as one JSON line so the
   pattern is visible in the logs instead of guessed at.

   The salt and the work factor are public by design: this is friction, not
   cryptography. Turnstile remains the real challenge when you want one, and
   switching it on needs no code change - just the env var.
   ------------------------------------------------------------------- */

const FORM_SALT = "reil-friction-2026-11";
const MIN_FILL_MS = 1500;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const POW_BITS = 16;
const POW_MASK = (1 << POW_BITS) - 1;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 8;

/* Same tiny digest on both sides. No dependency, runs in any JS engine. */
function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const timingToken = (t0) => fnv1a(`${t0}.${FORM_SALT}`).toString(36);

/* Disposable mail providers. Not exhaustive, and does not need to be: these
   catch the services a spray-and-pray script reaches for first. */
const DISPOSABLE = [
  "mailinator", "guerrillamail", "sharklasers", "grr.la", "tempmail", "temp-mail",
  "10minutemail", "yopmail", "trashmail", "maildrop", "getnada", "dispostable",
  "throwaway", "fakeinbox", "mailnesia", "spam4.me", "mailcatch", "discard.email",
  "emailondeck", "moakt", "mohmal", "tempinbox", "luxusmail", "inboxbear",
];
const FREE_TLDS = [".tk", ".ml", ".ga", ".cf", ".gq"];

/* Phrases that turn up in pitches and spam, never in a genuine inquiry. */
const PITCH_PHRASES = [
  "backlink", "guest post", "seo service", "rank higher", "increase your traffic",
  "digital marketing", "lead generation", "mass email", "buy followers",
  "crypto", "bitcoin", "casino", "forex", "payday loan", "viagra", "escort",
  "work from home", "make money online", "click here", "limited time offer",
  "dear sir/madam", "dear sir or madam",
];

const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(?:ru|cn|tk|ml|ga|cf|gq)\b)/i;

function emailVerdict(email) {
  const e = String(email || "").toLowerCase();
  const at = e.lastIndexOf("@");
  const domain = at === -1 ? "" : e.slice(at + 1);
  if (!domain) return "no domain";
  if (DISPOSABLE.some((d) => domain === d || domain.endsWith("." + d) || domain.includes(d))) {
    return `temporary mailbox (${domain})`;
  }
  const free = FREE_TLDS.find((t) => domain.endsWith(t));
  if (free) return `free TLD (${domain})`;
  if (!/\.[a-z]{2,}$/.test(domain)) return `malformed domain (${domain})`;
  return null;
}

function nameVerdict(name) {
  const n = String(name || "").trim();
  if (n.length < 2) return "too short";
  if (LINK_RE.test(n)) return "contains a link";
  if (/\d/.test(n)) return "contains digits";
  if (n.split(/\s+/).length > 5) return "more than 5 words";
  const letters = (n.match(/[A-Za-z]/g) || []).length;
  if (letters / n.length < 0.5) return "mostly non-letters";
  return null;
}

/* Score rather than hard-block, so a real seller who pastes their own website
   inside a normal sentence is not thrown out with the bots. */
function contentScore(d) {
  const hits = [];
  let score = 0;
  const msg = clean(d.message, 4000);
  const company = clean(d.company, 200);
  const links = (msg.match(/https?:\/\/|www\./gi) || []).length;

  if (links >= 3) { score += 3; hits.push(`${links} links in the message`); }
  else if (links === 1) { score += 1; hits.push("1 link in the message"); }
  if (LINK_RE.test(company)) { score += 2; hits.push("link in the company name"); }

  const hay = `${msg} ${company} ${clean(d.intent, 80)}`.toLowerCase();
  const found = PITCH_PHRASES.filter((p) => hay.includes(p));
  if (found.length) {
    score += Math.min(found.length * 2, 4);
    hits.push(`pitch language: ${found.slice(0, 3).join(", ")}`);
  }
  return { score, hits };
}

/* Per-IP burst cap. Vercel functions are ephemeral, so this only sees requests
   landing on the same warm instance - it damps a burst, it does not count. */
const HITS = new Map();

function rateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  const recent = (HITS.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  HITS.set(ip, recent);
  if (HITS.size > 2000) {
    for (const [k, v] of HITS) if (!v.some((t) => now - t < RATE_WINDOW_MS)) HITS.delete(k);
  }
  return recent.length > RATE_MAX;
}

function clientIp(req) {
  const h = req.headers || {};
  return clean(String(h["x-forwarded-for"] || "").split(",")[0], 60) || clean(h["x-real-ip"], 60);
}

/* Newlines are stripped so a hostile User-Agent cannot forge a log line. */
const logSafe = (s) => clean(s, 300).replace(/[\r\n]+/g, " ");

function logReject(req, rule, data, extra) {
  const h = req.headers || {};
  console.log("lead_rejected " + JSON.stringify({
    rule,
    at: new Date().toISOString(),
    ip: clientIp(req),
    country: clean(h["x-vercel-ip-country"], 8),
    ua: logSafe(h["user-agent"]),
    origin: logSafe(h.origin),
    referer: logSafe(h.referer),
    sec_fetch_site: logSafe(h["sec-fetch-site"]),
    name: logSafe(data && data.name),
    email: logSafe(data && data.email),
    company: logSafe(data && data.company),
    intent: logSafe(data && data.intent),
    message: logSafe(data && data.message),
    ...(extra || {}),
  }));
}

/* A real browser sends at least one of these on a POST. A script posting
   straight at the API usually sends none of them. */
function originVerdict(req) {
  const h = req.headers || {};
  const site = clean(h["sec-fetch-site"], 20).toLowerCase();
  const origin = clean(h.origin, 300);
  const referer = clean(h.referer, 300);
  const ours = (u) => {
    const host = hostOf(u);
    return host === "reilacquisitions.com"
      || (host.length > 19 && host.slice(-19) === ".reilacquisitions.com")
      || host === "reil-acquisitions-site.vercel.app";
  };
  if (site && site !== "same-origin" && site !== "same-site" && site !== "none") {
    return `cross-site fetch (${site})`;
  }
  if (origin) return ours(origin) ? null : `foreign origin (${origin})`;
  if (referer) return ours(referer) ? null : `foreign referer (${referer})`;
  if (site === "same-origin" || site === "same-site") return null;
  return "no origin, referer or sec-fetch-site";
}

/* `native` marks a no-JavaScript form post (urlencoded/multipart). Those get a
   pass on the token checks so a visitor without JS still reaches us; they are
   still subject to the origin gate, the honeypot and the rate limit. */
function timingVerdict(d, native) {
  const t0 = Number(clean(d._t, 20));
  if (!t0 || !Number.isFinite(t0)) return native ? null : "missing timestamp";
  if (clean(d._s, 40) !== timingToken(t0)) return "bad timing token";
  const now = Date.now();
  if (t0 > now + 60000) return "timestamp in the future";
  const age = now - t0;
  if (age < MIN_FILL_MS) return `submitted in ${age}ms`;
  return null; // stale but correctly signed: never reject a real person's clock
}

function powVerdict(d, native) {
  const p = clean(d._p, 60);
  if (!p) return native ? null : "missing proof of work";
  const m = /^([a-z0-9]{4,32})\.(\d{1,9})$/.exec(p);
  if (!m) return "malformed proof of work";
  const t0 = Number(clean(d._t, 20)) || 0;
  const h = fnv1a(`${m[1]}.${t0}.${FORM_SALT}.${Number(m[2])}`);
  return (h & POW_MASK) === 0 ? null : "insufficient proof of work";
}

async function turnstileVerdict(req, d) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return { skipped: true };
  const token = clean(d["cf-turnstile-response"] || d.turnstile, 2048);
  if (!token) return { failed: "no challenge token" };
  try {
    const form = new URLSearchParams({ secret, response: token });
    const ip = clientIp(req);
    if (ip) form.set("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const j = await r.json();
    if (j && j.success) return { ok: true };
    return { failed: ((j && j["error-codes"]) || []).join(",") || "challenge failed" };
  } catch (e) {
    // Fail open: never lose a real lead because Cloudflare was unreachable.
    return { ok: true, degraded: String(e).slice(0, 120) };
  }
}

/* ---------------- Resend ---------------- */
async function sendResend(d, attr) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { skipped: true };

  const to = (process.env.LEAD_TO || "hello@reilacquisitions.com")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const from = process.env.RESEND_FROM || "REIL Website <website@reilacquisitions.com>";
  const bcc = (process.env.LEAD_BCC || "").split(",").map((s) => s.trim()).filter(Boolean);
  const table = rows(d);
  const msg = clean(d.message, 4000);
  const source = clean(d.source, 120) || "Website contact form";

  const aRows = attributionRows(attr);
  const aText = aRows.length
    ? `\n\nHow they arrived:\n` + aRows.map((r) => `${r[0]}: ${r[1]}`).join("\n")
    : "";

  const text =
    `New inquiry from ${source}\n\n` +
    table.map((r) => `${r[0]}: ${r[1]}`).join("\n") +
    `\n\nMessage:\n${msg || "(none)"}` +
    aText;

  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px">` +
    `<h2 style="color:#0a1428;margin:0 0 8px;font-size:20px">New inquiry from ${esc(source)}</h2>` +
    `<p style="color:#888;font-size:13px;margin:0 0 20px">Submitted ${new Date().toUTCString()}</p>` +
    `<table cellpadding="8" cellspacing="0" style="font-size:14px;border-collapse:collapse;width:100%">` +
    table.map((r) => `<tr><td style="color:#666;border-bottom:1px solid #eee;width:130px"><b>${esc(r[0])}</b></td>` +
                     `<td style="border-bottom:1px solid #eee">${esc(r[1])}</td></tr>`).join("") +
    `</table>` +
    (msg ? `<p style="font-size:14px;color:#333;margin-top:22px"><b>Message</b><br>${esc(msg).replace(/\n/g, "<br>")}</p>` : "") +
    (aRows.length
      ? `<h3 style="color:#0a1428;font-size:15px;margin:28px 0 10px">How they arrived</h3>` +
        `<table cellpadding="8" cellspacing="0" style="font-size:13px;border-collapse:collapse;width:100%">` +
        aRows.map((r) => `<tr><td style="color:#888;border-bottom:1px solid #f2f2f2;width:130px">${esc(r[0])}</td>` +
                         `<td style="border-bottom:1px solid #f2f2f2;color:#555">${esc(r[1])}</td></tr>`).join("") +
        `</table>`
      : "") +
    `</div>`;

  const body = {
    from,
    to,
    subject: `Website inquiry - ${clean(d.name, 120)}${d.company ? " (" + clean(d.company, 120) + ")" : ""}` +
      (attr && attr.channel ? ` [${clean(attr.channel, 40)}]` : ""),
    text,
    html,
  };
  if (d.email) body.reply_to = clean(d.email, 200);
  if (bcc.length) body.bcc = bcc;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch (e) { parsed = { raw: raw.slice(0, 300) }; }
  if (!res.ok) throw new Error(`resend ${res.status}: ${parsed.message || raw.slice(0, 200)}`);
  return { ok: true, id: parsed.id };
}

/* ---------------- visitor confirmation ----------------
   Sent AFTER the lead has gone out. Any failure here is swallowed: the lead
   is the priority and must never be lost to a broken receipt.               */

const CONFIRM_TIMEOUT_MS = 6000;
const CHECKLIST_PDF = "https://reilacquisitions.com/assets/REIL-Acquisition-Checklist.pdf";

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

function confirmationContent(d) {
  const isChecklist = /checklist/i.test(clean(d.source, 120));
  const first = (clean(d.name, 80).split(/\s+/)[0] || "there");
  const gold = "#c9a961";

  const subject = isChecklist
    ? "Your Acquisition Checklist"
    : "We received your message - REIL Acquisitions";

  const intro = isChecklist
    ? "Here is your free Acquisition Checklist. It is yours to keep."
    : "We have received your message and someone from the team will reply within one business day.";

  const closing = isChecklist
    ? "If you would like to talk through your situation, simply reply to this email."
    : "If anything is urgent, reply to this email and it comes straight to us.";

  const button = isChecklist
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0"><tr>
         <td style="border-radius:10px;background:#0d7377">
           <a href="${CHECKLIST_PDF}" style="display:inline-block;padding:15px 30px;font-size:14px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;color:#ffffff;text-decoration:none;border-radius:10px">Download the Checklist</a>
         </td></tr></table>
       <p style="margin:0 0 18px;font-size:13px;color:#777;line-height:1.6">Or copy this link:<br>
         <span style="color:#0d7377">${CHECKLIST_PDF}</span></p>`
    : "";

  const html =
    `<div style="background:#f6f5f2;padding:30px 14px">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ` +
    `style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 6px 26px rgba(10,20,40,.07)">` +
    `<tr><td style="background:#0a1428;padding:24px 32px">` +
    `<span style="display:inline-block;width:34px;height:34px;line-height:34px;text-align:center;border-radius:9px;` +
    `background:${gold};color:#ffffff;font-weight:900;font-size:18px;vertical-align:middle">&nbsp;R&nbsp;</span>` +
    `<span style="color:#ffffff;font-weight:900;font-size:16px;letter-spacing:.06em;vertical-align:middle;` +
    `padding-left:12px">REIL ACQUISITIONS</span>` +
    `</td></tr>` +
    `<tr><td style="padding:34px 32px 6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">` +
    `<h1 style="margin:0 0 16px;font-size:21px;line-height:1.3;color:#0a1428">Thanks, ${esc(first)}.</h1>` +
    `<p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#333">${intro}</p>` +
    button +
    `<p style="margin:0 0 26px;font-size:15px;line-height:1.7;color:#333">${closing}</p>` +
    `<p style="margin:0;font-size:15px;line-height:1.7;color:#333">REIL Acquisitions<br>` +
    `<span style="color:#888;font-size:13.5px">Wisconsin &middot; Illinois &middot; Iowa &middot; Michigan &middot; Minnesota</span></p>` +
    `</td></tr>` +
    `<tr><td style="padding:22px 32px 28px;border-top:1px solid #eee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">` +
    `<p style="margin:0;font-size:12.5px;line-height:1.7;color:#999">` +
    `You are receiving this because you submitted a form on reilacquisitions.com. ` +
    `Reply to this email to reach us - your details stay private.</p>` +
    `</td></tr></table></div>`;

  const text = [
    `Thanks, ${first}.`,
    "",
    intro,
    isChecklist ? `\nDownload the checklist: ${CHECKLIST_PDF}\n` : "",
    closing,
    "",
    "REIL Acquisitions",
    "Wisconsin - Illinois - Iowa - Michigan - Minnesota",
    "hello@reilacquisitions.com",
    "",
    "You are receiving this because you submitted a form on reilacquisitions.com.",
  ].join("\n");

  return { subject, html, text, isChecklist };
}

async function sendConfirmation(d) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { skipped: true };

  const to = clean(d.email, 200);
  if (!to) return { skipped: true };

  const from = process.env.RESEND_FROM || "REIL Website <website@reilacquisitions.com>";
  const replyTo = (process.env.LEAD_TO || "hello@reilacquisitions.com").split(",")[0].trim();
  const c = confirmationContent(d);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: replyTo,
      subject: c.subject,
      html: c.html,
      text: c.text,
    }),
  });
  const raw = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch (e) { parsed = {}; }
  if (!res.ok) throw new Error(`confirmation resend ${res.status}: ${parsed.message || raw.slice(0, 150)}`);
  return { ok: true, id: parsed.id };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const ctype = String(req.headers["content-type"] || "");
  const native = ctype.includes("application/x-www-form-urlencoded") || ctype.includes("multipart/form-data");
  const finish = (code, payload) => {
    if (native && code === 200) {
      res.writeHead(303, { Location: "/thank-you.html" });
      res.end();
      return;
    }
    res.status(code).json(payload);
  };

  const data = parseBody(req);

  // dry run - verify configuration without sending anything (used by the watchdog)
  if (String(data.dry_run) === "true" || data.dry_run === true) {
    const configured = !!process.env.RESEND_API_KEY;
    const out = {
      ok: configured,
      mode: "dry_run",
      email: { configured, provider: "resend", from: process.env.RESEND_FROM || "REIL Website <website@reilacquisitions.com>", to: process.env.LEAD_TO || "hello@reilacquisitions.com" },
    };
    res.status(configured ? 200 : 503).json(out);
    return;
  }

  // Honeypot: real people never fill this in. Pretend success, send nothing.
  if (data._honey) {
    logReject(req, "honeypot", data);
    finish(200, { ok: true, note: "ignored" });
    return;
  }

  // ---- gates a browser passes and a script usually does not ---------------
  const originProblem = originVerdict(req);
  if (originProblem) {
    logReject(req, "origin", data, { detail: originProblem });
    finish(200, { ok: true, note: "ignored" });
    return;
  }

  const timingProblem = timingVerdict(data, native);
  if (timingProblem) {
    logReject(req, "timing", data, { detail: timingProblem });
    finish(200, { ok: true, note: "ignored" });
    return;
  }

  const powProblem = powVerdict(data, native);
  if (powProblem) {
    logReject(req, "proof_of_work", data, { detail: powProblem });
    finish(200, { ok: true, note: "ignored" });
    return;
  }

  if (rateLimited(clientIp(req))) {
    logReject(req, "rate_limit", data);
    res.status(429).json({
      ok: false,
      error: "Too many submissions from this connection. Please email hello@reilacquisitions.com.",
    });
    return;
  }

  for (const f of REQUIRED) {
    if (!clean(data[f])) {
      finish(400, { ok: false, error: `Missing field: ${f}` });
      return;
    }
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean(data.email, 200))) {
    finish(400, { ok: false, error: "Invalid email address" });
    return;
  }

  // ---- things a real person should be told about ---------------------------
  const emailProblem = emailVerdict(clean(data.email, 200));
  if (emailProblem) {
    logReject(req, "email", data, { detail: emailProblem });
    finish(400, {
      ok: false,
      error: "Please use an email address we can actually reply to - temporary and throwaway inboxes are blocked.",
    });
    return;
  }

  const nameProblem = nameVerdict(clean(data.name, 200));
  if (nameProblem) {
    logReject(req, "name", data, { detail: nameProblem });
    finish(400, { ok: false, error: "Please enter your real name." });
    return;
  }

  const content = contentScore(data);
  if (content.score >= 4) {
    logReject(req, "content", data, { detail: content.hits.join("; "), score: content.score });
    finish(400, {
      ok: false,
      error: "That message looked automated. If it was not, email hello@reilacquisitions.com and we will pick it up.",
    });
    return;
  }

  const challenge = await turnstileVerdict(req, data);
  if (challenge.failed) {
    logReject(req, "turnstile", data, { detail: challenge.failed });
    finish(200, { ok: true, note: "ignored" });
    return;
  }
  if (challenge.degraded) console.log("turnstile_degraded " + logSafe(challenge.degraded));

  if (!process.env.RESEND_API_KEY) {
    finish(503, {
      ok: false,
      error: "Email delivery is not configured",
      detail: "Set RESEND_API_KEY (and RESEND_FROM) in the Vercel project.",
    });
    return;
  }

  const attr = attribution(req, data);

  let lead;
  try {
    lead = await sendResend(data, attr);
  } catch (e) {
    finish(502, { ok: false, delivered: [], failed: [{ channel: "email", error: String(e).slice(0, 220) }] });
    return;
  }

  // The lead is safely delivered. Now try to send the visitor their receipt.
  // A failure here must never change the response - the lead is what matters.
  let confirmation = { sent: false };
  try {
    const visitor = clean(data.email, 200).toLowerCase();
    const leadRecipients = ((process.env.LEAD_TO || "hello@reilacquisitions.com") + "," + (process.env.LEAD_BCC || ""))
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

    if (!visitor) {
      confirmation = { sent: false, reason: "no visitor address" };
    } else if (leadRecipients.indexOf(visitor) !== -1) {
      // Already received the lead in this same request - don't double-send.
      confirmation = { sent: false, reason: "visitor address is a lead recipient" };
    } else {
      const c = await withTimeout(sendConfirmation(data), CONFIRM_TIMEOUT_MS, "confirmation");
      confirmation = c && c.skipped ? { sent: false, reason: "not configured" } : { sent: true, id: c.id };
    }
  } catch (e) {
    confirmation = { sent: false, error: String(e).slice(0, 160) };
  }

  finish(200, { ok: true, delivered: ["email"], provider: "resend", id: lead.id, confirmation, attribution: attr });
};
