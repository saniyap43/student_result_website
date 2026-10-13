'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { pool, initializeDatabase, transaction } = require('../db');

const ROOT = path.resolve(__dirname, '..');
const SQLITE_PATH = path.resolve(process.env.SQLITE_PATH || path.join(ROOT, 'server-data', 'portal.sqlite'));
const SEED_PATH = path.resolve(process.env.SEED_PATH || path.join(ROOT, 'server-data', 'seed-results.json'));
const LOGO_PATH = path.join(path.dirname(SQLITE_PATH), 'brand-logo.bin');

function conflictPolicy(args) {
  const value = args.find(item => item.startsWith('--conflict='))?.slice('--conflict='.length);
  if (!['skip', 'abort'].includes(value)) throw new Error('Choose an explicit conflict policy: --conflict=skip or --conflict=abort.');
  return value;
}

function asRecord(record) {
  return {
    id: Number(record.id),
    className: String(record.class_name ?? record.className ?? ''),
    rollNo: String(record.roll_no ?? record.rollNo ?? ''),
    name: String(record.name ?? ''),
    fatherName: String(record.father_name ?? record.fatherName ?? ''),
    marks: typeof record.marks_json === 'string' ? JSON.parse(record.marks_json) : (record.marks_json || record.marks || {}),
    total: Number(record.total) || 0,
    percentage: Number(record.percentage) || 0,
    grade: String(record.grade || ''),
    status: String(record.status || ''),
    active: record.active === true || Number(record.active) === 1
  };
}

function readSource() {
  if (!fs.existsSync(SQLITE_PATH)) throw Object.assign(new Error('SQLite source database was not found.'), { code: 'SOURCE_MISSING' });
  const sqlite = new DatabaseSync(SQLITE_PATH, { readOnly: true });
  try {
    const tableNames = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(item => item.name));
    if (!tableNames.has('records')) throw Object.assign(new Error('SQLite database has no records table.'), { code: 'SOURCE_SCHEMA' });
    const dbRecords = sqlite.prepare('SELECT * FROM records ORDER BY id').all().map(asRecord);
    const settings = tableNames.has('settings') ? sqlite.prepare('SELECT key, value FROM settings').all() : [];
    const notices = tableNames.has('notices') ? sqlite.prepare('SELECT * FROM notices ORDER BY id').all() : [];
    const audit = tableNames.has('audit') ? sqlite.prepare('SELECT * FROM audit ORDER BY id').all() : [];
    let sourceRecords = dbRecords, sourceName = 'sqlite';

    if (!dbRecords.length && fs.existsSync(SEED_PATH)) {
      const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
      if (!Array.isArray(seed)) throw Object.assign(new Error('Seed file is not a JSON array.'), { code: 'SOURCE_SEED' });
      sourceRecords = seed.map((record, index) => asRecord({ ...record, id: record.id ?? index + 1 }));
      sourceName = 'seed-results.json (SQLite contained no records)';
    }
    if (!sourceRecords.length) throw Object.assign(new Error('SQLite and seed sources contain no result records.'), { code: 'SOURCE_EMPTY' });
    return { records: sourceRecords, settings, notices, audit, sourceName, dbRecordCount: dbRecords.length };
  } finally {
    sqlite.close();
  }
}

function duplicateKeys(records) {
  const seen = new Set();
  let duplicates = 0;
  for (const record of records) {
    const key = `${record.className}\u0000${record.rollNo}`;
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }
  return duplicates;
}

function duplicateIds(records) {
  const seen = new Set();
  let duplicates = 0;
  for (const record of records) {
    if (seen.has(record.id)) duplicates++;
    else seen.add(record.id);
  }
  return duplicates;
}

function sameRecord(existing, record) {
  const marks = typeof existing.marks_json === 'string' ? JSON.parse(existing.marks_json) : existing.marks_json;
  const normalizedMarks = Object.fromEntries(Object.entries(marks || {}).sort(([a], [b]) => a.localeCompare(b)));
  const sourceMarks = Object.fromEntries(Object.entries(record.marks || {}).sort(([a], [b]) => a.localeCompare(b)));
  return existing.name === record.name
    && existing.father_name === record.fatherName
    && JSON.stringify(normalizedMarks) === JSON.stringify(sourceMarks)
    && Number(existing.total) === record.total
    && Number(existing.percentage) === record.percentage
    && existing.grade === record.grade
    && existing.status === record.status
    && (existing.active === true || Number(existing.active) === 1) === record.active;
}

async function setSequence(client, table) {
  await client.query(`SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE(MAX(id), 1), COALESCE(MAX(id), 0) > 0) FROM ${table}`, [table]);
}

async function runMigration(policy) {
  const source = readSource();
  const duplicateSourceRows = duplicateKeys(source.records);
  const duplicateSourceIds = duplicateIds(source.records);
  const counts = { inserted: 0, skipped: 0, conflicting: 0, failed: 0, settingsInserted: 0, settingsSkipped: 0, noticesInserted: 0, noticesSkipped: 0, auditInserted: 0, auditSkipped: 0, logoInserted: 0, logoSkipped: 0 };
  if (duplicateSourceRows || duplicateSourceIds) {
    counts.failed = duplicateSourceRows + duplicateSourceIds;
    return { source, counts, aborted: true, reason: 'Duplicate class/roll combinations or record IDs exist in the local source.' };
  }

  try { await initializeDatabase(); }
  catch (error) {
    return { source, counts, aborted: true, reason: `PostgreSQL initialization failed before any rows were attempted (${error.code || error.name || 'unknown'}).` };
  }
  let existingConflicts;
  try { existingConflicts = await pool.query('SELECT id, class_name, roll_no FROM records'); }
  catch (error) {
    return { source, counts, aborted: true, reason: `Could not inspect existing PostgreSQL records; no rows were attempted (${error.code || error.name || 'unknown'}).` };
  }
  const existingPairs = new Set(existingConflicts.rows.map(record => `${record.class_name}\u0000${record.roll_no}`));
  const existingIds = new Set(existingConflicts.rows.map(record => String(record.id)));
  const incomingConflicts = source.records.filter(record => existingPairs.has(`${record.className}\u0000${record.rollNo}`) || existingIds.has(String(record.id)));
  if (policy === 'abort' && incomingConflicts.length) {
    counts.failed = incomingConflicts.length;
    return { source, counts, aborted: true, reason: 'Neon already contains one or more matching class/roll-number combinations or record IDs.' };
  }

  try { await transaction(async client => {
    for (const record of source.records) {
      const collision = await client.query('SELECT id, class_name, roll_no, name, father_name, marks_json, total, percentage, grade, status, active FROM records WHERE (class_name = $1 AND roll_no = $2) OR id = $3 LIMIT 1', [record.className, record.rollNo, record.id]);
      if (collision.rowCount) {
        counts.skipped++;
        if (collision.rows[0].class_name !== record.className || collision.rows[0].roll_no !== record.rollNo || !sameRecord(collision.rows[0], record)) counts.conflicting++;
        continue;
      }
      await client.query(`INSERT INTO records(id, class_name, roll_no, name, father_name, marks_json, total, percentage, grade, status, active)
        VALUES($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)`,
      [record.id, record.className, record.rollNo, record.name, record.fatherName, JSON.stringify(record.marks), record.total, record.percentage, record.grade, record.status, record.active]);
      counts.inserted++;
    }
    for (const item of source.settings) {
      const result = await client.query('INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO NOTHING RETURNING key', [item.key, item.value]);
      result.rowCount ? counts.settingsInserted++ : counts.settingsSkipped++;
    }
    for (const notice of source.notices) {
      const result = await client.query(`INSERT INTO notices(id, title_en, title_ur, body_en, body_ur, category, published, created_at)
        VALUES($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT(id) DO NOTHING RETURNING id`,
      [notice.id, notice.title_en, notice.title_ur, notice.body_en, notice.body_ur, notice.category, Boolean(notice.published), notice.created_at]);
      result.rowCount ? counts.noticesInserted++ : counts.noticesSkipped++;
    }
    for (const entry of source.audit) {
      const result = await client.query('INSERT INTO audit(id, action, detail, created_at) VALUES($1, $2, $3, $4) ON CONFLICT(id) DO NOTHING RETURNING id', [entry.id, entry.action, entry.detail, entry.created_at]);
      result.rowCount ? counts.auditInserted++ : counts.auditSkipped++;
    }
    if (fs.existsSync(LOGO_PATH)) {
      const exists = await client.query('SELECT id FROM brand_assets WHERE id = $1', ['primary']);
      if (exists.rowCount) counts.logoSkipped++;
      else {
        const logo = fs.readFileSync(LOGO_PATH);
        const mime = logo[0] === 0x89 && logo.subarray(1, 4).toString('ascii') === 'PNG' ? 'image/png' : 'image/jpeg';
        await client.query('INSERT INTO brand_assets(id, content, mime, updated_at) VALUES($1, $2, $3, $4)', ['primary', logo, mime, new Date().toISOString()]);
        await client.query('INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO NOTHING', ['logoPath', '/api/brand-logo']);
        counts.logoInserted++;
      }
    }
    await setSequence(client, 'records');
    await setSequence(client, 'notices');
    await setSequence(client, 'audit');
  }); }
  catch (error) {
    counts.inserted = 0;
    counts.skipped = 0;
    counts.conflicting = 0;
    counts.failed = source.records.length;
    return { source, counts, aborted: true, reason: `PostgreSQL transaction rolled back (${error.code || error.name || 'unknown'}).` };
  }
  return { source, counts, aborted: false };
}

function report(result) {
  console.log(`Source: ${result.source.sourceName}`);
  console.log(`Local SQLite record count: ${result.source.dbRecordCount}`);
  console.log(`Student records: inserted=${result.counts.inserted}, skipped=${result.counts.skipped}, conflicting=${result.counts.conflicting}, failed=${result.counts.failed}`);
  console.log(`Settings: inserted=${result.counts.settingsInserted}, skipped=${result.counts.settingsSkipped}`);
  console.log(`Notices: inserted=${result.counts.noticesInserted}, skipped=${result.counts.noticesSkipped}`);
  console.log(`Audit entries: inserted=${result.counts.auditInserted}, skipped=${result.counts.auditSkipped}`);
  console.log(`Uploaded logo: inserted=${result.counts.logoInserted}, skipped=${result.counts.logoSkipped}`);
  if (result.aborted) console.error(`Migration stopped: ${result.reason}`);
}

async function main() {
  let policy;
  try { policy = conflictPolicy(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }
  try {
    const result = await runMigration(policy);
    report(result);
    if (result.aborted) process.exitCode = 1;
  } catch (error) {
    console.error('Migration could not complete; no partial migration was committed.');
    if (error.code === 'SOURCE_MISSING') console.error(`Missing SQLite source file: ${path.relative(ROOT, SQLITE_PATH)}`);
    else if (error.code === 'SOURCE_SCHEMA') console.error('The SQLite source file does not contain the required records table.');
    else if (error.code === 'SOURCE_EMPTY') console.error('The SQLite database and seed-results.json contain no student records.');
    else console.error('Reason code:', error.code || error.name || 'unknown');
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) main();
module.exports = { runMigration, readSource, conflictPolicy };
