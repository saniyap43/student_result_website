'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pool, initializeDatabase, transaction } = require('./db');

const ROOT = __dirname;
const username = process.env.ADMIN_USERNAME || '';
const password = process.env.ADMIN_PASSWORD || '';
if (username.length < 3 || password.length < 11) {
  throw new Error('Set ADMIN_USERNAME (at least 3 characters) and ADMIN_PASSWORD (at least 11 characters).');
}
const adminSalt = crypto.randomBytes(16);
const adminHash = crypto.scryptSync(password, adminSalt, 64);
const sessions = new Map();
const captchas = new Map();
const limits = new Map();

const defaults = {
  instituteNameEn: 'Faizan e ummul khair',
  instituteNameUr: 'جامعة البنات',
  taglineEn: 'Student Result Portal',
  taglineUr: 'طلبہ نتائج پورٹل',
  footerText: 'Learning with purpose',
  heroTitleEn: 'Your hard work,\nbeautifully reflected.',
  heroTitleUr: 'آپ کی محنت کا\nخوبصورت نتیجہ۔',
  heroTextEn: 'Find your academic result using your roll number.',
  heroTextUr: 'اپنا رول نمبر درج کرکے اپنا تعلیمی نتیجہ دیکھیں۔',
  logoPath: 'mub-logo.jpeg'
};

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const allowedFiles = new Set(['index.html', 'admin.html', 'styles.css', 'polish.css', 'captcha.css', 'visual.css', 'quran.css', 'motion.css', 'features.css', 'server-features.css', 'admin.css', 'admin-features.css', 'app.js', 'admin.js', 'mub-logo.jpeg']);
const now = () => new Date().toISOString();

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
async function settings(client = pool) {
  const result = await client.query('SELECT key, value FROM settings');
  return Object.fromEntries(result.rows.map(item => [item.key, item.value]));
}
function row(record) {
  if (!record) return null;
  return {
    id: Number.isSafeInteger(Number(record.id)) ? Number(record.id) : String(record.id),
    className: record.class_name,
    rollNo: record.roll_no,
    academicYear: yearFromRollNo(record.roll_no),
    name: record.name,
    fatherName: record.father_name,
    marks: typeof record.marks_json === 'string' ? JSON.parse(record.marks_json) : (record.marks_json || {}),
    total: Number(record.total),
    percentage: Number(record.percentage),
    grade: record.grade,
    status: record.status,
    active: record.active === true || record.active === 1
  };
}
async function audit(action, detail, client = pool) {
  await client.query('INSERT INTO audit(action, detail, created_at) VALUES($1, $2, $3)', [action, detail, now()]);
}
function cookie(req, name) {
  const part = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(name + '='));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}
function authenticated(req) {
  const id = cookie(req, 'portal_session');
  const entry = sessions.get(id);
  if (!entry || entry.expires < Date.now()) {
    if (id) sessions.delete(id);
    return false;
  }
  entry.expires = Date.now() + 60 * 60 * 1000;
  return true;
}
function limited(req, key, max = 25) {
  const ip = req.socket.remoteAddress || 'local';
  const id = `${key}:${ip}`;
  const item = limits.get(id) || { start: Date.now(), count: 0 };
  if (Date.now() - item.start > 60000) { item.start = Date.now(); item.count = 0; }
  item.count++;
  limits.set(id, item);
  return item.count <= max;
}
function body(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function text(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function yearFromRollNo(rollNo) { const match = String(rollNo || '').match(/^(25|26)/); return match ? `20${match[1]}` : ''; }
function validRecord(data) {
  return data && text(data.className, 80) && text(data.rollNo, 60) && text(data.name, 160)
    && data.marks && typeof data.marks === 'object' && !Array.isArray(data.marks)
    && Object.entries(data.marks).every(([subject, mark]) => text(subject, 160) && Number.isFinite(Number(mark)) && Number(mark) >= 0)
    && Number.isFinite(Number(data.total)) && Number(data.total) >= 0
    && Number.isFinite(Number(data.percentage)) && Number(data.percentage) >= 0 && Number(data.percentage) <= 100
    && text(data.status, 40);
}
function parseCsv(input) {
  const rows = [];
  let currentRow = [], field = '', quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { currentRow.push(field); field = ''; }
    else if (ch === '\n') {
      currentRow.push(field.replace(/\r$/, ''));
      if (currentRow.some(value => value.trim())) rows.push(currentRow);
      currentRow = []; field = '';
    } else field += ch;
  }
  if (quoted) throw new Error('CSV has an unclosed quoted field.');
  currentRow.push(field.replace(/\r$/, ''));
  if (currentRow.some(value => value.trim())) rows.push(currentRow);
  return rows;
}
function csrfOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function publicError(error) {
  if (error.code === '23505') return { status: 409, message: 'A record with those details already exists.' };
  if (error.status) return { status: error.status, message: error.message };
  return { status: 500, message: 'The request could not be completed.' };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/site') {
      const [config, notices, classes, years, count] = await Promise.all([
        settings(),
        pool.query('SELECT id, title_en, title_ur, body_en, body_ur, category, created_at FROM notices WHERE published = TRUE ORDER BY id DESC LIMIT 10'),
        pool.query('SELECT DISTINCT class_name FROM records WHERE active = TRUE ORDER BY class_name'),
        pool.query("SELECT DISTINCT CASE LEFT(roll_no, 2) WHEN '25' THEN '2025' WHEN '26' THEN '2026' END AS year FROM records WHERE active = TRUE AND LEFT(roll_no, 2) IN ('25', '26') ORDER BY year"),
        pool.query('SELECT COUNT(*) AS n FROM records WHERE active = TRUE')
      ]);
      return send(res, 200, { settings: config, notices: notices.rows, classes: classes.rows.map(item => item.class_name), years: years.rows.map(item => item.year), studentCount: Number(count.rows[0].n) });
    }
    if (req.method === 'GET' && url.pathname === '/api/brand-logo') {
      const result = await pool.query('SELECT content, mime FROM brand_assets WHERE id = $1', ['primary']);
      if (!result.rowCount) return send(res, 404, { error: 'No replacement logo uploaded.' });
      res.writeHead(200, { 'content-type': result.rows[0].mime, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      return res.end(result.rows[0].content);
    }
    if (req.method === 'POST' && url.pathname === '/api/captcha') {
      if (!limited(req, 'captcha', 45)) return send(res, 429, { error: 'Please wait and request a new check.' });
      const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', lower = 'abcdefghijkmnpqrstuvwxyz', chars = upper + lower;
      const answerChars = [upper[crypto.randomInt(upper.length)], lower[crypto.randomInt(lower.length)], ...Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)])];
      for (let i = answerChars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [answerChars[i], answerChars[j]] = [answerChars[j], answerChars[i]]; }
      const answer = answerChars.join(''), id = crypto.randomBytes(24).toString('hex');
      captchas.set(id, { answer, expires: Date.now() + 180000 });
      return send(res, 200, { id, letters: answer });
    }
    if (req.method === 'POST' && url.pathname === '/api/results/search') {
      if (!limited(req, 'result-search', 12)) return send(res, 429, { error: 'Too many searches. Wait a minute and try again.' });
      const data = await body(req), challengeId = text(data.challengeId, 80), challenge = captchas.get(challengeId);
      captchas.delete(challengeId);
      if (!challenge || challenge.expires < Date.now() || String(data.captcha || '') !== challenge.answer) return send(res, 400, { error: 'Verification failed. Refresh the code and try again.' });
      const rollNo = text(data.rollNo, 60), className = text(data.className, 80), academicYear = text(data.academicYear, 4);
      if (academicYear && !['2025', '2026'].includes(academicYear)) return send(res, 400, { error: 'Select a valid result year.' });
      const yearPrefix = academicYear ? academicYear.slice(2) : '';
      if (!rollNo) return send(res, 400, { error: 'Enter your roll number.' });
      const result = className
        ? await pool.query("SELECT * FROM records WHERE active = TRUE AND roll_no = $1 AND class_name = $2 AND ($3 = '' OR LEFT(roll_no, 2) = $3)", [rollNo, className, yearPrefix])
        : await pool.query("SELECT * FROM records WHERE active = TRUE AND roll_no = $1 AND ($2 = '' OR LEFT(roll_no, 2) = $2) ORDER BY class_name LIMIT 2", [rollNo, yearPrefix]);
      if (!result.rowCount) return send(res, 404, { error: 'No result matched those details.' });
      if (result.rowCount > 1) return send(res, 409, { error: 'This roll number appears in more than one class. Select a class to find the right result.' });
      const selected = result.rows[0];
      const related = selected.father_name && text(selected.father_name, 160)
        ? await pool.query("SELECT * FROM records WHERE active = TRUE AND id <> $1 AND LEFT(roll_no, 2) IN ('25', '26') AND LEFT(roll_no, 2) <> LEFT($2, 2) AND LOWER(BTRIM(name)) = LOWER(BTRIM($3)) AND LOWER(BTRIM(father_name)) = LOWER(BTRIM($4)) ORDER BY roll_no", [selected.id, selected.roll_no, selected.name, selected.father_name])
        : { rows: [] };
      const results = [selected, ...related.rows].map(row);
      return send(res, 200, { result: results[0], results });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
      if (!limited(req, 'admin-login', 6)) return send(res, 429, { error: 'Too many login attempts. Try again later.' });
      if (!csrfOk(req)) return send(res, 403, { error: 'Request origin rejected.' });
      const data = await body(req), user = text(data.username, 100), pass = String(data.password || '');
      const hash = crypto.scryptSync(pass, adminSalt, 64);
      const userOk = crypto.timingSafeEqual(crypto.createHash('sha256').update(user).digest(), crypto.createHash('sha256').update(username).digest());
      const passOk = crypto.timingSafeEqual(hash, adminHash);
      if (!userOk || !passOk) return send(res, 401, { error: 'Invalid username or password.' });
      const sid = crypto.randomBytes(32).toString('hex');
      sessions.set(sid, { expires: Date.now() + 60 * 60 * 1000, user });
      await audit('admin.login', 'Administrator signed in.');
      return send(res, 200, { ok: true }, { 'set-cookie': `portal_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
      if (!csrfOk(req)) return send(res, 403, { error: 'Request origin rejected.' });
      sessions.delete(cookie(req, 'portal_session'));
      return send(res, 200, { ok: true }, { 'set-cookie': 'portal_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (url.pathname.startsWith('/api/admin/')) {
      if (!authenticated(req)) return send(res, 401, { error: 'Please sign in.' });
      if (req.method !== 'GET' && !csrfOk(req)) return send(res, 403, { error: 'Request origin rejected.' });

      if (req.method === 'GET' && url.pathname === '/api/admin/data') {
        const [records, config, notices, auditRows] = await Promise.all([
          pool.query('SELECT * FROM records ORDER BY class_name, roll_no'),
          settings(),
          pool.query('SELECT * FROM notices ORDER BY id DESC'),
          pool.query('SELECT * FROM audit ORDER BY id DESC LIMIT 200')
        ]);
        return send(res, 200, { records: records.rows.map(row), settings: config, notices: notices.rows, audit: auditRows.rows });
      }
      if (req.method === 'PUT' && url.pathname === '/api/admin/settings') {
        const data = await body(req), allowed = ['instituteNameEn', 'instituteNameUr', 'taglineEn', 'taglineUr', 'footerText', 'heroTitleEn', 'heroTitleUr', 'heroTextEn', 'heroTextUr'];
        const config = await transaction(async client => {
          for (const key of allowed) if (data[key] !== undefined) await client.query('INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value', [key, text(data[key], 250)]);
          await audit('settings.update', 'Administrator updated institute settings.', client);
          return settings(client);
        });
        return send(res, 200, { settings: config });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/logo') {
        const data = await body(req), match = String(data.image || '').match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/);
        if (!match) return send(res, 400, { error: 'Choose a PNG or JPEG image.' });
        const bytes = Buffer.from(match[2], 'base64');
        if (bytes.length > 1024 * 1024) return send(res, 413, { error: 'Logo file must be 1 MB or smaller.' });
        const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
        if (!valid) return send(res, 400, { error: 'This image file could not be verified.' });
        const imageMime = `image/${match[1]}`;
        await transaction(async client => {
          await client.query('INSERT INTO brand_assets(id, content, mime, updated_at) VALUES($1, $2, $3, $4) ON CONFLICT(id) DO UPDATE SET content = EXCLUDED.content, mime = EXCLUDED.mime, updated_at = EXCLUDED.updated_at', ['primary', bytes, imageMime, now()]);
          await client.query('INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value', ['logoPath', '/api/brand-logo']);
          await client.query('INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value', ['logoMime', imageMime]);
          await audit('settings.logo', 'Administrator replaced the institute logo.', client);
        });
        return send(res, 200, { settings: await settings() });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/import/results') {
        const data = await body(req);
        if (typeof data.csv !== 'string' || data.csv.length > 1500000) return send(res, 400, { error: 'Upload a CSV file smaller than 1.5 MB.' });
        let csvRows;
        try { csvRows = parseCsv(data.csv); } catch { return send(res, 400, { error: 'CSV contains an unclosed quoted field.' }); }
        if (csvRows.length < 2) return send(res, 400, { error: 'CSV contains no result rows.' });
        const headers = csvRows[0].map(value => value.trim().replace(/^\uFEFF/, '').toLowerCase());
        const required = ['class', 'rollno', 'name', 'fathername', 'subject', 'mark', 'total', 'percentage', 'grade', 'status'];
        if (required.some(header => !headers.includes(header))) return send(res, 400, { error: `CSV headers must include: ${required.join(', ')}` });
        const index = Object.fromEntries(required.map(header => [header, headers.indexOf(header)])), grouped = new Map();
        for (let i = 1; i < csvRows.length; i++) {
          const cells = csvRows[i], value = Object.fromEntries(required.map(header => [header, cells[index[header]] || '']));
          const className = text(value.class, 80), rollNo = text(value.rollno, 60), name = text(value.name, 160), fatherName = text(value.fathername, 160), subject = text(value.subject, 160);
          const mark = Number(value.mark), total = Number(value.total), percentage = Number(value.percentage), grade = text(value.grade, 40), status = text(value.status, 40);
          if (!className || !rollNo || !name || !subject || !Number.isFinite(mark) || mark < 0 || !Number.isFinite(total) || total < 0 || !Number.isFinite(percentage) || percentage < 0 || percentage > 100 || !status) return send(res, 400, { error: `Invalid or incomplete values on CSV row ${i + 1}.` });
          const key = `${className}\u0000${rollNo}`;
          let item = grouped.get(key);
          if (!item) { item = { className, rollNo, name, fatherName, marks: {}, total, percentage, grade, status }; grouped.set(key, item); }
          else if (item.name !== name || item.fatherName !== fatherName || item.total !== total || item.percentage !== percentage || item.grade !== grade || item.status !== status) return send(res, 400, { error: `Student details conflict on CSV row ${i + 1}.` });
          if (Object.hasOwn(item.marks, subject)) return send(res, 400, { error: `Duplicate subject for roll ${rollNo} on CSV row ${i + 1}.` });
          item.marks[subject] = mark;
        }
        await transaction(async client => {
          for (const item of grouped.values()) {
            await client.query(`INSERT INTO records(class_name, roll_no, name, father_name, marks_json, total, percentage, grade, status, active)
              VALUES($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, TRUE)
              ON CONFLICT(class_name, roll_no) DO UPDATE SET name = EXCLUDED.name, father_name = EXCLUDED.father_name, marks_json = EXCLUDED.marks_json, total = EXCLUDED.total, percentage = EXCLUDED.percentage, grade = EXCLUDED.grade, status = EXCLUDED.status, active = TRUE`,
            [item.className, item.rollNo, item.name, item.fatherName, JSON.stringify(item.marks), item.total, item.percentage, item.grade, item.status]);
          }
          await audit('records.import', `Imported or updated ${grouped.size} result records from CSV.`, client);
        });
        return send(res, 200, { imported: grouped.size });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/records') {
        const data = await body(req);
        if (!validRecord(data)) return send(res, 400, { error: 'Complete the required student and result fields.' });
        const saved = await transaction(async client => {
          const result = await client.query(`INSERT INTO records(class_name, roll_no, name, father_name, marks_json, total, percentage, grade, status, active)
            VALUES($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, TRUE) RETURNING *`,
          [text(data.className, 80), text(data.rollNo, 60), text(data.name, 160), text(data.fatherName, 160), JSON.stringify(data.marks), Number(data.total), Number(data.percentage), text(data.grade, 40), text(data.status, 40)]);
          await audit('record.create', 'Administrator added a student result.', client);
          return row(result.rows[0]);
        });
        return send(res, 201, { record: saved });
      }
      const recordMatch = url.pathname.match(/^\/api\/admin\/records\/(\d+)$/);
      if (recordMatch && req.method === 'PUT') {
        const id = recordMatch[1], data = await body(req);
        if (!validRecord(data)) return send(res, 400, { error: 'Complete the required student and result fields.' });
        const saved = await transaction(async client => {
          const result = await client.query(`UPDATE records SET class_name=$1, roll_no=$2, name=$3, father_name=$4, marks_json=$5::jsonb, total=$6, percentage=$7, grade=$8, status=$9, active=$10 WHERE id=$11 RETURNING *`,
          [text(data.className, 80), text(data.rollNo, 60), text(data.name, 160), text(data.fatherName, 160), JSON.stringify(data.marks), Number(data.total), Number(data.percentage), text(data.grade, 40), text(data.status, 40), data.active !== false, id]);
          if (!result.rowCount) return null;
          await audit('record.update', 'Administrator updated a student result.', client);
          return row(result.rows[0]);
        });
        if (!saved) return send(res, 404, { error: 'Record not found.' });
        return send(res, 200, { record: saved });
      }
      if (recordMatch && req.method === 'DELETE') {
        const changed = await transaction(async client => {
          const result = await client.query('UPDATE records SET active = FALSE WHERE id = $1 RETURNING id', [recordMatch[1]]);
          if (result.rowCount) await audit('record.deactivate', 'Administrator deactivated a student result.', client);
          return result.rowCount > 0;
        });
        if (!changed) return send(res, 404, { error: 'Record not found.' });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/notices') {
        const data = await body(req);
        if (!text(data.titleEn, 160) || !text(data.bodyEn, 2000)) return send(res, 400, { error: 'English title and message are required.' });
        const id = await transaction(async client => {
          const result = await client.query(`INSERT INTO notices(title_en, title_ur, body_en, body_ur, category, published, created_at)
            VALUES($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [text(data.titleEn, 160), text(data.titleUr, 160), text(data.bodyEn, 2000), text(data.bodyUr, 2000), text(data.category, 60) || 'General', Boolean(data.published), now()]);
          await audit('notice.create', 'Administrator created a notice.', client);
          return Number(result.rows[0].id);
        });
        return send(res, 201, { id });
      }
      const noticeMatch = url.pathname.match(/^\/api\/admin\/notices\/(\d+)$/);
      if (noticeMatch && req.method === 'PUT') {
        const data = await body(req), id = noticeMatch[1];
        if (!text(data.titleEn, 160) || !text(data.bodyEn, 2000)) return send(res, 400, { error: 'English title and message are required.' });
        const changed = await transaction(async client => {
          const result = await client.query(`UPDATE notices SET title_en=$1, title_ur=$2, body_en=$3, body_ur=$4, category=$5, published=$6 WHERE id=$7 RETURNING id`,
          [text(data.titleEn, 160), text(data.titleUr, 160), text(data.bodyEn, 2000), text(data.bodyUr, 2000), text(data.category, 60) || 'General', Boolean(data.published), id]);
          if (result.rowCount) await audit('notice.update', 'Administrator updated a notice.', client);
          return result.rowCount > 0;
        });
        if (!changed) return send(res, 404, { error: 'Notice not found.' });
        return send(res, 200, { ok: true });
      }
      if (noticeMatch && req.method === 'DELETE') {
        const removed = await transaction(async client => {
          const result = await client.query('DELETE FROM notices WHERE id = $1 RETURNING id', [noticeMatch[1]]);
          if (result.rowCount) await audit('notice.delete', 'Administrator deleted a notice.', client);
          return result.rowCount > 0;
        });
        if (!removed) return send(res, 404, { error: 'Notice not found.' });
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Admin endpoint not found.' });
    }
    if (req.method === 'GET' && url.pathname === '/') return serve('index.html', res);
    if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin.html')) return serve('admin.html', res);
    if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && url.pathname.startsWith('/')) {
      const file = decodeURIComponent(url.pathname.slice(1));
      if (allowedFiles.has(file)) return serve(file, res);
    }
    return send(res, 404, { error: 'Not found.' });
  } catch (error) {
    const response = publicError(error);
    if (response.status === 500) console.error('A server request failed:', error.code || error.name || 'unknown error');
    if (!res.headersSent) return send(res, response.status, { error: response.message });
    res.destroy();
  }
}

function serve(name, res) {
  if (!allowedFiles.has(name)) return send(res, 404, { error: 'Not found.' });
  const file = path.join(ROOT, name);
  res.writeHead(200, { 'content-type': mime[path.extname(name)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' });
  fs.createReadStream(file).on('error', () => { if (!res.headersSent) send(res, 404, { error: 'Not found.' }); else res.destroy(); }).pipe(res);
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8000;
  const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  initializeDatabase().then(async () => {
    await transaction(async client => {
      for (const [key, value] of Object.entries(defaults)) await client.query('INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO NOTHING', [key, value]);
    });
    http.createServer(handle).listen(port, host, () => console.log(`Student Result Portal listening on ${host}:${port}`));
  }).catch(async error => {
    console.error('Database initialization failed:', error.code || error.name || 'unknown error');
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = { handle, row, parseCsv, validRecord };
