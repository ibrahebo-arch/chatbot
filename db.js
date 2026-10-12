/**
 * VI Iraq – Postgres connection + migrations.
 *
 * DATABASE_URL comes only from the environment (Render injects it from the vi-iraq-db database).
 * SSL is used only for Render's *external* host (hostname contains ".render.com");
 * the internal URL (dpg-...-a) needs none. The URL is never logged.
 */
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const url = String(process.env.DATABASE_URL || "").trim();
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

function hostOf(u) {
  try { return new URL(u).hostname; } catch { return ""; }
}

const pool = url
  ? new Pool({
      connectionString: url,
      ssl: hostOf(url).includes(".render.com") ? { rejectUnauthorized: false } : false,
      max: Number(process.env.PG_POOL_MAX) || 5,
      // tests point search_path at a throw-away schema through PGOPTIONS
      ...(process.env.PGOPTIONS ? { options: process.env.PGOPTIONS } : {}),
    })
  : null;

if (pool) pool.on("error", (e) => console.error("postgres pool:", e.message));

/** Runs migrations/*.sql in name order, once each, tracked in schema_migrations. */
async function initDb() {
  if (!pool) throw new Error("DATABASE_URL is not set – add the Postgres connection string to the environment.");
  const client = await pool.connect();
  try {
    // one instance migrates at a time (two instances can start together during a deploy)
    await client.query("SELECT pg_advisory_lock(7212026)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    const applied = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await client.query("COMMIT");
        applied.push(f);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`migration ${f} failed: ${e.message}`);
      }
    }
    return { applied, total: files.length };
  } finally {
    await client.query("SELECT pg_advisory_unlock(7212026)").catch(() => {});
    client.release();
  }
}

/** Runs fn(client) inside BEGIN/COMMIT, rolling back on error. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const query = (text, params) => pool.query(text, params);

module.exports = { pool, initDb, tx, query, get configured() { return Boolean(pool); } };
