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
//
// Every mutation here is a per-record operation (upsert/delete a single
// row), never a whole-collection load-modify-overwrite. An earlier version
// of this file loaded the entire users array, mutated it in memory, and
// wrote the whole thing back -- under concurrent requests (two
// registrations, or two admin approvals) each writer's read predates the
// other's write, so whichever save() ran last silently discarded every
// other concurrent change. A stress test surfaced this directly: 44
// concurrent registrations collapsed to 1 survivor. Postgres's version of
// that pattern was worse (DELETE FROM users then re-INSERT everything from
// a stale in-memory snapshot), since it could wipe out a concurrent writer's
// row entirely rather than just losing an in-memory push.
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

// --- JSON-mode write serialization ---
//
// The JSON fallback has no real per-record storage -- every mutation still
// has to read the file, change one entry, and write the whole file back.
// True file locking across processes isn't practical here (and this
// fallback is documented as single-process/dev-only), but *within* this
// one process, a simple promise-chained mutex per file closes the actual
// race the stress test hit: concurrent async mutations to the same file
// racing on which read happened first. Queuing them so each fully
// completes (read, modify, write) before the next one's read even starts
// turns "44 concurrent registrations -> 1 survivor" into "44 concurrent
// registrations -> 44 survivors, applied one at a time."
const writeQueues = new Map();
function queueWrite(key, fn) {
    const prev = writeQueues.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    // Once this is the tail of the chain and it settles, drop the entry so
    // the map doesn't grow forever; a new mutation after that just starts
    // a fresh chain from Promise.resolve().
    next.finally(() => {
        if (writeQueues.get(key) === next) writeQueues.delete(key);
    }).catch(() => {}); // the real error still propagates to the caller via `next` itself
    writeQueues.set(key, next);
    return next;
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
//
// loadUsers() remains a full-collection read (reads are not where the race
// was) but every mutation below is scoped to a single user_id.

async function loadUsers() {
    if (!pool) return readJsonFile(USERS_FILE);
    const { rows } = await pool.query('SELECT data FROM users');
    return rows.map(r => r.data);
}

async function getUser(userId) {
    if (!pool) {
        const users = readJsonFile(USERS_FILE);
        return users.find(u => u.userId === userId) || null;
    }
    const { rows } = await pool.query('SELECT data FROM users WHERE user_id = $1', [userId]);
    return rows.length ? rows[0].data : null;
}

// Insert-only: used for registration and admin-account creation, where a
// duplicate userId must be rejected rather than silently overwriting the
// existing account. Returns the created user, or null if that userId
// already exists (caller should respond 409) -- this check-and-insert is
// atomic per call (a single INSERT with a PRIMARY KEY constraint in
// Postgres; the JSON-mode version does its check and push inside one
// queued write so no other write can interleave between them), which is
// what actually closes the "two people register the same userId at the
// same instant" race that a separate load-then-check-then-save never could.
async function createUser(user) {
    if (!pool) {
        return queueWrite('users', () => {
            const users = readJsonFile(USERS_FILE);
            if (users.some(u => u.userId === user.userId)) return null;
            users.push(user);
            writeJsonFile(USERS_FILE, users);
            return user;
        });
    }
    try {
        await pool.query('INSERT INTO users (user_id, data) VALUES ($1, $2)', [user.userId, user]);
        return user;
    } catch (err) {
        if (err.code === '23505') return null; // unique_violation on user_id
        throw err;
    }
}

// Insert-or-update a single user record -- used for approve/reject/edit and
// for persisting a drone's activeAssignment. Never touches any other row.
async function upsertUser(user) {
    if (!pool) {
        return queueWrite('users', () => {
            const users = readJsonFile(USERS_FILE);
            const idx = users.findIndex(u => u.userId === user.userId);
            if (idx === -1) users.push(user);
            else users[idx] = user;
            writeJsonFile(USERS_FILE, users);
            return user;
        });
    }
    await pool.query(
        `INSERT INTO users (user_id, data) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET data = $2`,
        [user.userId, user]
    );
    return user;
}

// Deletes a single user by id. Returns the removed record, or null if no
// such user existed.
async function deleteUser(userId) {
    if (!pool) {
        return queueWrite('users', () => {
            const users = readJsonFile(USERS_FILE);
            const idx = users.findIndex(u => u.userId === userId);
            if (idx === -1) return null;
            const [removed] = users.splice(idx, 1);
            writeJsonFile(USERS_FILE, users);
            return removed;
        });
    }
    const { rows } = await pool.query('DELETE FROM users WHERE user_id = $1 RETURNING data', [userId]);
    return rows.length ? rows[0].data : null;
}

// --- Emergency log ---

async function loadEmergencyLog() {
    if (!pool) return readJsonFile(EMERGENCY_LOG_FILE);
    const { rows } = await pool.query('SELECT data FROM emergency_log');
    return rows.map(r => r.data);
}

async function appendEmergencyLog(entry) {
    if (!pool) {
        return queueWrite('emergency_log', () => {
            const log = readJsonFile(EMERGENCY_LOG_FILE);
            log.push(entry);
            writeJsonFile(EMERGENCY_LOG_FILE, log);
            return entry;
        });
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
        return queueWrite('emergency_log', () => {
            const log = readJsonFile(EMERGENCY_LOG_FILE);
            const entry = log.find(e => e.roomId === roomId && matchStatuses.includes(e.status));
            if (!entry) return null;
            Object.assign(entry, changes);
            writeJsonFile(EMERGENCY_LOG_FILE, log);
            return entry;
        });
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
        return queueWrite('audit_log', () => {
            const log = readJsonFile(AUDIT_LOG_FILE);
            log.push(entry);
            writeJsonFile(AUDIT_LOG_FILE, log);
            return entry;
        });
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
    getUser,
    createUser,
    upsertUser,
    deleteUser,
    loadEmergencyLog,
    appendEmergencyLog,
    updateEmergencyLogByRoom,
    loadAuditLog,
    appendAuditLog
};
