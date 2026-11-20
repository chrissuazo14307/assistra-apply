# Assistra applicant profile builder

Candidates fill in one form, and it builds a branded A4 profile live beside them. They can then submit it, share it as a link or download it as a PDF. Staff manage candidates in a small console.

## Deploy on Vercel

1. Push this folder to a GitHub repo and import it in Vercel. There's no build step and no framework to pick.
2. In the Vercel project, open **Storage → Create Database → Neon (Postgres)** and connect it to the project. This adds `DATABASE_URL` for you. Any other Postgres works too (Supabase and so on); use its **pooled** connection string as `DATABASE_URL`.
3. Under **Settings → Environment Variables**, add:
   * `ADMIN_PASSWORD`: the console password.
   * `SESSION_SECRET`: any long random string, e.g. the output of `openssl rand -hex 32`. Required on Vercel.
   * `PUBLIC_URL` (optional): e.g. `https://careers.assistrallc.com`, so profile links use your domain.
4. Redeploy. Open `/api/health`: it should say `"storage":"postgres"`. The tables are created automatically on first use.

## Pages

| Page | What it is |
|---|---|
| `/jobs` | Open roles, read from `data/jobs.json` |
| `/apply` | The builder (general application) |
| `/apply?job=executive-assistant` | Apply for a specific role |
| `/apply?staff=1` | Staff view: branding panel and "Get profile link" button |
| `/apply?edit=REF` | Staff edit of a candidate (sign in to `/admin` first) |
| `/p/REF` | A candidate's public profile |
| `/admin` | Recruitment console |
| `/api/health` | Shows which storage is in use |

## Run locally

```bash
npm install
ADMIN_PASSWORD=test npm start
```

Without `DATABASE_URL`, candidates are saved as JSON files in `data/profiles/`. With it, they go to Postgres, as on Vercel. To copy local files into the database:

```bash
DATABASE_URL=postgres://... npm run migrate -- --import data/profiles
```

## Customise

* Branding, currency, careers email: the `CONFIG` block at the top of the `<script>` in `public/apply.html`.
* Roles: edit `data/jobs.json` and redeploy. Set `"open": false` to close a role.
* Pipeline stages: `STAGES` in `lib/app.js`.

## How it's built

* `lib/app.js`: all routes and validation, as one `(req, res)` handler.
* `lib/store.js`: storage. Postgres when `DATABASE_URL` is set, files otherwise. On Vercel it refuses to run without a database rather than lose applications.
* `api/index.js`: Vercel entry. `vercel.json` routes every path to it.
* `server.js`: local entry.

Postgres tables: `applicant_profiles` holds one row per candidate (reference, email, stage, photo, and the rest as `jsonb`), and `admin_login_attempts` throttles console sign-ins to 10 tries per 15 minutes per IP.

Email, mobile, LinkedIn and rate are never sent to `/p/` pages or the public API. Headshots are shrunk in the browser to about 1 MB so a submission stays under Vercel's 4.5 MB request limit.
