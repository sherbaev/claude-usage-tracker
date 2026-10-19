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
  CREATE TABLE IF NOT EXISTS telegram_bots (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bot_id INTEGER NOT NULL UNIQUE,
    username TEXT NOT NULL,
    token_sealed TEXT NOT NULL,
    webhook_id TEXT NOT NULL UNIQUE,
    webhook_secret TEXT NOT NULL,
    link_code TEXT,
    link_expires_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS telegram_chats (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    linked_at TEXT NOT NULL,
    PRIMARY KEY (user_id, chat_id)
  );
  CREATE TABLE IF NOT EXISTS alert_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settings TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS alert_state (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    state TEXT NOT NULL
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

const toBot = (row) =>
  row && {
    userId: row.user_id,
    botId: row.bot_id,
    username: row.username,
    tokenSealed: row.token_sealed,
    webhookId: row.webhook_id,
    webhookSecret: row.webhook_secret,
    linkCode: row.link_code,
    linkExpiresAt: row.link_expires_at,
    createdAt: row.created_at,
  };

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
    botByUser: db.prepare('SELECT * FROM telegram_bots WHERE user_id = ?'),
    botByWebhook: db.prepare('SELECT * FROM telegram_bots WHERE webhook_id = ?'),
    botByBotId: db.prepare('SELECT * FROM telegram_bots WHERE bot_id = ?'),
    allBots: db.prepare('SELECT * FROM telegram_bots'),
    upsertBot: db.prepare(`
      INSERT INTO telegram_bots (user_id, bot_id, username, token_sealed, webhook_id, webhook_secret, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET bot_id = excluded.bot_id, username = excluded.username,
        token_sealed = excluded.token_sealed, webhook_id = excluded.webhook_id, webhook_secret = excluded.webhook_secret,
        link_code = NULL, link_expires_at = NULL, created_at = excluded.created_at`),
    deleteBot: db.prepare('DELETE FROM telegram_bots WHERE user_id = ?'),
    setLinkCode: db.prepare('UPDATE telegram_bots SET link_code = ?, link_expires_at = ? WHERE user_id = ?'),
    chats: db.prepare('SELECT chat_id AS id, name, linked_at AS linkedAt FROM telegram_chats WHERE user_id = ? ORDER BY linked_at'),
    upsertChat: db.prepare(`
      INSERT INTO telegram_chats (user_id, chat_id, name, linked_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id, chat_id) DO UPDATE SET name = excluded.name`),
    deleteChat: db.prepare('DELETE FROM telegram_chats WHERE user_id = ? AND chat_id = ?'),
    deleteChats: db.prepare('DELETE FROM telegram_chats WHERE user_id = ?'),
    alertSettings: db.prepare('SELECT settings FROM alert_settings WHERE user_id = ?'),
    upsertAlertSettings: db.prepare(`
      INSERT INTO alert_settings (user_id, settings) VALUES (?, ?)
      ON CONFLICT (user_id) DO UPDATE SET settings = excluded.settings`),
    alertState: db.prepare('SELECT state FROM alert_state WHERE user_id = ?'),
    upsertAlertState: db.prepare(`
      INSERT INTO alert_state (user_id, state) VALUES (?, ?)
      ON CONFLICT (user_id) DO UPDATE SET state = excluded.state`),
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
    // ---- Telegram ----
    getBot(userId) {
      return toBot(q.botByUser.get(userId));
    },
    getBotByWebhook(webhookId) {
      return toBot(q.botByWebhook.get(webhookId));
    },
    listBots() {
      return q.allBots.all().map(toBot);
    },
    getBotByBotId(botId) {
      return toBot(q.botByBotId.get(botId));
    },
    saveBot(userId, { botId, username, tokenSealed, webhookId, webhookSecret, createdAt }) {
      q.upsertBot.run(userId, botId, username, tokenSealed, webhookId, webhookSecret, createdAt);
    },
    /** Removes the bot and every chat linked through it. */
    deleteBot(userId) {
      q.deleteChats.run(userId);
      q.deleteBot.run(userId);
    },
    setLinkCode(userId, code, expiresAt) {
      q.setLinkCode.run(code, expiresAt, userId);
    },
    listChats(userId) {
      return q.chats.all(userId);
    },
    addChat(userId, chatId, name, linkedAt) {
      q.upsertChat.run(userId, chatId, name, linkedAt);
    },
    removeChat(userId, chatId) {
      return q.deleteChat.run(userId, chatId).changes > 0;
    },
    getAlertSettings(userId) {
      const row = q.alertSettings.get(userId);
      return row ? JSON.parse(row.settings) : null;
    },
    setAlertSettings(userId, settings) {
      q.upsertAlertSettings.run(userId, JSON.stringify(settings));
    },
    getAlertState(userId) {
      const row = q.alertState.get(userId);
      return row ? JSON.parse(row.state) : {};
    },
    setAlertState(userId, state) {
      q.upsertAlertState.run(userId, JSON.stringify(state));
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
