const IS_PG = !!process.env.DATABASE_URL;
let pool = null;

if (IS_PG) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

const BACKUP_TABLES = ['schools', 'sections', 'users', 'teacher_sections', 'messages', 'files', 'timetable', 'warnings', 'reports', 'notes'];

async function init() {
  if (!IS_PG || !pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rashd_backup (
      table_name TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TEXT DEFAULT (NOW())
    )
  `);
}

async function backup(db) {
  if (!IS_PG || !pool) return;
  try {
    for (const table of BACKUP_TABLES) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      await pool.query(
        `INSERT INTO rashd_backup (table_name, data) VALUES ($1, $2)
         ON CONFLICT (table_name) DO UPDATE SET data = $2, updated_at = NOW()`,
        [table, JSON.stringify(rows)]
      );
    }
    console.log('💾 Backup saved to PostgreSQL');
  } catch (e) {
    console.error('Backup error:', e.message);
  }
}

async function restore(db) {
  if (!IS_PG || !pool) return false;
  try {
    await init();
    const result = await pool.query(`SELECT * FROM rashd_backup ORDER BY table_name`);
    if (!result.rows.length) return false;

    db.exec('PRAGMA foreign_keys = OFF');
    for (const { table_name, data } of result.rows) {
      const rows = typeof data === 'string' ? JSON.parse(data) : data;
      if (!rows || !rows.length) continue;
      const columns = Object.keys(rows[0]);
      const placeholders = columns.map(c => `@${c}`).join(', ');
      const cols = columns.join(', ');
      db.exec(`DELETE FROM ${table_name}`);
      const stmt = db.prepare(`INSERT INTO ${table_name} (${cols}) VALUES (${placeholders})`);
      for (const r of rows) stmt.run(r);
    }
    // Fix auto-increment counters
    for (const table of BACKUP_TABLES) {
      const row = db.prepare(`SELECT MAX(id) as m FROM ${table}`).get();
      if (row && row.m) {
        db.exec(`UPDATE sqlite_sequence SET seq = ${row.m} WHERE name = '${table}'`);
      }
    }
    db.exec('PRAGMA foreign_keys = ON');
    console.log(`✅ Restored data from PostgreSQL backup (${result.rows.length} tables)`);
    return true;
  } catch (e) {
    console.error('Restore error:', e.message);
    try { db.exec('PRAGMA foreign_keys = ON'); } catch (_) {}
    return false;
  }
}

function startAutoBackup(db, ms = 30000) {
  if (!IS_PG || !pool) return;
  setTimeout(() => backup(db), 3000);
  setInterval(() => backup(db), ms);
  console.log(`⏲️ Auto-backup every ${ms / 1000}s to PostgreSQL`);
}

module.exports = { IS_PG, init, backup, restore, startAutoBackup };
