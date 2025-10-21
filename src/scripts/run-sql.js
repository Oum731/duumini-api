// scripts/run-sql.js
const fs = require('fs');
const path = require('path');
const { getPool } = require('../lib/db');

function splitSql(sql) {
  const lines = sql
    .split('\n')
    .map(l => l.replace(/--.*$/g, '')) // retire commentaires -- fin de ligne
    .join('\n');

  const chunks = lines
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);

  return chunks;
}

async function runDir(dir) {
  const pool = getPool();
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) {
    console.error(`Dossier introuvable: ${abs}`);
    process.exit(1);
  }

  const files = fs.readdirSync(abs)
    .filter(f => f.endsWith('.sql'))
    .sort(); // ordre 001_, 002_, etc.

  for (const file of files) {
    const full = path.join(abs, file);
    const sql = fs.readFileSync(full, 'utf8');
    const statements = splitSql(sql);
    console.log(`\n==> ${file} (${statements.length} requêtes)`);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const stmt of statements) {
        await conn.query(stmt);
      }
      await conn.commit();
      console.log(`   OK`);
    } catch (e) {
      await conn.rollback();
      console.error(`   ERREUR sur ${file}:`, e.message);
      process.exit(1);
    } finally {
      conn.release();
    }
  }

  await pool.end();
}

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node scripts/run-sql.js <dossier_sql>');
  process.exit(1);
}

runDir(dir).catch(e => {
  console.error(e);
  process.exit(1);
});
