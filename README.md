# Faizan e ummul khair Result Portal

Bilingual English/Urdu result portal with a local Node.js server and SQLite database. The initial records were imported from the six workbook classes. Student data is kept under `server-data/`, which the web server never exposes as static files.

## Requirements

- Node.js 24 or newer (uses Node's built-in SQLite support; no npm packages are needed).

## Start locally on Windows

1. In PowerShell, open this project folder.
2. Create your private admin configuration: `Copy-Item .env.example .env` (an `.env` is already configured in this workspace).
3. If configuring a fresh copy, open `.env` and set a unique admin username and a long password (at least 11 characters). Do not share or commit `.env`.
4. Start the portal with `npm start`.
5. Open <http://localhost:8000>. The admin page is at <http://localhost:8000/admin>.

On first start, the server imports `server-data/seed-results.json` into `server-data/portal.sqlite`. Later changes made from Admin are stored in SQLite. Keep backups of `server-data/portal.sqlite` somewhere protected.

## Admin features

- Dashboard counts, search and filter student records, edit or add student/result rows, deactivate/reactivate records, and import/export CSV data.
- Edit subject names and marks in a record's JSON marks field. Update total, percentage, grade, and status explicitly; the portal does not invent grading rules.
- Create, edit, publish, and delete bilingual notices.
- Change the institute name, portal subtitle, hero heading and introduction, footer message, and logo from Institute settings.
- Review an append-only-in-the-interface audit history of admin actions.

Result lookup requires a roll number, an optional batch/class filter, and a server-issued mixed-case CAPTCHA. Search is rate-limited. Admin passwords are read from `.env`; sessions use HttpOnly, SameSite cookies and expire after an hour. Use a longer, unique password before the portal is used beyond localhost.

For CSV import/export use one row per subject with these exact columns: `Class,RollNo,Name,FatherName,Subject,Mark,Total,Percentage,Grade,Status`. Repeated subject rows are grouped into one student result, and the import validates the full file before updating records. Use the CSV template button in the admin panel.

## Scope and deployment

This local starter provides a single administrator account and one SQLite database. It does not yet include student accounts, separate departments/courses/subject catalogues, examination scheduling, grading-rule configuration, bulk Excel import, QR result verification, or multi-admin roles. Dates, SGPA/CGPA, and examination names are not present in the source workbook, so the portal does not fabricate them.

### Hosting

Pushing this repository to GitHub stores the source code; it does not start the application. GitHub Pages only publishes static files, while this portal needs the Node.js server for its API, CAPTCHA, admin login, and SQLite database. Host it on a Node.js web-service provider instead.

Configure the provider with Node.js 24 or newer and the start command `npm start`. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` as private environment secrets, `NODE_ENV=production`, and `DATA_DIR` to a persistent disk or mounted data directory. The server uses the provider's `PORT` and binds publicly in production; locally it still binds only to `127.0.0.1`. Do not use an ephemeral filesystem for `DATA_DIR`, because database edits and uploaded logos would be lost on restart or redeploy.

The private `server-data/` directory is intentionally excluded from Git. The included `render.yaml` is a Render Blueprint for the full Node.js site. It provisions a paid Starter web service and a persistent 1 GB disk, sets `DATA_DIR=/var/data`, and asks you to enter `ADMIN_USERNAME` and `ADMIN_PASSWORD` privately during setup. Review Render's current pricing before creating the service.

A hosted database starts empty because student data and `.env` are excluded from Git. After deployment, sign in to `/admin` with the credentials you set in Render and import the result CSV. To transfer the current local records, export them from the local admin page and import that CSV on the hosted admin page. Keep student data private; do not commit it to GitHub. Public hosting also requires institute approval, HTTPS, backups, and an access policy appropriate for student results.

To deploy, push this project (including `render.yaml`) to the GitHub repository, then in Render choose **New → Blueprint**, connect that repository, and apply the Blueprint. Enter a private admin username and a unique password of at least 11 characters when prompted. Render will create the web service and persistent disk. After it reports the service as live, open its URL, sign in at `/admin`, and import the CSV exported from your local admin page. Check Render's current plan and disk prices before applying the Blueprint; its Starter service and disk are paid resources.
