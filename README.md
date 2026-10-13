# Faizan e Ummul Khair Result Portal

Bilingual English/Urdu student results portal backed by Neon PostgreSQL. The existing frontend, CAPTCHA, admin login, result management, CSV import/export, notices, settings, and logo upload remain part of the app. The uploaded logo is stored in PostgreSQL so it persists across Render restarts.

## Requirements

- Node.js 24 or newer
- `npm install` (the project uses the `pg` package)
- A PostgreSQL connection URL in `DATABASE_URL`

## Run locally

1. Copy `.env.example` to `.env` if you do not already have a local `.env`.
2. Set `DATABASE_URL` in `.env` to the Neon connection string from your Neon dashboard. Keep it private; `.env` is ignored by Git. Do not send the URL in chat or commit it.
3. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env` (username at least 3 characters; password at least 11 characters).
4. Run `npm install`, then `npm start`.
5. Open <http://localhost:8000>. Admin is at <http://localhost:8000/admin>.

The server creates the PostgreSQL tables before listening. It does not automatically load the CSV or seed file at startup.

## Migrate the existing local data to Neon

The original SQLite database and seed JSON are kept in `server-data/`; the current CSV file is in the project root. The migration script reads `server-data/portal.sqlite`; if it contains no result rows, it uses `server-data/seed-results.json` instead. It never changes or deletes the SQLite database, seed JSON, or CSV.

1. Stop the local website with **Ctrl+C** in its terminal. In PowerShell, from the project folder, make a protected backup before migration:

   ```powershell
   $backup = "server-data/backups/before-neon-$(Get-Date -Format yyyyMMdd-HHmmss)"
   New-Item -ItemType Directory -Force $backup | Out-Null
   Copy-Item server-data/portal.sqlite* $backup
   Copy-Item server-data/seed-results.json,student-results-upload.csv $backup
   ```

   Keep that backup private. This copies the SQLite database and any WAL/SHM companion files together, plus the seed and CSV. Do not delete the originals.

2. Make sure the local `.env` contains the `DATABASE_URL` for the Neon database you intend to use. Keep this value private.
3. In PowerShell, open this project folder and run:

   ```powershell
   npm run migrate:neon -- --conflict=skip
   ```

   `--conflict=skip` keeps existing Neon rows with the same class/roll combination or record ID and reports them as skipped. Use `--conflict=abort` to stop before migrating if either kind of conflict exists. The script requires one of these choices and never overwrites existing Neon records. It migrates records, settings, notices, audit entries, and an uploaded logo if one exists locally. The migration runs in a PostgreSQL transaction; errors roll back the whole migration. Output contains counts only, not student details or database credentials.

4. Read the counts printed by the script. `conflicting` means an existing Neon row shared a class/roll number or ID but its content differed; it was skipped and left unchanged. Review such rows from the admin interface before deciding what to do.
5. Start the app with `npm start` and check a known roll number, admin login, and the admin pages.

The script is repeatable: already-present class/roll pairs and IDs are skipped. No automatic CSV import runs on server start.

## Render configuration

Set these private environment variables for the web service:

- `DATABASE_URL`: Neon PostgreSQL connection string
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `NODE_ENV=production`

The included Blueprint uses Render's free web-service plan and no Render disk; the PostgreSQL database and uploaded logo are stored in Neon. Free Render services can spin down when idle, so the first request after inactivity can be delayed. Applying a Blueprint can change service settings; review the plan in Render before confirming. The app does not deploy automatically from this repository.

After pushing the code to GitHub, deploy it from Render and confirm the environment variables are set there. Migrate local data using the local command above and a private `.env` containing the Neon URL; do not put the URL or student data in GitHub. Then open the Render URL and verify the public result search and `/admin` login.

The app uses Neon TLS with certificate verification enabled. Database connection errors are reported without printing the connection string. Keep the Neon URL and admin credentials private, and back up the database appropriately.
