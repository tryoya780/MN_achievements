// API для мини-приложения «Ачивки пары».
// Авторизация: заголовок `Authorization: tma <initData>` из Telegram.WebApp.initData,
// подпись проверяется токеном бота, доступ — только для ALLOWED_USER_IDS.

const RARITIES = ['common', 'rare', 'epic', 'legendary'];
const STATUSES = ['unlocked', 'locked'];
const MAX_PHOTO_BYTES = 1.5 * 1024 * 1024;
const INIT_DATA_TTL_SEC = 7 * 24 * 3600;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      const res = await route(request, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      const body = { error: err instanceof HttpError ? err.message : 'Внутренняя ошибка' };
      if (err instanceof HttpError && err.extra) Object.assign(body, err.extra);
      return json(body, status, cors);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (path === '/' || path === '/health') return json({ ok: true });

  const user = await authenticate(request, env);

  if (path === '/api/me' && method === 'GET') {
    return json({ user, settings: await getSettings(env) });
  }

  if (path === '/api/settings' && method === 'PUT') {
    const body = await readJson(request);
    const allowed = { couple_name: 60, start_date: 10, met_date: 10, partner_names: 120 };
    for (const [key, maxLen] of Object.entries(allowed)) {
      if (!(key in body)) continue;
      let value = String(body[key] ?? '').trim().slice(0, maxLen);
      if ((key === 'start_date' || key === 'met_date') && value && !isIsoDate(value)) throw new HttpError(400, 'Неверная дата');
      await env.DB.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).bind(key, value).run();
    }
    return json({ settings: await getSettings(env) });
  }

  if (path === '/api/achievements' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT * FROM achievements
       ORDER BY CASE status WHEN 'unlocked' THEN 0 ELSE 1 END, date DESC, created_at DESC`
    ).all();
    return json({ achievements: results });
  }

  if (path === '/api/achievements' && method === 'POST') {
    const data = validateAchievement(await readJson(request), false);
    const now = new Date().toISOString();
    const item = {
      id: crypto.randomUUID(),
      title: data.title,
      description: data.description ?? '',
      date: data.date ?? null,
      rarity: data.rarity ?? 'common',
      status: data.status ?? 'unlocked',
      icon: data.icon ?? 'heart-fill',
      photo_id: data.photo_id ?? null,
      created_by: user.id,
      created_by_name: user.first_name ?? '',
      created_at: now,
      updated_at: now,
    };
    if (item.status === 'unlocked' && !item.date) item.date = todayIso();
    if (item.status === 'locked') item.date = null;
    await env.DB.prepare(
      `INSERT INTO achievements (id, title, description, date, rarity, status, icon, photo_id,
         created_by, created_by_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(...Object.values(item)).run();
    return json({ achievement: item }, 201);
  }

  const achMatch = path.match(/^\/api\/achievements\/([\w-]+)$/);
  if (achMatch) {
    const id = achMatch[1];
    const existing = await env.DB.prepare('SELECT * FROM achievements WHERE id = ?').bind(id).first();
    if (!existing) throw new HttpError(404, 'Ачивка не найдена');

    if (method === 'PATCH') {
      const data = validateAchievement(await readJson(request), true);
      const next = { ...existing, ...data, updated_at: new Date().toISOString() };
      if (next.status === 'locked') next.date = null;
      if (next.status === 'unlocked' && !next.date) next.date = todayIso();
      await env.DB.prepare(
        `UPDATE achievements SET title=?, description=?, date=?, rarity=?, status=?, icon=?, photo_id=?, updated_at=?
         WHERE id=?`
      ).bind(next.title, next.description, next.date, next.rarity, next.status, next.icon,
        next.photo_id, next.updated_at, id).run();
      if (existing.photo_id && existing.photo_id !== next.photo_id) await deletePhoto(env, existing.photo_id);
      return json({ achievement: next });
    }

    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM achievements WHERE id = ?').bind(id).run();
      if (existing.photo_id) await deletePhoto(env, existing.photo_id);
      return json({ ok: true });
    }
  }

  if (path === '/api/photos' && method === 'POST') {
    const mime = (request.headers.get('Content-Type') || '').split(';')[0];
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw new HttpError(415, 'Нужна картинка JPEG/PNG/WebP');
    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) throw new HttpError(400, 'Пустой файл');
    if (buf.byteLength > MAX_PHOTO_BYTES) throw new HttpError(413, 'Фото слишком большое');
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO photos (id, mime, data, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, mime, buf, new Date().toISOString()).run();
    return json({ photo_id: id }, 201);
  }

  const photoMatch = path.match(/^\/api\/photos\/([\w-]+)$/);
  if (photoMatch && method === 'GET') {
    const row = await env.DB.prepare('SELECT mime, data FROM photos WHERE id = ?').bind(photoMatch[1]).first();
    if (!row) throw new HttpError(404, 'Фото не найдено');
    const bytes = row.data instanceof ArrayBuffer ? row.data : new Uint8Array(row.data);
    return new Response(bytes, {
      headers: { 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=31536000, immutable' },
    });
  }

  throw new HttpError(404, 'Не найдено');
}

// ---------- авторизация ----------

async function authenticate(request, env) {
  const header = request.headers.get('Authorization') || '';

  // Локальная разработка: DEV_USER_ID задаётся только в .dev.vars, в продакшене его нет.
  if (env.DEV_USER_ID && header === 'dev') {
    return { id: Number(env.DEV_USER_ID), first_name: 'Dev' };
  }

  if (!header.startsWith('tma ')) throw new HttpError(401, 'Откройте приложение через Telegram');
  if (!env.BOT_TOKEN) throw new HttpError(500, 'На сервере не задан BOT_TOKEN');

  const user = await verifyInitData(header.slice(4), env.BOT_TOKEN);
  if (!user) throw new HttpError(401, 'Неверная подпись Telegram');

  const allowed = String(env.ALLOWED_USER_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(String(user.id))) {
    throw new HttpError(403, 'Нет доступа', { user_id: user.id });
  }
  return user;
}

async function verifyInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const enc = new TextEncoder();
  const secret = await hmac(enc.encode('WebAppData'), enc.encode(botToken));
  const signature = toHex(await hmac(secret, enc.encode(dataCheckString)));
  if (!timingSafeEqual(signature, hash)) return null;

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > INIT_DATA_TTL_SEC) return null;

  try {
    return JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
}

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- помощники ----------

function validateAchievement(body, partial) {
  const out = {};
  if (!partial || 'title' in body) {
    const title = String(body.title ?? '').trim();
    if (!title) throw new HttpError(400, 'Нужно название');
    out.title = title.slice(0, 80);
  }
  if ('description' in body) out.description = String(body.description ?? '').trim().slice(0, 1000);
  if ('date' in body) {
    const d = body.date ? String(body.date) : null;
    if (d && !isIsoDate(d)) throw new HttpError(400, 'Неверная дата');
    out.date = d;
  }
  if ('rarity' in body) {
    if (!RARITIES.includes(body.rarity)) throw new HttpError(400, 'Неверная редкость');
    out.rarity = body.rarity;
  }
  if ('status' in body) {
    if (!STATUSES.includes(body.status)) throw new HttpError(400, 'Неверный статус');
    out.status = body.status;
  }
  if ('icon' in body) out.icon = String(body.icon || 'heart-fill').slice(0, 32);
  if ('photo_id' in body) {
    const p = body.photo_id ? String(body.photo_id) : null;
    if (p && !/^[\w-]+$/.test(p)) throw new HttpError(400, 'Неверное фото');
    out.photo_id = p;
  }
  return out;
}

async function deletePhoto(env, id) {
  await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id).run();
}

async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Неверный JSON');
  }
}

function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGIN || '*').trim();
  return {
    'Access-Control-Allow-Origin': allowed === '*' ? '*' : allowed === origin ? origin : allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
