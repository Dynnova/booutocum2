const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../data/pixibb.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cosplay (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT,
      cover_url   TEXT,
      page_url    TEXT UNIQUE,
      image_urls  TEXT DEFAULT NULL,
      created_at  TEXT,
      updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_title ON cosplay(title);
    CREATE INDEX IF NOT EXISTS idx_page_url ON cosplay(page_url);

    CREATE VIRTUAL TABLE IF NOT EXISTS cosplay_fts USING fts5(
      id UNINDEXED,
      title,
      content='cosplay',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS cosplay_ai AFTER INSERT ON cosplay BEGIN
      INSERT INTO cosplay_fts(rowid, id, title)
      VALUES (new.id, new.id, new.title);
    END;

    CREATE TRIGGER IF NOT EXISTS cosplay_au AFTER UPDATE ON cosplay BEGIN
      INSERT INTO cosplay_fts(cosplay_fts, rowid, id, title)
      VALUES ('delete', old.id, old.id, old.title);
      INSERT INTO cosplay_fts(rowid, id, title)
      VALUES (new.id, new.id, new.title);
    END;
  `);
}

function upsertCosplay(data) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO cosplay (title, cover_url, page_url, image_urls, created_at)
    VALUES (@title, @cover_url, @page_url, @image_urls, @created_at)
    ON CONFLICT(page_url) DO UPDATE SET
      title      = excluded.title,
      cover_url  = excluded.cover_url,
      image_urls = excluded.image_urls,
      updated_at = CURRENT_TIMESTAMP
  `).run(data);
}

function searchCosplay(query, limit = 5, offset = 0) {
  const db = getDb();
  try {
    const results = db.prepare(`
      SELECT c.* FROM cosplay c
      INNER JOIN cosplay_fts fts ON c.id = fts.id
      WHERE cosplay_fts MATCH ?
      ORDER BY rank
      LIMIT ? OFFSET ?
    `).all(`"${query}"*`, limit, offset);

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM cosplay c
      INNER JOIN cosplay_fts fts ON c.id = fts.id
      WHERE cosplay_fts MATCH ?
    `).get(`"${query}"*`);

    return { results, total: total.count };
  } catch {
    const like = `%${query}%`;
    const results = db.prepare(`
      SELECT * FROM cosplay
      WHERE title LIKE ?
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `).all(like, limit, offset);

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM cosplay WHERE title LIKE ?
    `).get(like);

    return { results, total: total.count };
  }
}

function getById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM cosplay WHERE id = ?').get(parseInt(id));
}

function getStats() {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) as total FROM cosplay').get();
}

module.exports = { getDb, upsertCosplay, searchCosplay, getById, getStats };
