"use strict";
/*
  Storage. Two interchangeable back ends with the same methods:

    Postgres  when DATABASE_URL (or POSTGRES_URL) is set. Use this on Vercel. Works with
              Neon (Vercel's Storage tab), Supabase or any Postgres; use the pooled URL.
    Files     otherwise: one JSON file per candidate in DATA_DIR/profiles. Local use only.

  Methods (all async):
    get(ref)            full record including photo, or null
    insert(rec)         true if stored, false if that reference is already taken
    update(rec)         overwrite an existing record
    list()              summaries for the console, newest first, without photos
    remove(ref)
    recentAttempts(ip)  failed sign-ins from this IP in the last 15 minutes
    addAttempt(ip)
*/
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const summary = r => ({
  reference: r.reference, name: r.name || "", headline: r.headline || "", email: r.email || "",
  jobTitle: r.jobTitle || "", job: r.job || "", applied: !!r.applied, stage: r.stage || "New",
  submittedAt: r.submittedAt || "", updatedAt: r.updatedAt || "", hasPhoto: !!r.photo
});
const split = rec => { const data = Object.assign({}, rec); const photo = data.photo || ""; delete data.photo; return { data, photo }; };

/* ── Postgres ───────────────────────────────────────────── */
function pgStore() {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: DB_URL,
    max: process.env.VERCEL ? 1 : 5,         // one connection per serverless instance; the pooler does the rest
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000
  });
  pool.on("error", e => console.error("[db] idle client error", e.message));

  const SCHEMA = `
    CREATE TABLE IF NOT EXISTS applicant_profiles (
      reference   text PRIMARY KEY,
      email       text NOT NULL DEFAULT '',
      applied     boolean NOT NULL DEFAULT false,
      stage       text NOT NULL DEFAULT 'New',
      updated_at  timestamptz NOT NULL DEFAULT now(),
      photo       text NOT NULL DEFAULT '',
      data        jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS applicant_profiles_updated_idx ON applicant_profiles (updated_at DESC);
    CREATE TABLE IF NOT EXISTS admin_login_attempts (
      ip  text NOT NULL,
      at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS admin_login_attempts_idx ON admin_login_attempts (ip, at);`;

  // Tables are created on first use, once per instance. Two cold starts racing on
  // CREATE TABLE can collide, so a failure is retried once.
  let ready = null;
  const ensure = () => ready || (ready = pool.query(SCHEMA)
    .catch(() => pool.query(SCHEMA))
    .catch(e => { ready = null; throw e; }));
  const q = async (sql, args) => { await ensure(); return pool.query(sql, args); };

  return {
    kind: "postgres",
    migrate: ensure,
    async get(ref) {
      const r = await q("SELECT data, photo FROM applicant_profiles WHERE reference = $1", [ref]);
      return r.rows[0] ? Object.assign(r.rows[0].data, { photo: r.rows[0].photo }) : null;
    },
    async insert(rec) {
      const { data, photo } = split(rec);
      const r = await q(`INSERT INTO applicant_profiles (reference, email, applied, stage, updated_at, photo, data)
                         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (reference) DO NOTHING`,
        [rec.reference, rec.email || "", !!rec.applied, rec.stage || "New", rec.updatedAt, photo, data]);
      return r.rowCount === 1;
    },
    async update(rec) {
      const { data, photo } = split(rec);
      await q(`UPDATE applicant_profiles SET email=$2, applied=$3, stage=$4, updated_at=$5, photo=$6, data=$7 WHERE reference=$1`,
        [rec.reference, rec.email || "", !!rec.applied, rec.stage || "New", rec.updatedAt, photo, data]);
    },
    async list() {
      const r = await q(`SELECT data - 'experience' - 'education' - 'summary' AS data, photo <> '' AS has_photo
                         FROM applicant_profiles ORDER BY updated_at DESC LIMIT 5000`);
      return r.rows.map(row => summary(Object.assign(row.data, { photo: row.has_photo ? "1" : "" })));
    },
    async remove(ref) { await q("DELETE FROM applicant_profiles WHERE reference = $1", [ref]); },
    async recentAttempts(ip) {
      const r = await q("SELECT count(*)::int AS n FROM admin_login_attempts WHERE ip = $1 AND at > now() - interval '15 minutes'", [ip]);
      return r.rows[0].n;
    },
    async addAttempt(ip) {
      await q("INSERT INTO admin_login_attempts (ip) VALUES ($1)", [ip]);
      await q("DELETE FROM admin_login_attempts WHERE at < now() - interval '1 day'");
    },
    end: () => pool.end()
  };
}

/* ── Files (local only) ─────────────────────────────────── */
function fileStore() {
  const dir = path.join(process.env.DATA_DIR || path.join(__dirname, "..", "data"), "profiles");
  fs.mkdirSync(dir, { recursive: true });
  const file = r => path.join(dir, r + ".json");
  const write = async rec => {
    const tmp = file(rec.reference) + "." + process.pid + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(rec, null, 1));
    await fsp.rename(tmp, file(rec.reference));
  };
  const tries = new Map();
  return {
    kind: "files",
    migrate: async () => {},
    async get(ref) { try { return JSON.parse(await fsp.readFile(file(ref), "utf8")); } catch { return null; } },
    async insert(rec) {
      try { await fsp.writeFile(file(rec.reference), "", { flag: "wx" }); } catch { return false; }   // claim the name atomically
      await write(rec); return true;
    },
    update: write,
    async list() {
      const out = [];
      for (const n of (await fsp.readdir(dir)).filter(n => n.endsWith(".json"))) {
        try { out.push(summary(JSON.parse(await fsp.readFile(path.join(dir, n), "utf8")))); } catch {}
      }
      return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },
    async remove(ref) { await fsp.unlink(file(ref)).catch(() => {}); },
    async recentAttempts(ip) { const now = Date.now(); const t = (tries.get(ip) || []).filter(x => now - x < 15 * 60e3); tries.set(ip, t); return t.length; },
    async addAttempt(ip) { tries.set(ip, (tries.get(ip) || []).concat(Date.now())); },
    end: async () => {}
  };
}

let store = null;
module.exports = function getStore() {
  if (store) return store;
  if (DB_URL) return (store = pgStore());
  // Vercel's file system is read-only and wiped between requests: refuse rather than lose applications.
  if (process.env.VERCEL) throw Object.assign(new Error("No database is connected. Add DATABASE_URL in the Vercel project settings."), { code: 503 });
  return (store = fileStore());
};
