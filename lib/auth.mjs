// Password gate: one shared password (scrypt hash in .env), signed session cookie.
import crypto from 'node:crypto';

const COOKIE = 'corpus_session';
const MAX_AGE = 30 * 24 * 3600;
const failures = new Map(); // ip -> [timestamps]

export const authEnabled = () => !!process.env.CORPUS_PASSWORD_HASH;
const secret = () => process.env.CORPUS_SESSION_SECRET || process.env.CORPUS_PASSWORD_HASH;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`;
}

function checkPassword(password) {
  const [, salt, hash] = String(process.env.CORPUS_PASSWORD_HASH).split(':');
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(String(password), salt, 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

const sign = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

export function isAuthed(req) {
  if (!authEnabled()) return true;
  const raw = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return false;
  const [exp, nonce, sig] = raw.split('.');
  if (!exp || !nonce || !sig || Number(exp) < Date.now() / 1000) return false;
  const expected = sign(`${exp}.${nonce}`);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

const clientIp = (req) => req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown';
const secure = (req) => req.headers['x-forwarded-proto'] === 'https' || !!req.headers['cf-visitor']?.includes('https');

// Returns { ok, cookie?, error?, status }
export function login(req, password) {
  const ip = clientIp(req);
  const recent = (failures.get(ip) || []).filter(t => t > Date.now() - 15 * 60_000);
  if (recent.length >= 10) return { ok: false, status: 429, error: 'Too many attempts. Try again in a few minutes.' };
  if (!checkPassword(password)) { failures.set(ip, [...recent, Date.now()]); return { ok: false, status: 401, error: 'Wrong password' }; }
  failures.delete(ip);
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const nonce = crypto.randomBytes(12).toString('base64url');
  return { ok: true, status: 200, cookie: `${COOKIE}=${exp}.${nonce}.${sign(`${exp}.${nonce}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure(req) ? '; Secure' : ''}` };
}

export const logoutCookie = (req) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req) ? '; Secure' : ''}`;
