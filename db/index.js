const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcryptjs");
const path = require("path");

const DB_PATH = path.join(__dirname, "bank.sqlite");
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS agencies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('agency','head_office','admin','middle_office','back_office')),
  is_active INTEGER NOT NULL DEFAULT 1,
  agency_id TEXT REFERENCES agencies(id)
);

CREATE TABLE IF NOT EXISTS devises (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agence_id TEXT NOT NULL REFERENCES agencies(id),
  nature_sujet TEXT NOT NULL,
  nom_client TEXT NOT NULL,
  numero_compte TEXT NOT NULL,
  sens TEXT NOT NULL CHECK(sens IN ('achat','vente')),
  devise TEXT NOT NULL REFERENCES devises(code),
  currency_from TEXT,
  currency_to TEXT,
  date_valeur TEXT NOT NULL,
  montant REAL NOT NULL,
  taux_spot REAL NOT NULL,
  taux_source_date TEXT,
  taux_final REAL,
  requested_taux REAL,
  status TEXT NOT NULL DEFAULT 'spot_only',
  decision_comment TEXT,
  created_by INTEGER REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);
`);

function ensureColumn(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

ensureColumn("operations", "currency_from", "TEXT");
ensureColumn("operations", "currency_to", "TEXT");
ensureColumn("agencies", "is_active", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("users", "is_active", "INTEGER NOT NULL DEFAULT 1");

function migrateUsersTableIfNeeded() {
  const schemaRow = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'",
    )
    .get();
  if (!schemaRow || String(schemaRow.sql || "").includes("'middle_office'")) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("ALTER TABLE users RENAME TO users_legacy");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('agency','head_office','admin','middle_office','back_office')),
      is_active INTEGER NOT NULL DEFAULT 1,
      agency_id TEXT REFERENCES agencies(id)
    )
  `);
  db.exec(`
    INSERT INTO users (id, username, password_hash, full_name, role, is_active, agency_id)
    SELECT id, username, password_hash, full_name, role, COALESCE(is_active, 1), agency_id
    FROM users_legacy
  `);
  db.exec("DROP TABLE users_legacy");
  db.exec("PRAGMA foreign_keys = ON");
}

migrateUsersTableIfNeeded();

db.exec(`
  UPDATE operations
  SET currency_from = CASE
        WHEN currency_from IS NULL THEN COALESCE(NULLIF(devise, 'TND'), 'USD')
        WHEN currency_from = 'TND' AND COALESCE(currency_to, '') != 'TND' THEN COALESCE(NULLIF(currency_to, 'TND'), currency_from)
        ELSE currency_from
      END,
      currency_to = CASE
        WHEN currency_to IS NULL OR currency_to <> 'TND' THEN 'TND'
        ELSE currency_to
      END
  WHERE currency_from IS NULL
     OR currency_to IS NULL
     OR currency_to <> 'TND'
     OR currency_from = 'TND'
`);

function seed() {
  const agencyCount = db.prepare("SELECT COUNT(*) c FROM agencies").get().c;
  if (agencyCount === 0) {
    const insert = db.prepare(
      "INSERT INTO agencies (id, name, is_active) VALUES (?, ?, 1)",
    );
    for (let i = 0; i <= 100; i++) {
      const id = String(i).padStart(3, "0");
      insert.run(id, `Agence ${id}`);
    }
  }

  const devCount = db.prepare("SELECT COUNT(*) c FROM devises").get().c;
  if (devCount === 0) {
    const insert = db.prepare("INSERT INTO devises (code, name) VALUES (?, ?)");
    const list = [
      ["TND", "Dinar tunisien"],
      ["USD", "Dollar americain"],
      ["EUR", "Euro"],
      ["GBP", "Livre sterling"],
      ["JPY", "Yen japonais"],
      ["CAD", "Dollar canadien"],
      ["CHF", "Franc suisse"],
    ];
    list.forEach(([code, name]) => insert.run(code, name));
  }

  const userCount = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  if (userCount === 0) {
    const insert = db.prepare(
      "INSERT INTO users (username, password_hash, full_name, role, is_active, agency_id) VALUES (?, ?, ?, ?, 1, ?)",
    );
    const hash = (pw) => bcrypt.hashSync(pw, 10);
    insert.run("admin", hash("admin123"), "Administration", "admin", null);
    insert.run(
      "siege",
      hash("siege123"),
      "Direction des Marches",
      "head_office",
      null,
    );
    insert.run(
      "middleoffice",
      hash("office123"),
      "Middle Office",
      "middle_office",
      null,
    );
    insert.run(
      "backoffice",
      hash("office123"),
      "Back Office",
      "back_office",
      null,
    );
    insert.run(
      "agence000",
      hash("agence123"),
      "Guichet Agence 000",
      "agency",
      "000",
    );
    insert.run(
      "agence001",
      hash("agence123"),
      "Guichet Agence 001",
      "agency",
      "001",
    );
    insert.run(
      "agence045",
      hash("agence123"),
      "Guichet Agence 045",
      "agency",
      "045",
    );
  }

  const adminUser = db
    .prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)")
    .get("admin");
  if (!adminUser) {
    db.prepare(
      "INSERT INTO users (username, password_hash, full_name, role, is_active, agency_id) VALUES (?, ?, ?, ?, 1, ?)",
    ).run(
      "admin",
      bcrypt.hashSync("admin123", 10),
      "Administration",
      "admin",
      null,
    );
  }

  const siegeUser = db
    .prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)")
    .get("siege");
  if (!siegeUser) {
    db.prepare(
      "INSERT INTO users (username, password_hash, full_name, role, is_active, agency_id) VALUES (?, ?, ?, ?, 1, ?)",
    ).run(
      "siege",
      bcrypt.hashSync("siege123", 10),
      "Direction des Marches",
      "head_office",
      null,
    );
  }

  const frontOfficeUser = db
    .prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)")
    .get("frontoffice");
  if (!frontOfficeUser) {
    db.prepare(
      "INSERT INTO users (username, password_hash, full_name, role, is_active, agency_id) VALUES (?, ?, ?, ?, 1, ?)",
    ).run(
      "frontoffice",
      bcrypt.hashSync("office123", 10),
      "Front Office (Siege)",
      "head_office",
      null,
    );
  }

  const middleOfficeUser = db
    .prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)")
    .get("middleoffice");
  if (!middleOfficeUser) {
    db.prepare(
      "INSERT INTO users (username, password_hash, full_name, role, is_active, agency_id) VALUES (?, ?, ?, ?, 1, ?)",
    ).run(
      "middleoffice",
      bcrypt.hashSync("office123", 10),
      "Middle Office",
      "middle_office",
      null,
    );
  }

  const backOfficeUser = db
    .prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)")
    .get("backoffice");
  if (!backOfficeUser) {
    db.prepare(
      "INSERT INTO users (username, password_hash, full_name, role, is_active, agency_id) VALUES (?, ?, ?, ?, 1, ?)",
    ).run(
      "backoffice",
      bcrypt.hashSync("office123", 10),
      "Back Office",
      "back_office",
      null,
    );
  }
}

seed();

module.exports = db;
