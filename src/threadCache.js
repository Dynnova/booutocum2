const { getDb } = require('./database');

const TTL_DAYS = 14;
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

function initThreadCache() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_cache (
      query_key TEXT PRIMARY KEY,
      short_id TEXT UNIQUE,
      thread_id TEXT NOT NULL,
      thread_name TEXT,
      creator_id TEXT,
      creator_tag TEXT,
      cosplay_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_accessed TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const cols = db.prepare(`PRAGMA table_info(thread_cache)`).all().map(c => c.name);
  if (!cols.includes('short_id'))      db.exec(`ALTER TABLE thread_cache ADD COLUMN short_id TEXT`);
  if (!cols.includes('last_accessed')) db.exec(`ALTER TABLE thread_cache ADD COLUMN last_accessed TEXT DEFAULT ''`);
}

function generateShortId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const part = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${part()}-${part()}`;
}

function getCachedThread(queryKey) {
  const db = getDb();
  initThreadCache();
  const row = db.prepare('SELECT * FROM thread_cache WHERE query_key = ?').get(queryKey);
  if (!row) return null;

  const lastAccessed = new Date(row.last_accessed || row.created_at).getTime();
  if (Date.now() - lastAccessed > TTL_MS) {
    db.prepare('DELETE FROM thread_cache WHERE query_key = ?').run(queryKey);
    return null;
  }

  db.prepare('UPDATE thread_cache SET last_accessed = ? WHERE query_key = ?')
    .run(new Date().toISOString(), queryKey);

  return row;
}

function getCachedThreadByShortId(shortId) {
  const db = getDb();
  initThreadCache();
  const row = db.prepare('SELECT * FROM thread_cache WHERE short_id = ?').get(shortId);
  if (!row) return null;

  const lastAccessed = new Date(row.last_accessed || row.created_at).getTime();
  if (Date.now() - lastAccessed > TTL_MS) {
    db.prepare('DELETE FROM thread_cache WHERE short_id = ?').run(shortId);
    return null;
  }

  db.prepare('UPDATE thread_cache SET last_accessed = ? WHERE short_id = ?')
    .run(new Date().toISOString(), shortId);

  return row;
}

function saveThreadCache({ queryKey, threadId, threadName, creatorId, creatorTag, cosplayId }) {
  const db = getDb();
  initThreadCache();

  let shortId;
  let attempts = 0;
  do {
    shortId = generateShortId();
    attempts++;
  } while (db.prepare('SELECT 1 FROM thread_cache WHERE short_id = ?').get(shortId) && attempts < 10);

  db.prepare(`
    INSERT OR REPLACE INTO thread_cache 
      (query_key, short_id, thread_id, thread_name, creator_id, creator_tag, cosplay_id, created_at, last_accessed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(queryKey, shortId, threadId, threadName, creatorId, creatorTag, cosplayId,
    new Date().toISOString(), new Date().toISOString());

  return shortId;
}

function deleteExpiredThreads() {
  const db = getDb();
  initThreadCache();
  const cutoff = new Date(Date.now() - TTL_MS).toISOString();
  const expired = db.prepare(`SELECT * FROM thread_cache WHERE last_accessed < ?`).all(cutoff);
  if (expired.length) {
    db.prepare(`DELETE FROM thread_cache WHERE last_accessed < ?`).run(cutoff);
  }
  return expired;
}

function makeQueryKey(cosplayId) {
  return `cosplay_${cosplayId}`;
}

module.exports = {
  getCachedThread,
  getCachedThreadByShortId,
  saveThreadCache,
  makeQueryKey,
  initThreadCache,
  deleteExpiredThreads,
};
