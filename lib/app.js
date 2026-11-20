"use strict";
/*
  The whole app as one request handler: (req, res) => Promise.
  Used by server.js (local Node) and api/index.js (Vercel).

  Pages
    /apply              the builder (?job=slug to apply for a role, ?staff=1 for staff tools, ?edit=REF to edit)
    /p/REF              a candidate's public profile (no email, phone, LinkedIn or rate)
    /jobs, /jobs/slug   open roles, read from data/jobs.json
    /admin              recruitment console (password from ADMIN_PASSWORD)
*/
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const getStore = require("./store");

const ROOT = path.join(__dirname, "..");
const PUB = path.join(ROOT, "public");
const ON_VERCEL = !!process.env.VERCEL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
// On Vercel every instance needs the same secret, or sign-ins drop at random. Locally a random one is fine.
const SECRET = process.env.SESSION_SECRET || (ON_VERCEL ? "" : crypto.randomBytes(32).toString("hex"));
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const AGENCY = process.env.AGENCY_NAME || "Assistra";
const MAX_BODY = 4.4 * 1024 * 1024;        // Vercel refuses request bodies over 4.5 MB
const STAGES = ["New", "Screening", "Interview", "Shortlisted", "Placed", "Not a fit"];

/* ── Fields ─────────────────────────────────────────────── */
const TEXT = { name:120, headline:200, city:120, tz:60, email:200, phone:60, linkedin:300, summary:2500, video:500, portfolio:500,
  job:120, jobTitle:200, hours:80, overlap:120, start:80, rate:80, internet:120, backup:200, english:80, office:400,
  agName:80, agBrand:20, agSite:120, agEmail:200, agPrefix:12, agNote:240 };
const LISTS = { skills:40, tools:40, languages:20 };
const PRIVATE = ["email", "phone", "linkedin", "rate"];
const LABELS = { photo:"headshot", name:"name", headline:"headline", city:"city", tz:"timezone", email:"email", phone:"mobile",
  linkedin:"LinkedIn", summary:"summary", video:"intro video", portfolio:"portfolio", hours:"hours", overlap:"client hours",
  start:"start date", rate:"rate", internet:"internet", backup:"backup", english:"English", office:"home office",
  skills:"core services", tools:"tools", languages:"languages", experience:"experience", education:"education" };

const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);

function clean(input) {
  const o = {};
  for (const [k, n] of Object.entries(TEXT)) o[k] = str(input[k], n);
  for (const [k, n] of Object.entries(LISTS))
    o[k] = (Array.isArray(input[k]) ? input[k] : []).map(v => str(v, 80)).filter(Boolean).slice(0, n);
  o.experience = (Array.isArray(input.experience) ? input.experience : []).slice(0, 15).map(e => ({
    role: str(e && e.role, 120), company: str(e && e.company, 200), period: str(e && e.period, 60), bullets: str(e && e.bullets, 3000)
  })).filter(e => e.role || e.company || e.bullets);
  o.education = (Array.isArray(input.education) ? input.education : []).slice(0, 15).map(e => ({
    title: str(e && e.title, 200), school: str(e && e.school, 200), year: str(e && e.year, 20)
  })).filter(e => e.title || e.school);
  const photo = String(input.photo || "");
  o.photo = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(photo) && photo.length < 3.5e6 ? photo : "";
  if (!/^#[0-9a-f]{6}$/i.test(o.agBrand)) o.agBrand = "";
  return o;
}

function gaps(p) {
  const out = [];
  [["name","full name"],["email","email"],["headline","headline"],["summary","summary"],["hours","weekly availability"],
   ["english","English level"],["internet","internet speed"],["video","intro video link"]].forEach(([k, l]) => { if (!p[k]) out.push(l); });
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) out.push("a valid email");
  if (p.video && !/^https?:\/\//i.test(p.video)) out.push("a video link starting with https://");
  if (!p.skills.length) out.push("a core service");
  if (!p.experience.some(e => e.role)) out.push("a role under Experience");
  return out;
}

const publicView = r => {
  const p = Object.assign({}, r);
  PRIVATE.concat(["stage","notes","history","submittedAt","updatedAt","applied","appliedAt"]).forEach(k => delete p[k]);
  return p;
};
const refOk = r => /^[A-Z0-9][A-Z0-9-]{2,39}$/.test(r);
function newRef(prefix) {
  const d = new Date();
  const ym = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, "0");
  return (prefix || "REF") + "-" + ym + "-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

/* Jobs ship with the code in data/jobs.json: edit the file and redeploy. */
let jobsCache = null;
function jobs() {
  if (jobsCache && ON_VERCEL) return jobsCache;
  try { const j = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "jobs.json"), "utf8")); return (jobsCache = Array.isArray(j) ? j : []); }
  catch { return []; }
}
const pages = {};
const page = f => (ON_VERCEL && pages[f]) || (pages[f] = fs.readFileSync(path.join(PUB, f)));

/* ── Admin session (signed cookie) ───────────────────────── */
const sign = v => crypto.createHmac("sha256", SECRET).update(v).digest("base64url");
function makeSession() { const exp = String(Date.now() + 12 * 3600e3); return exp + "." + sign(exp); }
function isAdmin(req) {
  if (!SECRET) return false;
  const m = /(?:^|;\s*)adm=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function passwordOk(p) {
  const h = s => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(h(p), h(ADMIN_PASSWORD));
}
const clientIp = req => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";

/* ── HTTP helpers ────────────────────────────────────────── */
const SEC_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Robots-Tag": "noindex" };
function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({ "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" }, SEC_HEADERS, extra || {}));
  res.end(body);
}
const json = (res, code, obj, extra) => send(res, code, JSON.stringify(obj), "application/json; charset=utf-8", extra);
const httpErr = (code, msg) => Object.assign(new Error(msg), { code });

function body(req) {
  // Vercel's Node runtime may already have read and parsed the body.
  if (ON_VERCEL && req.body !== undefined) {
    const b = req.body;
    if (b && typeof b === "object" && !Buffer.isBuffer(b)) return Promise.resolve(b);
    try { return Promise.resolve(JSON.parse(String(b || "{}"))); } catch { return Promise.reject(httpErr(400, "That wasn't valid JSON.")); }
  }
  return new Promise((ok, bad) => {
    let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > MAX_BODY) { bad(httpErr(413, "That's too large to send. Try a smaller headshot.")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { ok(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { bad(httpErr(400, "That wasn't valid JSON.")); } });
    req.on("error", bad);
  });
}
const origin = req => PUBLIC_URL || ((String(req.headers["x-forwarded-proto"] || "http").split(",")[0]) + "://" + req.headers.host);
const sameOrigin = req => { const o = req.headers.origin; return !o || o === origin(req) || o.replace(/^https?:/, "") === "//" + req.headers.host; };
const esc = t => String(t == null ? "" : t).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

/* ── Job pages ───────────────────────────────────────────── */
function shell(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>body{margin:0;font-family:Poppins,system-ui,sans-serif;background:#f5f3ee;color:#1c1b19;line-height:1.55}
.top{background:#16150f;color:#D4AF37;padding:16px 20px;font-weight:700;letter-spacing:.5px;border-bottom:3px solid #D4AF37}
.top a{color:inherit;text-decoration:none}main{max-width:760px;margin:0 auto;padding:24px 16px 60px}
.card{background:#fff;border:1px solid #e4e0d6;border-radius:12px;padding:18px 20px;margin-bottom:14px}
.card h2{margin:0 0 4px;font-size:18px}.meta{color:#6c6a66;font-size:13px}
.go{display:inline-block;background:#D4AF37;color:#16150f;font-weight:600;padding:10px 18px;border-radius:8px;text-decoration:none;margin-top:12px}
a{color:#7F6921}</style></head><body><div class="top"><a href="/jobs">${esc(AGENCY.toUpperCase())} CAREERS</a></div><main>${inner}</main></body></html>`;
}
function jobsPage() {
  const list = jobs().filter(j => j.open !== false);
  const cards = list.map(j => `<div class="card"><h2><a href="/jobs/${encodeURIComponent(j.slug)}">${esc(j.title)}</a></h2>
    <div class="meta">${[j.type, j.hours, j.location].filter(Boolean).map(esc).join(" · ")}</div><p>${esc(j.summary || "")}</p>
    <a class="go" href="/apply?job=${encodeURIComponent(j.slug)}">Apply</a></div>`).join("");
  return shell(AGENCY + " careers", `<h1>Open roles</h1>${cards || "<p>No open roles right now. You can still <a href='/apply'>send us your profile</a>.</p>"}
    <p class="meta">Don't see a fit? <a href="/apply">Send a general application</a>.</p>`);
}
function jobPage(j) {
  const sections = (j.sections || []).map(s => `<h3>${esc(s.heading)}</h3><ul>${(s.items || []).map(i => `<li>${esc(i)}</li>`).join("")}</ul>`).join("");
  return shell(j.title + " — " + AGENCY, `<p><a href="/jobs">← All roles</a></p><div class="card"><h1 style="margin:0 0 6px">${esc(j.title)}</h1>
    <div class="meta">${[j.type, j.hours, j.location].filter(Boolean).map(esc).join(" · ")}</div><p>${esc(j.summary || "")}</p>${sections}
    ${j.open === false ? "<p><b>This role is closed.</b></p>" : `<a class="go" href="/apply?job=${encodeURIComponent(j.slug)}">Apply for this role</a>`}</div>`);
}

/* ── Routes ──────────────────────────────────────────────── */
async function route(req, res) {
  const url = new URL(req.url, "http://x");
  // Vercel rewrites every path to /api/index?__p=<path>; put the original path back.
  let p = url.searchParams.has("__p") ? "/" + url.searchParams.get("__p") : url.pathname;
  p = p.replace(/\/+$/, "") || "/";
  const M = req.method;
  let m;

  if (M === "GET" && p === "/") return send(res, 302, "", "text/plain", { Location: "/jobs" });
  if (M === "GET" && (p === "/apply" || /^\/p\/[A-Za-z0-9-]+$/.test(p))) return send(res, 200, page("apply.html"), "text/html; charset=utf-8");
  if (M === "GET" && p === "/admin") return send(res, 200, page("admin.html"), "text/html; charset=utf-8");
  if (M === "GET" && p === "/jobs") return send(res, 200, jobsPage(), "text/html; charset=utf-8");
  if (M === "GET" && (m = p.match(/^\/jobs\/([a-z0-9-]+)$/i))) {
    const j = jobs().find(x => x.slug === m[1]);
    return j ? send(res, 200, jobPage(j), "text/html; charset=utf-8")
             : send(res, 404, shell("Not found", "<p>That role isn't listed. <a href='/jobs'>See open roles</a>.</p>"), "text/html; charset=utf-8");
  }
  if (M === "GET" && (m = p.match(/^\/api\/jobs\/([a-z0-9-]+)$/i))) {
    const j = jobs().find(x => x.slug === m[1]);
    return j ? json(res, 200, { ok: true, job: { slug: j.slug, title: j.title, open: j.open !== false } }) : json(res, 404, { ok: false, error: "No such role." });
  }
  if (M === "GET" && p === "/api/health") {
    const s = getStore(); await s.migrate();
    return json(res, 200, { ok: true, storage: s.kind });
  }

  /* Applying, or staff making a share link. The same person (same email) keeps the same reference, so the link updates in place. */
  if (M === "POST" && p === "/api/profile") {
    if (!sameOrigin(req)) return json(res, 403, { ok: false, error: "Cross-site request refused." });
    const store = getStore();
    const input = await body(req);
    const prof = clean(input);
    const g = gaps(prof);
    if (g.length) return json(res, 400, { ok: false, error: "Missing: " + g.join(", ") + "." });

    const prefix = (prof.agPrefix || "REF").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "REF";
    let ref = String(input.reference || "").toUpperCase().replace(/[^A-Z0-9-]/g, "");
    let prev = refOk(ref) ? await store.get(ref) : null;
    // A reference that belongs to someone else never overwrites their record: a fresh one is issued.
    if (prev && String(prev.email || "").toLowerCase() !== prof.email.toLowerCase()) { prev = null; ref = ""; }

    const now = new Date().toISOString();
    const rec = Object.assign({}, prev || {}, prof, {
      submittedAt: (prev && prev.submittedAt) || now,
      updatedAt: now,
      applied: Boolean(input.applied) || Boolean(prev && prev.applied),
      appliedAt: (prev && prev.appliedAt) || (input.applied ? now : ""),
      stage: (prev && prev.stage) || "New",
      notes: (prev && prev.notes) || [],
      history: ((prev && prev.history) || []).concat([{ at: now, by: "candidate",
        what: input.applied ? (prev ? "Resubmitted application" : "Applied" + (prof.jobTitle ? " for " + prof.jobTitle : ""))
                            : (prev ? "Updated profile link" : "Created profile link") }])
    });

    if (prev) {
      rec.reference = ref;
      await store.update(rec);
    } else {
      // Try the reference the page showed; if it's taken or invalid, keep drawing random ones.
      let candidate = refOk(ref) ? ref : newRef(prefix), stored = false;
      for (let i = 0; i < 6 && !stored; i++) {
        rec.reference = candidate;
        stored = await store.insert(rec);
        if (!stored) candidate = newRef(prefix);
      }
      if (!stored) throw httpErr(500, "Couldn't issue a reference. Please try again.");
    }
    console.log(`[profile] ${rec.reference} ${input.applied ? "applied" : "link"} ${prof.jobTitle || ""}`);
    return json(res, 200, { ok: true, reference: rec.reference, url: origin(req) + "/p/" + rec.reference });
  }

  if (M === "GET" && (m = p.match(/^\/api\/profile\/([A-Za-z0-9-]+)$/))) {
    const ref = m[1].toUpperCase();
    const rec = refOk(ref) ? await getStore().get(ref) : null;
    return rec ? json(res, 200, { ok: true, profile: publicView(rec) }) : json(res, 404, { ok: false, error: "No profile with that reference." });
  }

  /* ── Admin ── */
  if (M === "POST" && p === "/api/admin/login") {
    if (!ADMIN_PASSWORD) return json(res, 503, { ok: false, error: "Set ADMIN_PASSWORD on the server to use the console." });
    if (!SECRET) return json(res, 503, { ok: false, error: "Set SESSION_SECRET on the server to use the console." });
    const store = getStore(), ip = clientIp(req);
    if (await store.recentAttempts(ip) >= 10) return json(res, 429, { ok: false, error: "Too many attempts. Wait 15 minutes." });
    const { password } = await body(req);
    if (!passwordOk(password)) { await store.addAttempt(ip); return json(res, 401, { ok: false, error: "Wrong password." }); }
    const secure = origin(req).startsWith("https") ? "; Secure" : "";
    return json(res, 200, { ok: true }, { "Set-Cookie": `adm=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}` });
  }
  if (M === "POST" && p === "/api/admin/logout")
    return json(res, 200, { ok: true }, { "Set-Cookie": "adm=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });

  if (p.startsWith("/api/admin/")) {
    if (!isAdmin(req)) return json(res, 401, { ok: false, error: "Sign in to the console." });
    if (M !== "GET" && !sameOrigin(req)) return json(res, 403, { ok: false, error: "Cross-site request refused." });
    const store = getStore();

    if (M === "GET" && p === "/api/admin/applicants")
      return json(res, 200, { ok: true, applicants: await store.list(), stages: STAGES });

    if ((m = p.match(/^\/api\/admin\/applicants\/([A-Z0-9-]+)(\/profile)?$/))) {
      const rec = refOk(m[1]) ? await store.get(m[1]) : null;
      if (!rec) return json(res, 404, { ok: false, error: "No candidate with that reference." });
      if (M === "GET" && !m[2]) return json(res, 200, { ok: true, applicant: rec, stages: STAGES });

      // Staff edit of the profile. Stage, notes and history are left as they are.
      if (M === "PUT" && m[2]) {
        const prof = clean(await body(req));
        if (!prof.name || !prof.email) return json(res, 400, { ok: false, error: "A name and an email are needed." });
        ["agName","agBrand","agSite","agEmail","agPrefix","agNote","job","jobTitle"].forEach(k => delete prof[k]);
        const blank = k => (Array.isArray(prof[k]) ? [] : "");
        // Postgres jsonb doesn't keep key order, so compare with keys sorted.
        const canon = v => JSON.stringify(v, (k, x) => x && typeof x === "object" && !Array.isArray(x)
          ? Object.keys(x).sort().reduce((o, key) => (o[key] = x[key], o), {}) : x);
        const changed = Object.keys(LABELS).filter(k => canon(prof[k]) !== canon(rec[k] == null ? blank(k) : rec[k])).map(k => LABELS[k]);
        if (changed.length) {
          Object.assign(rec, prof, { updatedAt: new Date().toISOString() });
          rec.history = (rec.history || []).concat([{ at: rec.updatedAt, by: "staff", what: "Edited " + changed.join(", ") }]);
          await store.update(rec);
        }
        return json(res, 200, { ok: true, changed });
      }
      // Stage change and/or a note.
      if (M === "PATCH" && !m[2]) {
        const b = await body(req), now = new Date().toISOString();
        rec.history = rec.history || []; rec.notes = rec.notes || [];
        if (b.stage && STAGES.includes(b.stage) && b.stage !== rec.stage) {
          rec.history.push({ at: now, by: "staff", what: `Stage: ${rec.stage || "New"} → ${b.stage}` });
          rec.stage = b.stage;
        }
        const note = str(b.note, 2000);
        if (note) rec.notes.push({ at: now, text: note });
        rec.updatedAt = now;
        await store.update(rec);
        return json(res, 200, { ok: true, applicant: rec });
      }
      if (M === "DELETE" && !m[2]) { await store.remove(rec.reference); return json(res, 200, { ok: true }); }
    }
    return json(res, 404, { ok: false, error: "Not found." });
  }

  send(res, 404, "Not found");
}

module.exports = async function app(req, res) {
  try { await route(req, res); }
  catch (e) {
    const known = e.code >= 400 && e.code < 600;
    if (!known) console.error(e);
    if (!res.headersSent) json(res, known ? e.code : 500, { ok: false, error: known ? e.message : "Server error." });
  }
};
