/**
 * POST /api/lead — first-party lead capture for reilacquisitions.com
 *
 * Delivery is server-side. The browser never opens a mail client and never hands
 * off to a third-party form service it can't verify.
 *
 * Channels (any that are configured are attempted; a lead succeeds if at least one works):
 *   1. Telegram  — instant push to the team   (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
 *   2. Mailgun   — email to hello@            (MAILGUN_API_KEY, plus MAILGUN_DOMAIN / LEAD_TO)
 *
 * Env vars (set in Vercel):
 *   TELEGRAM_BOT_TOKEN  - bot token that can post to the chat below
 *   TELEGRAM_CHAT_ID    - destination chat id
 *   MAILGUN_API_KEY     - optional; enables email delivery as well
 *   MAILGUN_DOMAIN      - optional, defaults to reilacquisitions.com
 *   LEAD_TO             - optional, defaults to hello@reilacquisitions.com
 *   LEAD_FROM           - optional, defaults to "REIL Website <website@<domain>>"
 *
 * Responses:
 *   200 {ok:true,  delivered:[...]}          at least one channel succeeded
 *   400 {ok:false, error:"..."}              validation failure
 *   502 {ok:false, delivered:[], failed:[...]} every configured channel failed
 *   503 {ok:false, error:"..."}              no channel configured at all
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

function summarise(d) {
  return [
    ["Name", clean(d.name, 200)],
    ["Email", clean(d.email, 200)],
    ["Company", clean(d.company, 200)],
    ["Phone", clean(d.phone, 60)],
    ["Looking to", clean(d.intent, 80)],
    ["Source", clean(d.source, 120) || "Website contact form"],
  ].filter((r) => r[1]);
}

/* ---------------- channel: Telegram ---------------- */
async function sendTelegram(d) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { channel: "telegram", skipped: true };

  const rows = summarise(d).map((r) => `<b>${esc(r[0])}</b>: ${esc(r[1])}`).join("\n");
  const msg = clean(d.message, 3000);
  const text =
    "\u{1F4E5} <b>New website inquiry</b>\n\n" +
    rows +
    (msg ? `\n\n<b>Message</b>\n${esc(msg)}` : "");

  // NB: Telegram rejects mailto: in inline-keyboard buttons (BUTTON_URL_INVALID),
  // so the address is left in the message text for the team to tap or copy.
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`telegram ${res.status}: ${body.slice(0, 180)}`);
  return { channel: "telegram", ok: true };
}

/* ---------------- channel: Mailgun ---------------- */
async function sendMailgun(d) {
  const key = process.env.MAILGUN_API_KEY;
  if (!key) return { channel: "mailgun", skipped: true };

  const domain = process.env.MAILGUN_DOMAIN || "reilacquisitions.com";
  const to = process.env.LEAD_TO || "hello@reilacquisitions.com";
  const from = process.env.LEAD_FROM || `REIL Website <website@${domain}>`;
  const rows = summarise(d);
  const msg = clean(d.message, 4000);

  const text = rows.map((r) => `${r[0]}: ${r[1]}`).join("\n") + "\n\nMessage:\n" + (msg || "(none)");
  const html =
    `<h2 style="font-family:sans-serif">New inquiry from ${esc(clean(d.source, 120) || "Website contact form")}</h2>` +
    `<table cellpadding="6" style="font-family:sans-serif;font-size:14px;border-collapse:collapse">` +
    rows.map((r) => `<tr><td style="color:#666"><b>${esc(r[0])}</b></td><td>${esc(r[1])}</td></tr>`).join("") +
    `</table><p style="font-family:sans-serif;font-size:14px"><b>Message</b><br>${esc(msg || "(none)").replace(/\n/g, "<br>")}</p>`;

  const form = new URLSearchParams();
  form.set("from", from);
  form.set("to", to);
  form.set("subject", `New REIL inquiry - ${clean(d.name, 120)}${d.company ? " (" + clean(d.company, 120) + ")" : ""}`);
  form.set("text", text);
  form.set("html", html);
  if (d.email) form.set("h:Reply-To", clean(d.email, 200));

  const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`api:${key}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`mailgun ${res.status}: ${body.slice(0, 180)}`);
  return { channel: "mailgun", ok: true };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const ctype = String(req.headers["content-type"] || "");
  // A native form POST (no JS) should land on a real page, not raw JSON.
  const native = ctype.includes("application/x-www-form-urlencoded") || ctype.includes("multipart/form-data");
  const finish = (code, body) => {
    if (native && code === 200) {
      res.writeHead(303, { Location: "/thank-you.html" });
      res.end();
      return;
    }
    res.status(code).json(body);
  };

  const data = parseBody(req);

  // ---- dry run: verify every channel is wired WITHOUT delivering anything.
  // Used by the uptime watchdog so health checks never spam the team.
  if (String(data.dry_run) === "true" || data.dry_run === true) {
    const out = { ok: true, mode: "dry_run", channels: {} };
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`);
        const j = await r.json();
        out.channels.telegram = { configured: true, reachable: !!(r.ok && j.ok), bot: j.result && j.result.username };
      } catch (e) {
        out.channels.telegram = { configured: true, reachable: false, error: String(e).slice(0, 120) };
      }
    } else {
      out.channels.telegram = { configured: false };
    }
    out.channels.mailgun = { configured: !!process.env.MAILGUN_API_KEY, domain: process.env.MAILGUN_DOMAIN || null };
    out.channels.lead_to = process.env.LEAD_TO || "hello@reilacquisitions.com";
    out.ok = Object.values(out.channels).some((c) => c && c.configured && c.reachable !== false);
    res.status(out.ok ? 200 : 503).json(out);
    return;
  }

  // Honeypot: real people never fill this in. Pretend success, send nothing.
  if (data._honey) {
    finish(200, { ok: true, delivered: [], note: "ignored" });
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

  const channels = [sendTelegram, sendMailgun];
  const configured = channels.filter((fn) =>
    fn === sendTelegram
      ? process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
      : process.env.MAILGUN_API_KEY
  );

  if (!configured.length) {
    finish(503, {
      ok: false,
      error: "No lead delivery channel configured",
      detail: "Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, or MAILGUN_API_KEY, in the Vercel project.",
    });
    return;
  }

  const delivered = [];
  const failed = [];
  await Promise.all(
    configured.map(async (fn) => {
      try {
        const r = await fn(data);
        if (r && r.ok) delivered.push(r.channel);
      } catch (e) {
        failed.push({ channel: fn.name, error: String(e).slice(0, 200) });
      }
    })
  );

  if (delivered.length) {
    finish(200, { ok: true, delivered, failed });
    return;
  }
  finish(502, { ok: false, delivered: [], failed });
};
