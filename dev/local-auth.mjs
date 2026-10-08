// Development server only. Never add this table or authentication path to the
// hosted application: its identity comes from the hosting platform instead.
import {createHash, randomBytes, randomInt, randomUUID, timingSafeEqual} from 'node:crypto';

export const LOCAL_COOKIE_NAME = 'rep_arena_local';
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const MAX_TRACKED_PEERS = 1000;
const digest = value => createHash('sha256').update(value).digest();
const error = (message, status, code, extra = {}) => Object.assign(new Error(message), {status, code, ...extra});

function readToken(cookieHeader) {
  if (typeof cookieHeader !== 'string') return null;
  const values = cookieHeader.split(';').map(part => part.trim()).filter(part => part.startsWith(`${LOCAL_COOKIE_NAME}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(LOCAL_COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

/** Accept only a local node:sqlite connection supplied by the dev server. */
export function createLocalAuth(sqlite, {joinCode, secure = true, clock = Date.now, maxSessions = 100} = {}) {
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 100) {
    throw new TypeError('maxSessions must be an integer between 1 and 100.');
  }
  const launchCode = joinCode ?? String(randomInt(0, 100000000)).padStart(8, '0');
  if (typeof launchCode !== 'string' || !/^\d{8}$/.test(launchCode)) {
    throw new TypeError('joinCode must contain exactly eight digits.');
  }
  const codeDigest = digest(launchCode);
  const attempts = new Map();
  sqlite.exec(`CREATE TABLE IF NOT EXISTS _local_phone_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL
  )`);
  const pruneSessions = sqlite.prepare('DELETE FROM _local_phone_sessions WHERE expires <= ?');
  const findSession = sqlite.prepare('SELECT user_id AS userId, name FROM _local_phone_sessions WHERE token_hash = ? AND expires > ?');
  const removeSession = sqlite.prepare('DELETE FROM _local_phone_sessions WHERE token_hash = ?');
  const insertSession = sqlite.prepare(`INSERT INTO _local_phone_sessions (token_hash, user_id, name, created, expires)
    SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM _local_phone_sessions) < ?`);
  pruneSessions.run(clock());

  function checkAttempts(peer, now) {
    for (const [key, entry] of attempts) {
      if (entry.until <= now) attempts.delete(key);
    }
    const entry = attempts.get(peer);
    if (entry?.count >= MAX_FAILED_ATTEMPTS) {
      throw error('Too many incorrect join codes. Try again in a few minutes.', 429, 'JOIN_THROTTLED', {
        retryAfter: Math.max(1, Math.ceil((entry.until - now) / 1000)),
      });
    }
    return entry;
  }

  const cookieAttributes = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  return {
    get joinCode() { return launchCode; },

    join(data, peer = 'unknown') {
      const now = clock();
      const peerKey = typeof peer === 'string' && peer.length > 0 && peer.length <= 256 ? peer : 'unknown';
      const previous = checkAttempts(peerKey, now);
      const candidate = typeof data?.code === 'string' && data.code.length <= 64 ? data.code : '';
      const matches = timingSafeEqual(digest(candidate), codeDigest);
      if (!matches || !/^\d{8}$/.test(candidate)) {
        if (!previous && attempts.size >= MAX_TRACKED_PEERS) {
          throw error('The local join service is busy. Try again in a few minutes.', 429, 'JOIN_THROTTLED', {retryAfter: 300});
        }
        attempts.set(peerKey, {count: (previous?.count ?? 0) + 1, until: previous?.until ?? now + ATTEMPT_WINDOW_MS});
        throw error('That join code is incorrect. Use the eight-digit code shown on the PC.', 401, 'INVALID_JOIN_CODE');
      }
      const name = typeof data?.name === 'string' ? data.name.trim() : '';
      if (name.length < 2 || name.length > 30 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
        throw error('Use a name between 2 and 30 characters.', 400, 'INVALID_NAME');
      }
      pruneSessions.run(now);
      const token = randomBytes(32).toString('base64url');
      const userId = `local-phone-${randomUUID()}`;
      const result = insertSession.run(digest(token).toString('hex'), userId, name, now, now + SESSION_LIFETIME_MS, maxSessions);
      if (Number(result.changes) !== 1) {
        throw error('This local arena has reached its device limit. Sign out an unused device before joining.', 429, 'SESSION_LIMIT');
      }
      attempts.delete(peerKey);
      return {token, userId, name};
    },

    authenticate(cookieHeader) {
      const token = readToken(cookieHeader);
      if (!token) return null;
      const now = clock();
      pruneSessions.run(now);
      const row = findSession.get(digest(token).toString('hex'), now);
      return row ? {userId: row.userId, name: row.name} : null;
    },

    revoke(cookieHeader) {
      const token = readToken(cookieHeader);
      if (token) removeSession.run(digest(token).toString('hex'));
    },

    cookie(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new TypeError('Invalid session token.');
      return `${LOCAL_COOKIE_NAME}=${token}; Max-Age=${SESSION_LIFETIME_MS / 1000}; ${cookieAttributes}`;
    },

    clearCookie() {
      return `${LOCAL_COOKIE_NAME}=; Max-Age=0; ${cookieAttributes}`;
    },
  };
}
