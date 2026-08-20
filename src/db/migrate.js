'use strict';

// Migrations are numbered .sql files applied in filename order, each inside a
// transaction, each recorded once. Re-running is safe: applied files are skipped.

const fs = require('node:fs');
const path = require('node:path');

const { pool, withTransaction } = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedFilenames() {
  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  return new Set(rows.map((row) => row.filename));
}

function pendingFilenames(applied) {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .filter((name) => !applied.has(name));
}

async function migrate() {
  await ensureMigrationsTable();

  const pending = pendingFilenames(await appliedFilenames());

  if (pending.length === 0) {
    console.log('migrations: nothing to apply');
    return;
  }

  for (const filename of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');

    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    });

    console.log(`migrations: applied ${filename}`);
  }
}

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch(async (error) => {
      console.error('migrations failed:', error.message);
      await pool.end();
      process.exit(1);
    });
}

module.exports = { migrate };
