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

This local starter provides a single administrator account and one local SQLite database. It does not yet include student accounts, separate departments/courses/subject catalogues, examination scheduling, grading-rule configuration, bulk Excel import, QR result verification, or multi-admin roles. Dates, SGPA/CGPA, and examination names are not present in the source workbook, so the portal does not fabricate them.

Do not expose this local server directly to the internet. Public deployment needs a managed database, HTTPS, production session storage, backups, operational monitoring, and institute-approved access and verification policies. In particular, father's name is only an additional lookup check; it is not strong authentication.
