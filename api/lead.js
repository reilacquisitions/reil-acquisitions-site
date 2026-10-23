/**
 * POST /api/lead  — first-party lead capture for reilacquisitions.com
 *
 * Sends website inquiries through Mailgun (the domain's existing mail provider),
 * so leads never depend on a third-party form service.
 *
 * Required Vercel environment variables:
 *   MAILGUN_API_KEY   - Mailgun private API key   (required)
 *   MAILGUN_DOMAIN    - defaults to reilacquisitions.com
 *   LEAD_TO           - defaults to hello@reilacquisitions.com
 *   LEAD_FROM         - defaults to "REIL Website <website@reilacquisitions.com>"
 *
 * If MAILGUN_API_KEY is not set the endpoint returns 503 and the browser
 * automatically falls back to the next delivery path (see the page's inline JS),
 * so an inquiry is never silently dropped.
 *
 * Zero npm dependencies - uses the global fetch available on Node 18+.
 */

const REQUIRED = ["name", "email"];

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") {
    try { return JSON.parse(b); } catch (e) {
      const out = {};
      new URLSearchParams(b).forEach((v, k) => { out[k] = v; });
      return out;
    }
  }
  return b || {};
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const data = parseBody(req);

  // Honeypot: real people never fill this in.
  if (data._honey) {
    res.status(200).json({ ok: true, note: "ignored" });
    return;
  }

  for (const f of REQUIRED) {
    if (!String(data[f] || "").trim()) {
      res.status(400).json({ ok: false, error: `Missing field: ${f}` });
      return;
    }
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(data.email))) {
    res.status(400).json({ ok: false, error: "Invalid email address" });
    return;
  }

  const key = process.env.MAILGUN_API_KEY;
  if (!key) {
    res.status(503).json({ ok: false, error: "Lead backend not configured (MAILGUN_API_KEY missing)" });
    return;
  }

  const domain = process.env.MAILGUN_DOMAIN || "reilacquisitions.com";
  const to = process.env.LEAD_TO || "hello@reilacquisitions.com";
  const from = process.env.LEAD_FROM || `REIL Website <website@${domain}>`;
  const source = String(data.source || "Website contact form");

  const rows = [
    ["Name", data.name],
    ["Email", data.email],
    ["Company", data.company],
    ["Phone", data.phone],
    ["Looking to", data.intent],
    ["Source", source],
  ].filter((r) => String(r[1] || "").trim());

  const text = rows.map((r) => `${r[0]}: ${r[1]}`).join("\n") + "\n\nMessage:\n" + (data.message || "(none)");
  const html =
    `<h2 style="font-family:sans-serif">New inquiry from ${esc(source)}</h2>` +
    `<table cellpadding="6" style="font-family:sans-serif;font-size:14px;border-collapse:collapse">` +
    rows.map((r) => `<tr><td style="color:#666"><b>${esc(r[0])}</b></td><td>${esc(r[1])}</td></tr>`).join("") +
    `</table><p style="font-family:sans-serif;font-size:14px"><b>Message</b><br>${esc(data.message || "(none)").replace(/\n/g, "<br>")}</p>`;

  const form = new URLSearchParams();
  form.set("from", from);
  form.set("to", to);
  form.set("subject", `New REIL inquiry - ${data.name}${data.company ? " (" + data.company + ")" : ""}`);
  form.set("text", text);
  form.set("html", html);
  if (data.email) form.set("h:Reply-To", String(data.email));

  try {
    const r = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`api:${key}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    const body = await r.text();
    if (!r.ok) {
      res.status(502).json({ ok: false, error: `Mailgun ${r.status}`, detail: body.slice(0, 300) });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(502).json({ ok: false, error: "Upstream send failed", detail: String(e).slice(0, 200) });
  }
};
