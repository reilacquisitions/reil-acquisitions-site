/**
 * POST /api/lead — lead capture for reilacquisitions.com
 *
 * Leads are EMAILED. Delivery happens server-side; the browser never opens a
 * mail client, never hands off to a third-party form service, and no chat
 * platform is involved.
 *
 * Env vars (set in Vercel):
 *   RESEND_API_KEY  - Resend API key (required)
 *   RESEND_FROM     - verified From header. Until reilacquisitions.com is
 *                     verified in Resend this must stay onboarding@resend.dev,
 *                     because an unverified account may only send to its own
 *                     address. Swap to website@reilacquisitions.com after
 *                     verifying the domain.
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

/* ---------------- Resend ---------------- */
async function sendResend(d) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { skipped: true };

  const to = (process.env.LEAD_TO || "hello@reilacquisitions.com")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const from = process.env.RESEND_FROM || "REIL Website <onboarding@resend.dev>";
  const bcc = (process.env.LEAD_BCC || "").split(",").map((s) => s.trim()).filter(Boolean);
  const table = rows(d);
  const msg = clean(d.message, 4000);
  const source = clean(d.source, 120) || "Website contact form";

  const text =
    `New inquiry from ${source}\n\n` +
    table.map((r) => `${r[0]}: ${r[1]}`).join("\n") +
    `\n\nMessage:\n${msg || "(none)"}`;

  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px">` +
    `<h2 style="color:#0a1428;margin:0 0 8px;font-size:20px">New inquiry from ${esc(source)}</h2>` +
    `<p style="color:#888;font-size:13px;margin:0 0 20px">Submitted ${new Date().toUTCString()}</p>` +
    `<table cellpadding="8" cellspacing="0" style="font-size:14px;border-collapse:collapse;width:100%">` +
    table.map((r) => `<tr><td style="color:#666;border-bottom:1px solid #eee;width:130px"><b>${esc(r[0])}</b></td>` +
                     `<td style="border-bottom:1px solid #eee">${esc(r[1])}</td></tr>`).join("") +
    `</table>` +
    (msg ? `<p style="font-size:14px;color:#333;margin-top:22px"><b>Message</b><br>${esc(msg).replace(/\n/g, "<br>")}</p>` : "") +
    `</div>`;

  const body = {
    from,
    to,
    subject: `Website inquiry - ${clean(d.name, 120)}${d.company ? " (" + clean(d.company, 120) + ")" : ""}`,
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
      email: { configured, provider: "resend", from: process.env.RESEND_FROM || "REIL Website <onboarding@resend.dev>", to: process.env.LEAD_TO || "hello@reilacquisitions.com" },
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

  try {
    const r = await sendResend(data);
    finish(200, { ok: true, delivered: ["email"], provider: "resend", id: r.id });
  } catch (e) {
    finish(502, { ok: false, delivered: [], failed: [{ channel: "email", error: String(e).slice(0, 220) }] });
  }
};
