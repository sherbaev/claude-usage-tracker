// SQLite repository (node:sqlite, no dependencies). Users, their devices' latest reports, per-device limits.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT
  );
  CREATE TABLE IF NOT EXISTS devices (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    report TEXT NOT NULL,
    reported_at TEXT NOT NULL,
    PRIMARY KEY (user_id, name)
  );
  CREATE TABLE IF NOT EXISTS device_limits (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    five_hour REAL,
    seven_day REAL,
    enforce INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, name)
  );
`;

// Columns added after a table first shipped. CREATE TABLE IF NOT EXISTS never alters an existing
// table, so databases from older versions get them here. Append only; never edit past entries.
const ADDED_COLUMNS = [['users', 'last_seen_at', 'TEXT']];

function addMissingColumns(db) {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

const toLimits = (row) => ({ fiveHour: row.five_hour, sevenDay: row.seven_day, enforce: row.enforce === 1 });

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  addMissingColumns(db);

  const q = {
    insertUser: db.prepare('INSERT INTO users (token_hash, created_at) VALUES (?, ?)'),
    userByHash: db.prepare('SELECT id, created_at AS createdAt FROM users WHERE token_hash = ?'),
    touchUser: db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?'),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    devices: db.prepare('SELECT report FROM devices WHERE user_id = ? ORDER BY name'),
    deviceExists: db.prepare('SELECT 1 FROM devices WHERE user_id = ? AND name = ?'),
    countDevices: db.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?'),
    countActive: db.prepare('SELECT COUNT(DISTINCT user_id) AS users, COUNT(*) AS devices FROM devices WHERE reported_at >= ?'),
    upsertDevice: db.prepare(`
      INSERT INTO devices (user_id, name, report, reported_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id, name) DO UPDATE SET report = excluded.report, reported_at = excluded.reported_at`),
    deleteDevice: db.prepare('DELETE FROM devices WHERE user_id = ? AND name = ?'),
    limits: db.prepare('SELECT name, five_hour, seven_day, enforce FROM device_limits WHERE user_id = ?'),
    upsertLimits: db.prepare(`
      INSERT INTO device_limits (user_id, name, five_hour, seven_day, enforce) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, name) DO UPDATE SET
        five_hour = excluded.five_hour, seven_day = excluded.seven_day, enforce = excluded.enforce`),
    deleteLimits: db.prepare('DELETE FROM device_limits WHERE user_id = ? AND name = ?'),
    pruneDevices: db.prepare('DELETE FROM devices WHERE reported_at < ?'),
    pruneOrphanLimits: db.prepare(`
      DELETE FROM device_limits WHERE NOT EXISTS (
        SELECT 1 FROM devices d WHERE d.user_id = device_limits.user_id AND d.name = device_limits.name)`),
    pruneUsers: db.prepare(`
      DELETE FROM users WHERE (last_seen_at IS NULL AND created_at < ?) OR last_seen_at < ?`),
  };

  return {
    createUser(tokenHash, createdAt) {
      return Number(q.insertUser.run(tokenHash, createdAt).lastInsertRowid);
    },
    findUserByTokenHash(tokenHash) {
      const row = q.userByHash.get(tokenHash);
      return row ? { id: row.id, createdAt: row.createdAt } : null;
    },
    countUsers() {
      return q.countUsers.get().n;
    },
    deleteUser(userId) {
      q.deleteUser.run(userId);
    },
    listReports(userId) {
      return q.devices.all(userId).map((row) => JSON.parse(row.report));
    },
    hasDevice(userId, name) {
      return q.deviceExists.get(userId, name) !== undefined;
    },
    countDevices(userId) {
      return q.countDevices.get(userId).n;
    },
    /** Accounts and devices with a report at or after `since` (ISO). Aggregates only. */
    countActive(since) {
      const row = q.countActive.get(since);
      return { users: row.users, devices: row.devices };
    },
    upsertReport(userId, report) {
      q.upsertDevice.run(userId, report.device, JSON.stringify(report), report.reportedAt);
      q.touchUser.run(report.reportedAt, userId);
    },
    deleteDevice(userId, name) {
      q.deleteLimits.run(userId, name);
      return q.deleteDevice.run(userId, name).changes > 0;
    },
    listLimits(userId) {
      return Object.fromEntries(q.limits.all(userId).map((row) => [row.name, toLimits(row)]));
    },
    setLimits(userId, name, limits) {
      q.upsertLimits.run(userId, name, limits.fiveHour, limits.sevenDay, limits.enforce ? 1 : 0);
    },
    /** Drops stale device reports, their limits, and accounts that were never or long not used. */
    prune({ reportsBefore, unusedUsersBefore, inactiveUsersBefore }) {
      const devices = q.pruneDevices.run(reportsBefore).changes;
      q.pruneOrphanLimits.run();
      const users = q.pruneUsers.run(unusedUsersBefore, inactiveUsersBefore).changes;
      return { devices, users };
    },
    close() {
      db.close();
    },
  };
}
