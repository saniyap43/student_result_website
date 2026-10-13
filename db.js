'use strict';

const { Pool } = require('pg');

function createPool() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw Object.assign(new Error('DATABASE_URL is not configured.'), { code: 'DATABASE_URL_MISSING' });

  let connectionString = databaseUrl;
  let ssl;
  try {
    const parsed = new URL(databaseUrl);
    if (/\.neon\.tech$/i.test(parsed.hostname)) {
      // Neon requires TLS. Keep certificate verification enabled.
      parsed.searchParams.delete('sslmode');
      connectionString = parsed.toString();
      ssl = { rejectUnauthorized: true };
    }
  } catch {
    throw Object.assign(new Error('DATABASE_URL is invalid.'), { code: 'DATABASE_URL_INVALID' });
  }

  return new Pool({
    connectionString,
    ssl,
    max: 10,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000
  });
}

let activePool;
function getPool() {
  if (!activePool) activePool = createPool();
  return activePool;
}
const pool = {
  query(...args) { return getPool().query(...args); },
  connect(...args) { return getPool().connect(...args); },
  end() { return activePool ? activePool.end() : Promise.resolve(); }
};

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS records (
      id BIGSERIAL PRIMARY KEY,
      class_name TEXT NOT NULL,
      roll_no TEXT NOT NULL,
      name TEXT NOT NULL,
      father_name TEXT NOT NULL DEFAULT '',
      marks_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      total DOUBLE PRECISION NOT NULL DEFAULT 0,
      percentage DOUBLE PRECISION NOT NULL DEFAULT 0,
      grade TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      CONSTRAINT records_class_roll_unique UNIQUE (class_name, roll_no)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS records_active_roll_idx ON records(roll_no) WHERE active = TRUE');
  await pool.query('CREATE INDEX IF NOT EXISTS records_active_class_roll_idx ON records(class_name, roll_no) WHERE active = TRUE');
  await pool.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notices (
      id BIGSERIAL PRIMARY KEY,
      title_en TEXT NOT NULL,
      title_ur TEXT NOT NULL DEFAULT '',
      body_en TEXT NOT NULL DEFAULT '',
      body_ur TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'General',
      published BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TEXT NOT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS notices_published_id_idx ON notices(published, id DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit (
      id BIGSERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brand_assets (
      id TEXT PRIMARY KEY,
      content BYTEA NOT NULL,
      mime TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain the original error */ }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, initializeDatabase, transaction };
