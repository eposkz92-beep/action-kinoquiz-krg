import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Normalizes phone number to digits only, optionally preserving leading '+'
 * @param {string|number} phone
 * @returns {string}
 */
export function normalizePhone(phone) {
  if (!phone) return '';
  const str = String(phone).trim();
  // Strip common formatting chars (spaces, dashes, parens)
  return str.replace(/[\s\-()]/g, '');
}

/**
 * Normalizes string trimming
 * @param {string|any} str
 * @returns {string}
 */
function cleanStr(str) {
  return typeof str === 'string' ? str.trim() : (str ?? '');
}

/**
 * Initializes and configures the SQLite database schema.
 * @param {string} [dbPath=':memory:'] - Path to SQLite database file or ':memory:'
 * @returns {Object} Database client with DAOs for teams, bookings, contacts, broadcastLogs, and sessions
 */
export function initDatabase(dbPath = ':memory:') {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);

  // Enable foreign keys
  db.exec('PRAGMA foreign_keys = ON;');

  // Enable WAL mode for file-based DBs for better concurrency
  if (dbPath !== ':memory:') {
    try {
      db.exec('PRAGMA journal_mode = WAL;');
    } catch {
      // Ignore if not supported in the current environment
    }
  }

  // Schema DDL
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      captain_name TEXT,
      captain_phone TEXT,
      default_players_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_teams_name ON teams(name);

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      team_name TEXT NOT NULL,
      captain_name TEXT NOT NULL,
      captain_phone TEXT NOT NULL,
      players_count INTEGER NOT NULL,
      game_title TEXT NOT NULL,
      game_date TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'whatsapp',
      status TEXT NOT NULL DEFAULT 'confirmed',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_game_title ON bookings(game_title);
    CREATE INDEX IF NOT EXISTS idx_bookings_game_date ON bookings(game_date);
    CREATE INDEX IF NOT EXISTS idx_bookings_captain_phone ON bookings(captain_phone);
    CREATE INDEX IF NOT EXISTS idx_bookings_created_at ON bookings(created_at);

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL UNIQUE,
      name TEXT,
      team_name TEXT,
      role TEXT DEFAULT 'captain',
      is_subscribed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
    CREATE INDEX IF NOT EXISTS idx_contacts_subscribed ON contacts(is_subscribed);

    CREATE TABLE IF NOT EXISTS broadcast_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign TEXT,
      recipient_phone TEXT NOT NULL,
      recipient_name TEXT,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent',
      error TEXT,
      sent_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_broadcast_logs_campaign ON broadcast_logs(campaign);
    CREATE INDEX IF NOT EXISTS idx_broadcast_logs_recipient ON broadcast_logs(recipient_phone);
    CREATE INDEX IF NOT EXISTS idx_broadcast_logs_sent_at ON broadcast_logs(sent_at);

    CREATE TABLE IF NOT EXISTS user_sessions (
      jid TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'IDLE',
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // Prepared statements for teams
  const stmtTeamUpsert = db.prepare(`
    INSERT INTO teams (name, captain_name, captain_phone, default_players_count, updated_at)
    VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT(name) DO UPDATE SET
      captain_name = coalesce(excluded.captain_name, teams.captain_name),
      captain_phone = coalesce(excluded.captain_phone, teams.captain_phone),
      default_players_count = CASE WHEN excluded.default_players_count > 0 THEN excluded.default_players_count ELSE teams.default_players_count END,
      updated_at = datetime('now', 'localtime')
    RETURNING *;
  `);
  const stmtTeamGetByName = db.prepare('SELECT * FROM teams WHERE name = ? COLLATE NOCASE LIMIT 1;');
  const stmtTeamGetById = db.prepare('SELECT * FROM teams WHERE id = ?;');
  const stmtTeamList = db.prepare('SELECT * FROM teams ORDER BY name ASC LIMIT ?;');

  // Prepared statements for bookings
  const stmtBookingInsert = db.prepare(`
    INSERT INTO bookings (team_id, team_name, captain_name, captain_phone, players_count, game_title, game_date, source, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *;
  `);
  const stmtBookingGetById = db.prepare('SELECT * FROM bookings WHERE id = ?;');
  const stmtBookingListAll = db.prepare('SELECT * FROM bookings ORDER BY created_at DESC LIMIT ?;');
  const stmtBookingListByGame = db.prepare('SELECT * FROM bookings WHERE game_title = ? ORDER BY created_at DESC LIMIT ?;');

  // Prepared statements for contacts
  const stmtContactUpsert = db.prepare(`
    INSERT INTO contacts (phone, name, team_name, role, updated_at)
    VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT(phone) DO UPDATE SET
      name = coalesce(excluded.name, contacts.name),
      team_name = coalesce(excluded.team_name, contacts.team_name),
      role = coalesce(excluded.role, contacts.role),
      updated_at = datetime('now', 'localtime')
    RETURNING *;
  `);
  const stmtContactSetSub = db.prepare(`
    UPDATE contacts
    SET is_subscribed = ?, updated_at = datetime('now', 'localtime')
    WHERE phone = ?;
  `);
  const stmtContactListBroadcast = db.prepare('SELECT * FROM contacts WHERE is_subscribed = 1 ORDER BY id ASC;');
  const stmtContactListAll = db.prepare('SELECT * FROM contacts ORDER BY id ASC LIMIT ?;');
  const stmtContactGetByPhone = db.prepare('SELECT * FROM contacts WHERE phone = ? LIMIT 1;');

  // Prepared statements for broadcast_logs
  const stmtLogInsert = db.prepare(`
    INSERT INTO broadcast_logs (campaign, recipient_phone, recipient_name, message, status, error)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING *;
  `);
  const stmtLogListAll = db.prepare('SELECT * FROM broadcast_logs ORDER BY sent_at DESC LIMIT ?;');
  const stmtLogListByCampaign = db.prepare('SELECT * FROM broadcast_logs WHERE campaign = ? ORDER BY sent_at DESC LIMIT ?;');

  // Prepared statements for user_sessions
  const stmtSessionGet = db.prepare('SELECT * FROM user_sessions WHERE jid = ? LIMIT 1;');
  const stmtSessionUpsert = db.prepare(`
    INSERT INTO user_sessions (jid, state, data, updated_at)
    VALUES (?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT(jid) DO UPDATE SET
      state = excluded.state,
      data = excluded.data,
      updated_at = datetime('now', 'localtime');
  `);
  const stmtSessionDelete = db.prepare('DELETE FROM user_sessions WHERE jid = ?;');

  // DAO object implementations
  const teams = {
    upsert({ name, captainName = null, captainPhone = null, defaultPlayersCount = 0 }) {
      const cleanName = cleanStr(name);
      if (!cleanName) throw new Error('Team name is required');
      return stmtTeamUpsert.get(
        cleanName,
        cleanStr(captainName) || null,
        normalizePhone(captainPhone) || null,
        Number(defaultPlayersCount) || 0
      );
    },
    getByName(name) {
      const cleanName = cleanStr(name);
      if (!cleanName) return null;
      return stmtTeamGetByName.get(cleanName) || null;
    },
    getById(id) {
      return stmtTeamGetById.get(Number(id)) || null;
    },
    list({ limit = 100 } = {}) {
      return stmtTeamList.all(Number(limit) || 100);
    }
  };

  const contacts = {
    upsert({ phone, name = null, teamName = null, role = 'captain' }) {
      const normPhone = normalizePhone(phone);
      if (!normPhone) throw new Error('Phone is required for contact');
      return stmtContactUpsert.get(
        normPhone,
        cleanStr(name) || null,
        cleanStr(teamName) || null,
        cleanStr(role) || 'captain'
      );
    },
    setSubscription(phone, subscribed) {
      const normPhone = normalizePhone(phone);
      if (!normPhone) return;
      const subVal = subscribed ? 1 : 0;
      stmtContactSetSub.run(subVal, normPhone);
    },
    listForBroadcast() {
      return stmtContactListBroadcast.all();
    },
    list({ limit = 1000 } = {}) {
      return stmtContactListAll.all(Number(limit) || 1000);
    },
    getByPhone(phone) {
      const normPhone = normalizePhone(phone);
      if (!normPhone) return null;
      return stmtContactGetByPhone.get(normPhone) || null;
    }
  };

  const bookings = {
    create({
      teamName,
      captainName,
      captainPhone,
      playersCount,
      gameTitle,
      gameDate,
      source = 'whatsapp',
      status = 'confirmed',
      notes = ''
    }) {
      const cleanTeam = cleanStr(teamName);
      const cleanCaptain = cleanStr(captainName);
      const normPhone = normalizePhone(captainPhone);
      const numPlayers = Number(playersCount) || 0;
      const cleanGame = cleanStr(gameTitle);
      const cleanDate = cleanStr(gameDate);

      if (!cleanTeam) throw new Error('Team name is required');
      if (!cleanCaptain) throw new Error('Captain name is required');
      if (!normPhone) throw new Error('Captain phone is required');
      if (numPlayers < 1) throw new Error('Valid players count is required');
      if (!cleanGame) throw new Error('Game title is required');

      // Auto-upsert team and contact records
      let teamId = null;
      try {
        const teamRec = teams.upsert({
          name: cleanTeam,
          captainName: cleanCaptain,
          captainPhone: normPhone,
          defaultPlayersCount: numPlayers
        });
        if (teamRec && teamRec.id) teamId = teamRec.id;
      } catch {
        // Fallback if team upsert fails
      }

      try {
        contacts.upsert({
          phone: normPhone,
          name: cleanCaptain,
          teamName: cleanTeam,
          role: 'captain'
        });
      } catch {
        // Fallback if contact upsert fails
      }

      return stmtBookingInsert.get(
        teamId,
        cleanTeam,
        cleanCaptain,
        normPhone,
        numPlayers,
        cleanGame,
        cleanDate,
        cleanStr(source) || 'whatsapp',
        cleanStr(status) || 'confirmed',
        cleanStr(notes) || null
      );
    },
    getById(id) {
      return stmtBookingGetById.get(Number(id)) || null;
    },
    list({ gameTitle, gameDate, status, limit = 100 } = {}) {
      const lim = Number(limit) || 100;
      const conditions = [];
      const params = [];
      if (gameTitle) {
        conditions.push('game_title = ?');
        params.push(cleanStr(gameTitle));
      }
      if (gameDate) {
        conditions.push('game_date = ?');
        params.push(cleanStr(gameDate));
      }
      if (status) {
        conditions.push('status = ?');
        params.push(cleanStr(status));
      }
      if (conditions.length === 0) {
        return stmtBookingListAll.all(lim);
      }
      if (conditions.length === 1 && gameTitle && !gameDate && !status) {
        return stmtBookingListByGame.all(cleanStr(gameTitle), lim);
      }
      const sql = `SELECT * FROM bookings WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?;`;
      return db.prepare(sql).all(...params, lim);
    }
  };

  const broadcastLogs = {
    create({ campaign = null, recipientPhone, recipientName = null, message, status = 'sent', error = null }) {
      const normPhone = normalizePhone(recipientPhone);
      return stmtLogInsert.get(
        cleanStr(campaign) || null,
        normPhone,
        cleanStr(recipientName) || null,
        String(message || ''),
        cleanStr(status) || 'sent',
        error ? String(error) : null
      );
    },
    list({ campaign, limit = 100 } = {}) {
      const lim = Number(limit) || 100;
      if (campaign) {
        return stmtLogListByCampaign.all(cleanStr(campaign), lim);
      }
      return stmtLogListAll.all(lim);
    }
  };

  const sessions = {
    get(jid) {
      if (!jid) return null;
      const row = stmtSessionGet.get(String(jid));
      if (!row) return null;
      let data = {};
      try {
        data = JSON.parse(row.data || '{}');
      } catch {
        data = {};
      }
      return {
        jid: row.jid,
        state: row.state,
        data,
        created_at: row.created_at,
        updated_at: row.updated_at
      };
    },
    set(jid, state, data = {}) {
      if (!jid) return;
      const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
      stmtSessionUpsert.run(String(jid), cleanStr(state) || 'IDLE', jsonStr);
    },
    clear(jid) {
      if (!jid) return;
      stmtSessionDelete.run(String(jid));
    }
  };

  return {
    db,
    teams,
    bookings,
    contacts,
    broadcastLogs,
    sessions,
    close() {
      db.close();
    }
  };
}

export default initDatabase;
