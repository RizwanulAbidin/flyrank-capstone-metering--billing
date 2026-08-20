'use strict';

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set in .env');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Run a set of statements as one unit. Either all of them happen or none do.
// The reserve and commit steps both depend on this.
async function withTransaction(work) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
