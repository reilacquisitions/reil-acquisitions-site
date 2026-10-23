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
    finish(200, { ok: true, note: "ignored" });
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
