#!/usr/bin/env node
/**
 * Offline tests for the /api/lead spam defences.
 *
 * Loads the real handler, replaces global fetch with a recorder, and drives one
 * request per rule. Nothing leaves the machine: every Resend call is intercepted,
 * so this can be run as often as you like without emailing anybody.
 *
 *   node tools/lead-defence-test.js
 *
 * Exit code 0 = all rules behaved. 1 = at least one regression.
 */
"use strict";

const path = require("path");

const SALT = "reil-friction-2026-11";
const BITS = 16;
const MASK = (1 << BITS) - 1;

function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const NONCE = "testnonce1";

function solveProof(t0) {
  const base = `${NONCE}.${t0}.${SALT}.`;
  for (let c = 0; c < 5e6; c++) if ((fnv1a(base + c) & MASK) === 0) return `${NONCE}.${c}`;
  throw new Error("no proof solution found");
}

function failingProof(t0) {
  const base = `${NONCE}.${t0}.${SALT}.`;
  for (let c = 0; c < 1000; c++) if ((fnv1a(base + c) & MASK) !== 0) return `${NONCE}.${c}`;
  throw new Error("no failing counter found");
}

/* ---- environment the handler expects ---- */
process.env.RESEND_API_KEY = "test-key";
process.env.RESEND_FROM = "REIL Website <website@reilacquisitions.com>";
process.env.LEAD_TO = "hello@reilacquisitions.com";
delete process.env.TURNSTILE_SECRET;

const handler = require(path.join(__dirname, "..", "api", "lead.js"));

/* Capture the handler's own rejection logging so the report stays readable and
   we can still assert that every rule logs. */
const logLines = [];
const realLog = console.log;
console.log = (...args) => logLines.push(args.join(" "));
const loggedRules = () => {
  const rules = {};
  for (const line of logLines) {
    const m = /^lead_rejected (\{.*\})$/.exec(line);
    if (m) {
      try { const o = JSON.parse(m[1]); rules[o.rule] = (rules[o.rule] || 0) + 1; } catch (e) {}
    }
  }
  return rules;
};

/* ---- fetch recorder ---- */
let calls = [];
let turnstileSuccess = true;

global.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  if (u.includes("api.resend.com")) {
    return { ok: true, status: 200, json: async () => ({ id: "test-id" }), text: async () => JSON.stringify({ id: "test-id" }) };
  }
  if (u.includes("challenges.cloudflare.com")) {
    return { ok: true, status: 200, json: async () => ({ success: turnstileSuccess }), text: async () => "" };
  }
  throw new Error("unexpected fetch: " + u);
};

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    location: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    writeHead(c, h) { this.statusCode = c; this.location = h && h.Location; },
    end() {},
  };
}

function makeReq(body, headers, opts) {
  const base = { "content-type": "application/json", "x-forwarded-for": "203.0.113.1" };
  return {
    method: (opts && opts.method) || "POST",
    headers: Object.assign(base, headers || {}),
    body,
  };
}

const ORIGIN = { origin: "https://reilacquisitions.com" };

function goodPayload(over) {
  const t0 = Date.now() - 5000;
  return Object.assign({
    name: "Dana Whitfield",
    email: "dana@whitfieldmfg.com",
    company: "Whitfield Manufacturing",
    intent: "Sell my business",
    message: "We are exploring an exit in the next 18 months.",
    _t: String(t0),
    _s: fnv1a(`${t0}.${SALT}`).toString(36),
    _p: solveProof(t0),
  }, over || {});
}

async function call(body, headers, opts) {
  const res = makeRes();
  await handler(makeReq(body, headers, opts), res);
  return res;
}

const results = [];
function check(name, ok, evidence) {
  results.push({ name, ok, evidence });
}

async function run() {
  // 1. honeypot
  calls = [];
  let r = await call(goodPayload({ _honey: "bot" }), ORIGIN);
  check("honeypot -> fake success, nothing sent", r.statusCode === 200 && r.body && r.body.note === "ignored" && calls.length === 0,
    `status=${r.statusCode} body=${JSON.stringify(r.body)} fetch=${calls.length}`);

  // 2. no browser markers at all
  calls = [];
  r = await call(goodPayload(), { "x-forwarded-for": "203.0.113.2" });
  check("script with no Origin/Referer/Sec-Fetch -> rejected silently",
    r.statusCode === 200 && r.body && r.body.note === "ignored" && calls.length === 0,
    `status=${r.statusCode} body=${JSON.stringify(r.body)} fetch=${calls.length}`);

  // 3. foreign origin
  calls = [];
  r = await call(goodPayload(), { origin: "https://spam.example", "x-forwarded-for": "203.0.113.3" });
  check("foreign Origin -> rejected silently", r.body && r.body.note === "ignored" && calls.length === 0,
    `body=${JSON.stringify(r.body)} fetch=${calls.length}`);

  // 4. missing timestamp
  const noTs = goodPayload(); delete noTs._t; delete noTs._s; delete noTs._p;
  calls = [];
  r = await call(noTs, ORIGIN);
  check("valid origin but no timing token -> rejected", r.body && r.body.note === "ignored" && calls.length === 0,
    `body=${JSON.stringify(r.body)} fetch=${calls.length}`);

  // 5. submitted too fast
  const fast = goodPayload();
  const now = Date.now();
  fast._t = String(now);
  fast._s = fnv1a(`${now}.${SALT}`).toString(36);
  fast._p = solveProof(now);
  calls = [];
  r = await call(fast, ORIGIN);
  check("submitted in under 1.5s -> rejected as a bot", r.body && r.body.note === "ignored" && calls.length === 0,
    `body=${JSON.stringify(r.body)} fetch=${calls.length}`);

  // 6. forged timing token
  const forged = goodPayload();
  forged._s = "deadbeef";
  calls = [];
  r = await call(forged, ORIGIN);
  check("forged timing token -> rejected", r.body && r.body.note === "ignored" && calls.length === 0,
    `body=${JSON.stringify(r.body)} fetch=${calls.length}`);

  // 7. missing proof of work
  const noPow = goodPayload(); delete noPow._p;
  calls = [];
  r = await call(noPow, ORIGIN);
  check("timing ok but no proof of work -> rejected", r.body && r.body.note === "ignored" && calls.length === 0,
    `body=${JSON.stringify(r.body)} fetch=${calls.length}`);

  // 8. insufficient work
  const weak = goodPayload();
  const t8 = Number(weak._t);
  weak._p = failingProof(t8);
  calls = [];
  r = await call(weak, ORIGIN);
  check("insufficient proof of work -> rejected", r.body && r.body.note === "ignored" && calls.length === 0,
    `body=${JSON.stringify(r.body)} fetch=${calls.length}`);

  // 9. disposable mailbox
  calls = [];
  r = await call(goodPayload({ email: "spam@mailinator.com" }), ORIGIN);
  check("disposable mailbox -> 400 with an actionable message",
    r.statusCode === 400 && /temporary and throwaway/.test(r.body.error) && calls.length === 0,
    `status=${r.statusCode} body=${JSON.stringify(r.body)} fetch=${calls.length}`);

  // 10. free TLD
  calls = [];
  r = await call(goodPayload({ email: "a@reilspam.tk" }), ORIGIN);
  check("free throwaway TLD -> 400", r.statusCode === 400 && calls.length === 0,
    `status=${r.statusCode} body=${JSON.stringify(r.body)} fetch=${calls.length}`);

  // 11. name that is not a name
  calls = [];
  r = await call(goodPayload({ name: "http://x.ru cheap backlinks" }), ORIGIN);
  check("URL-shaped name -> 400", r.statusCode === 400 && calls.length === 0,
    `status=${r.statusCode} body=${JSON.stringify(r.body)} fetch=${calls.length}`);

  // 12. pitch-shaped content
  calls = [];
  r = await call(goodPayload({
    message: "Hello, we provide SEO services and backlinks to rank higher. See https://a.example https://b.example https://c.example",
  }), ORIGIN);
  check("pitch language + link stuffing -> 400", r.statusCode === 400 && calls.length === 0,
    `status=${r.statusCode} body=${JSON.stringify(r.body)} fetch=${calls.length}`);

  // 13. the happy path: exactly one lead + one visitor receipt
  calls = [];
  r = await call(goodPayload(), ORIGIN);
  check("genuine inquiry -> 200, lead sent and receipt sent",
    r.statusCode === 200 && r.body && r.body.ok === true && r.body.delivered && r.body.delivered[0] === "email"
      && r.body.confirmation && r.body.confirmation.sent === true && calls.length === 2,
    `status=${r.statusCode} body=${JSON.stringify(r.body).slice(0, 200)} fetch=${calls.length}`);

  // 14. a real seller pasting their own site must NOT be thrown out
  calls = [];
  r = await call(goodPayload({
    message: "Our company site is https://whitfieldmfg.com and revenue is about $6M.",
  }), ORIGIN);
  check("one legitimate link in a real message -> still accepted",
    r.statusCode === 200 && r.body && r.body.ok === true && calls.length === 2,
    `status=${r.statusCode} body=${JSON.stringify(r.body).slice(0, 160)} fetch=${calls.length}`);

  // 15. rate limit, same IP, payloads that are rejected before sending
  const ip = "198.51.100.77";
  const codes = [];
  for (let i = 0; i < 10; i++) {
    calls = [];
    const rr = await call(goodPayload({ email: "spam@mailinator.com" }), Object.assign({ "x-forwarded-for": ip }, ORIGIN));
    codes.push(rr.statusCode);
    if (calls.length) throw new Error("rate limit test sent an email");
  }
  check("burst from one IP -> throttled with 429 after the cap",
    codes.slice(0, 8).every((c) => c === 400) && codes.slice(8).every((c) => c === 429),
    `codes=${codes.join(",")}`);

  // 16. no-JS native post still reaches us (gates pass, tokens absent)
  calls = [];
  r = await call(
    "name=Pat%20Nguyen&email=pat%40nguyenlaw.com&intent=Sell%20my%20business",
    { "content-type": "application/x-www-form-urlencoded", origin: "https://reilacquisitions.com", "x-forwarded-for": "198.51.100.90" }
  );
  check("no-JavaScript form post -> accepted and redirected to thank-you",
    r.statusCode === 303 && r.location === "/thank-you.html" && calls.length === 2,
    `status=${r.statusCode} location=${r.location} fetch=${calls.length}`);

  // 17. missing required field
  calls = [];
  r = await call(goodPayload({ name: "  " }), ORIGIN);
  check("missing name -> 400", r.statusCode === 400 && /Missing field/.test(r.body.error),
    `status=${r.statusCode} body=${JSON.stringify(r.body)}`);

  // 18. wrong method
  calls = [];
  r = await call(null, {}, { method: "GET" });
  check("GET -> 405", r.statusCode === 405, `status=${r.statusCode}`);

  // 19. dry run still works for the watchdog
  calls = [];
  r = await call({ dry_run: true }, {});
  check("dry_run -> 200 configured (watchdog path)", r.statusCode === 200 && r.body && r.body.mode === "dry_run",
    `status=${r.statusCode} body=${JSON.stringify(r.body).slice(0, 160)}`);

  // 20. Turnstile: off when unset, enforcing when set
  // Each scenario gets its own IP so one rule cannot throttle the next test.
  process.env.TURNSTILE_SECRET = "test-secret";
  calls = [];
  r = await call(goodPayload(), Object.assign({ "x-forwarded-for": "203.0.113.20" }, ORIGIN));
  check("Turnstile on, no token -> rejected", r.body && r.body.note === "ignored" && calls.length === 0,
    `body=${JSON.stringify(r.body)} fetch=${calls.length}`);

  turnstileSuccess = false;
  calls = [];
  r = await call(goodPayload({ "cf-turnstile-response": "bad-token" }), Object.assign({ "x-forwarded-for": "203.0.113.21" }, ORIGIN));
  check("Turnstile on, challenge failed -> rejected", r.body && r.body.note === "ignored" && calls.length === 1,
    `body=${JSON.stringify(r.body)} fetch=${calls.length}`);

  turnstileSuccess = true;
  calls = [];
  r = await call(goodPayload({ "cf-turnstile-response": "good-token" }), Object.assign({ "x-forwarded-for": "203.0.113.22" }, ORIGIN));
  check("Turnstile on, challenge passed -> accepted", r.statusCode === 200 && r.body.ok === true && calls.length === 3,
    `status=${r.statusCode} body=${JSON.stringify(r.body).slice(0, 160)} fetch=${calls.length}`);

  // 21. Turnstile unreachable must fail OPEN, not eat a real lead
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("challenges.cloudflare.com")) throw new Error("ETIMEDOUT");
    return { ok: true, status: 200, json: async () => ({ id: "test-id" }), text: async () => JSON.stringify({ id: "test-id" }) };
  };
  calls = [];
  r = await call(goodPayload({ "cf-turnstile-response": "good-token" }), Object.assign({ "x-forwarded-for": "203.0.113.23" }, ORIGIN));
  check("Turnstile unreachable -> fails open, lead still delivered",
    r.statusCode === 200 && r.body.ok === true && calls.length === 3,
    `status=${r.statusCode} body=${JSON.stringify(r.body).slice(0, 160)} fetch=${calls.length}`);
  delete process.env.TURNSTILE_SECRET;

  // 22. the rate limit is per IP, not global
  calls = [];
  r = await call(goodPayload(), Object.assign({ "x-forwarded-for": "203.0.113.99" }, ORIGIN));
  check("a fresh IP is not affected by another IP's burst", r.statusCode === 200 && r.body.ok === true,
    `status=${r.statusCode} body=${JSON.stringify(r.body).slice(0, 120)}`);

  // 23. every rejection was logged
  const rules = loggedRules();
  const expected = ["honeypot", "origin", "timing", "proof_of_work", "email", "name", "content", "rate_limit", "turnstile"];
  const missing = expected.filter((x) => !rules[x]);
  check("every rule writes a lead_rejected log line", missing.length === 0,
    `missing=${missing.join(",")} seen=${JSON.stringify(rules)}`);

  // ---- report ----
  console.log = realLog;
  const failed = results.filter((x) => !x.ok);
  console.log("=".repeat(78));
  for (const t of results) {
    console.log((t.ok ? "PASS  " : "FAIL  ") + t.name);
    if (!t.ok) console.log("        evidence: " + t.evidence);
  }
  console.log("=".repeat(78));
  console.log("rejection log lines by rule: " + JSON.stringify(loggedRules()));
  console.log(`${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
