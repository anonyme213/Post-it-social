const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../data');

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(dataDir, 'postit.db');

const schemaPath = path.join(__dirname, 'schema.sql');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

if (!fs.existsSync(dbPath)) {
  console.log('Initialisation de la base de données SQLite...');
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Erreur ouverture DB:', err);
    throw err;
  }
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      return resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      return resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      return resolve(rows || []);
    });
  });
}

async function ensureBoardsTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 30),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      creator_id INTEGER,
      FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_boards_slug ON boards(slug)');
  await run("INSERT OR IGNORE INTO boards (slug, creator_id) VALUES ('general', NULL)");

  const postitsColumns = await all('PRAGMA table_info(postits)');
  const hasBoardSlug = postitsColumns.some((col) => col.name === 'board_slug');

  if (hasBoardSlug) {
    await run(`
      INSERT OR IGNORE INTO boards (slug)
      SELECT DISTINCT
        CASE
          WHEN TRIM(COALESCE(board_slug, '')) = '' THEN 'general'
          ELSE board_slug
        END
      FROM postits
    `);
  }
}

async function ensureLegacyPostitsColumns() {
  const columns = await all('PRAGMA table_info(postits)');
  if (!columns.length) return;

  const hasUpdatedAt = columns.some((col) => col.name === 'updated_at');
  const hasImageUrl = columns.some((col) => col.name === 'image_url');
  const hasBoardId = columns.some((col) => col.name === 'board_id');
  const hasBoardSlug = columns.some((col) => col.name === 'board_slug');

  if (!hasUpdatedAt) {
    await run('ALTER TABLE postits ADD COLUMN updated_at DATETIME');
    await run(
      'UPDATE postits SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = ""'
    );
  }

  if (!hasImageUrl) {
    await run('ALTER TABLE postits ADD COLUMN image_url TEXT');
  }

  if (!hasBoardId && !hasBoardSlug) {
    await run("ALTER TABLE postits ADD COLUMN board_slug TEXT NOT NULL DEFAULT 'general'");
  }
}

async function migratePostitsToBoardForeignKey() {
  const columns = await all('PRAGMA table_info(postits)');
  if (!columns.length) return;

  const hasBoardId = columns.some((col) => col.name === 'board_id');
  if (hasBoardId) {
    await run('CREATE INDEX IF NOT EXISTS idx_postits_board_id ON postits(board_id)');
    await run('CREATE INDEX IF NOT EXISTS idx_postits_updated_at ON postits(updated_at)');
    return;
  }

  const hasBoardSlug = columns.some((col) => col.name === 'board_slug');
  if (!hasBoardSlug) {
    await run("ALTER TABLE postits ADD COLUMN board_slug TEXT NOT NULL DEFAULT 'general'");
  }

  await ensureBoardsTable();

  console.log('Migration postits -> board_id en cours...');

  await run('PRAGMA foreign_keys = OFF');
  await run('BEGIN TRANSACTION');

  try {
    await run('ALTER TABLE postits RENAME TO postits_old');

    await run(`
      CREATE TABLE postits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        x REAL NOT NULL,
        y REAL NOT NULL,
        board_id INTEGER NOT NULL,
        author_id INTEGER NOT NULL,
        image_url TEXT,
        FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE,
        FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await run(`
      INSERT INTO postits (
        id,
        text,
        created_at,
        updated_at,
        x,
        y,
        board_id,
        author_id,
        image_url
      )
      SELECT
        p.id,
        p.text,
        p.created_at,
        COALESCE(p.updated_at, p.created_at),
        p.x,
        p.y,
        b.id,
        p.author_id,
        p.image_url
      FROM postits_old p
      JOIN boards b
        ON b.slug = CASE
          WHEN TRIM(COALESCE(p.board_slug, '')) = '' THEN 'general'
          ELSE p.board_slug
        END
    `);

    await run('DROP TABLE postits_old');

    await run('CREATE INDEX IF NOT EXISTS idx_postits_author_id ON postits(author_id)');
    await run('CREATE INDEX IF NOT EXISTS idx_postits_board_id ON postits(board_id)');
    await run('CREATE INDEX IF NOT EXISTS idx_postits_updated_at ON postits(updated_at)');

    await run('COMMIT');
    console.log('Migration postits -> board_id terminée.');
  } catch (err) {
    await run('ROLLBACK');
    throw err;
  } finally {
    await run('PRAGMA foreign_keys = ON');
  }
}

async function ensurePostitHistoryTable() {
  const row = await get(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'postit_history'"
  );

  if (!row || !row.sql) {
    return;
  }

  const oldForeignKeyOnPostit = /FOREIGN KEY\s*\(\s*postit_id\s*\)\s*REFERENCES\s*postits/i.test(
    row.sql
  );

  if (!oldForeignKeyOnPostit) {
    await run('CREATE INDEX IF NOT EXISTS idx_postit_history_postit_id ON postit_history(postit_id)');
    return;
  }

  console.log('Migration de postit_history en cours...');

  await run('PRAGMA foreign_keys = OFF');
  await run('BEGIN TRANSACTION');

  try {
    await run('ALTER TABLE postit_history RENAME TO postit_history_old');

    await run(`
      CREATE TABLE postit_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        postit_id INTEGER NOT NULL,
        text TEXT,
        x REAL,
        y REAL,
        image_url TEXT,
        changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        changed_by INTEGER NOT NULL,
        change_type TEXT NOT NULL CHECK (change_type IN ('created', 'updated', 'deleted')),
        FOREIGN KEY (changed_by) REFERENCES users(id)
      )
    `);

    await run(`
      INSERT INTO postit_history (
        id,
        postit_id,
        text,
        x,
        y,
        image_url,
        changed_at,
        changed_by,
        change_type
      )
      SELECT
        id,
        postit_id,
        text,
        x,
        y,
        image_url,
        changed_at,
        changed_by,
        change_type
      FROM postit_history_old
    `);

    await run('DROP TABLE postit_history_old');
    await run('CREATE INDEX IF NOT EXISTS idx_postit_history_postit_id ON postit_history(postit_id)');

    await run('COMMIT');
    console.log('Migration postit_history terminée.');
  } catch (err) {
    await run('ROLLBACK');
    throw err;
  } finally {
    await run('PRAGMA foreign_keys = ON');
  }
}

async function initialize() {
  await run('PRAGMA foreign_keys = ON');

  const schema = fs.readFileSync(schemaPath, 'utf-8');
  await new Promise((resolve, reject) => {
    db.exec(schema, (err) => {
      if (err) return reject(err);
      return resolve();
    });
  });

  await ensureLegacyPostitsColumns();
  await ensureBoardsTable();
  await migratePostitsToBoardForeignKey();
  await ensurePostitHistoryTable();
  await run("INSERT OR IGNORE INTO boards (slug, creator_id) VALUES ('general', NULL)");
}

db.ready = initialize().catch((err) => {
  console.error('Erreur initialisation base:', err);
  throw err;
});

module.exports = db;