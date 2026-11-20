"use strict";
/*
  Creates the tables, and optionally copies candidates saved as local files into Postgres.
    DATABASE_URL=postgres://... npm run migrate
    DATABASE_URL=postgres://... npm run migrate -- --import data/profiles
  The app also creates the tables on first use, so this is optional.
*/
const fs = require("fs");
const path = require("path");
const getStore = require("../lib/store");

(async () => {
  const store = getStore();
  if (store.kind !== "postgres") { console.error("Set DATABASE_URL first."); process.exit(1); }
  await store.migrate();
  console.log("Tables ready.");
  const i = process.argv.indexOf("--import");
  if (i > 0) {
    const dir = path.resolve(process.argv[i + 1] || "data/profiles");
    let added = 0, skipped = 0;
    for (const n of fs.readdirSync(dir).filter(n => n.endsWith(".json"))) {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      if (!rec.reference) continue;
      if (await store.insert(rec)) added++; else skipped++;
    }
    console.log(`Imported ${added}, skipped ${skipped} already in the database.`);
  }
  await store.end();
})().catch(e => { console.error(e.message); process.exit(1); });
