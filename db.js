// --- Persistent storage layer ---
//
// When DATABASE_URL is set (a free-tier Postgres from any provider --
// Neon, Supabase, Render Postgres, ElephantSQL, etc. all work, since they
// all speak standard Postgres wire protocol), all data is stored there,
// so registered accounts, the emergency history, and the audit trail
// survive redeploys and restarts.
//
// When DATABASE_URL is NOT set, storage falls back to the local JSON
// files this app used before (users.json / emergency-log.json /
// audit-log.json) -- convenient for local development, but note this
// fallback does NOT survive a redeploy on platforms with an ephemeral
// filesystem (e.g. Render's free tier). Set DATABASE_URL in production.
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL || null;

let pool = null;
if (DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
        connectionString: DATABASE_URL,
        // Most free-tier Postgres providers require SSL and present a
        // certificate not in Node's default trust store; this app's
        // threat model (small internal tool, no sensitive financial data)
        // accepts that trade-off the same way most simple deployments do.
        ssl: { rejectUnauthorized: false },
        // A dropped idle connection shouldn't crash the whole process --
        // without this handler, an 'error' event with no listener is a
        // fatal uncaught exception in Node.
        connectionTimeoutMillis: 15000
    });
    pool.on('error', (err) => {
        console.error('Unexpected database pool error:', err.message);
    });

    // Free-tier Postgres (Neon included) auto-suspends the underlying
    // compute after a few minutes of inactivity; the next query then pays
    // a multi-second "cold start" cost, which can be slow enough to time
    // out a request. A lightweight keep-alive query on a shorter interval
    // than the provider's suspend timeout keeps the connection warm so
    // real requests don't pay that cost.
    setInterval(() => {
        pool.query('SELECT 1').catch(err => {
            console.error('Keep-alive ping failed:', err.message);
        });
    }, 4 * 60 * 1000);
}

const USERS_FILE = path.join(__dirname, 'users.json');
const EMERGENCY_LOG_FILE = path.join(__dirname, 'emergency-log.json');
const AUDIT_LOG_FILE = path.join(__dirname, 'audit-log.json');

function readJsonFile(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        return [];
    }
}

function writeJsonFile(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

async function initSchema() {
    if (!pool) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            data JSONB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS emergency_log (
            id TEXT PRIMARY KEY,
            data JSONB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit_log (
            id TEXT PRIMARY KEY,
            data JSONB NOT NULL
        );
    `);
}

// --- Users ---

async function loadUsers() {
    if (!pool) return readJsonFile(USERS_FILE);
    const { rows } = await pool.query('SELECT data FROM users');
    return rows.map(r => r.data);
}

async function saveUsers(users) {
    if (!pool) return writeJsonFile(USERS_FILE, users);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM users');
        for (const user of users) {
            await client.query(
                'INSERT INTO users (user_id, data) VALUES ($1, $2)',
                [user.userId, user]
            );
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// --- Emergency log ---

async function loadEmergencyLog() {
    if (!pool) return readJsonFile(EMERGENCY_LOG_FILE);
    const { rows } = await pool.query('SELECT data FROM emergency_log');
    return rows.map(r => r.data);
}

async function appendEmergencyLog(entry) {
    if (!pool) {
        const log = readJsonFile(EMERGENCY_LOG_FILE);
        log.push(entry);
        writeJsonFile(EMERGENCY_LOG_FILE, log);
        return entry;
    }
    await pool.query(
        'INSERT INTO emergency_log (id, data) VALUES ($1, $2)',
        [entry.id, entry]
    );
    return entry;
}

// Updates the first log entry matching roomId + one of the given current
// statuses, and returns it (or null if no match was found).
async function updateEmergencyLogByRoom(roomId, matchStatuses, changes) {
    if (!pool) {
        const log = readJsonFile(EMERGENCY_LOG_FILE);
        const entry = log.find(e => e.roomId === roomId && matchStatuses.includes(e.status));
        if (!entry) return null;
        Object.assign(entry, changes);
        writeJsonFile(EMERGENCY_LOG_FILE, log);
        return entry;
    }
    const { rows } = await pool.query(
        `SELECT id, data FROM emergency_log WHERE data->>'roomId' = $1 AND data->>'status' = ANY($2::text[])`,
        [roomId, matchStatuses]
    );
    if (!rows.length) return null;
    const { id, data: entry } = rows[0];
    Object.assign(entry, changes);
    await pool.query('UPDATE emergency_log SET data = $1 WHERE id = $2', [entry, id]);
    return entry;
}

// --- Audit log ---

async function loadAuditLog() {
    if (!pool) return readJsonFile(AUDIT_LOG_FILE);
    const { rows } = await pool.query('SELECT data FROM audit_log');
    return rows.map(r => r.data);
}

async function appendAuditLog(entry) {
    if (!pool) {
        const log = readJsonFile(AUDIT_LOG_FILE);
        log.push(entry);
        writeJsonFile(AUDIT_LOG_FILE, log);
        return entry;
    }
    await pool.query(
        'INSERT INTO audit_log (id, data) VALUES ($1, $2)',
        [entry.id, entry]
    );
    return entry;
}

module.exports = {
    isPersistent: !!pool,
    initSchema,
    loadUsers,
    saveUsers,
    loadEmergencyLog,
    appendEmergencyLog,
    updateEmergencyLogByRoom,
    loadAuditLog,
    appendAuditLog
};
