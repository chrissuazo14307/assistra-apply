"use strict";
/*
  Local server.  npm install && ADMIN_PASSWORD=choose-one npm start
  With DATABASE_URL set it uses Postgres; without it, JSON files in data/profiles.
  On Vercel, api/index.js runs the same app instead of this file.
*/
const http = require("http");
const app = require("./lib/app");
const getStore = require("./lib/store");

const PORT = Number(process.env.PORT) || 3000;
http.createServer(app).listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}  (apply: /apply · console: /admin · storage: ${getStore().kind})`);
  if (!process.env.ADMIN_PASSWORD) console.log("ADMIN_PASSWORD is not set, so the console is locked.");
});
