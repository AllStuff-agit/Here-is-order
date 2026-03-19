import { Hono } from 'hono';

type Env = {
  Bindings: {
    DB: D1Database;
  };
};

type SessionUser = {
  id: number;
  username: string;
  name: string;
};

type OrderStatus = 'draft' | 'ordered' | 'partially_received' | 'fully_received' | 'canceled';

type AppVariables = {
  user?: SessionUser;
};


const app = new Hono<{ Bindings: Env['Bindings']; Variables: AppVariables }>();

const AUTH_COOKIE = 'isorder_sid';
const SESSION_DAYS = 30;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;
const PASSWORD_HASH_SCHEME = 'pbkdf2_sha256';
const PASSWORD_HASH_ITERATIONS = 600_000;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BITS = 256;
const PUBLIC_API_PATHS = new Set(['/api/auth/login', '/health', '/login']);
const ORDER_STATUSES = ['draft', 'ordered', 'partially_received', 'fully_received', 'canceled'] as const;

function apiOk<T>(data: T) {
  return { ok: true, data };
}

function apiErr(code: string, message: string, status = 400) {
  return {
    ok: false,
    error: { code, message },
  } as const;
}

function parseCookie(cookieHeader: string | undefined) {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;

  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = decodeURIComponent(pair.slice(idx + 1).trim());
    result[key] = value;
  }

  return result;
}

function parseIntValue(raw: string | undefined, fallback?: number) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) ? n : fallback;
}

function parseIntPositive(raw: string | undefined, fallback: number | null = null) {
  const n = parseIntValue(raw, null);
  if (n === null || n <= 0) return fallback;
  return n;
}

async function sha256Hex(value: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string) {
  if (!hex || hex.length % 2 !== 0) {
    throw new Error('INVALID_HEX');
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const value = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(value)) {
      throw new Error('INVALID_HEX');
    }
    bytes[i] = value;
  }

  return bytes;
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function derivePasswordHash(value: string, salt: Uint8Array, iterations = PASSWORD_HASH_ITERATIONS) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(value), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    key,
    PASSWORD_HASH_BITS,
  );

  return bytesToHex(new Uint8Array(bits));
}

async function hashPassword(value: string) {
  const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
  const hash = await derivePasswordHash(value, salt);
  return `${PASSWORD_HASH_SCHEME}$${PASSWORD_HASH_ITERATIONS}$${bytesToHex(salt)}$${hash}`;
}

async function verifyPassword(value: string, storedHash: string) {
  if (storedHash.startsWith(`${PASSWORD_HASH_SCHEME}$`)) {
    const [, rawIterations, saltHex, expectedHash] = storedHash.split('$');
    const iterations = Number.parseInt(rawIterations, 10);
    if (!iterations || !saltHex || !expectedHash) {
      return { valid: false, upgradedHash: null };
    }

    try {
      const actualHash = await derivePasswordHash(value, hexToBytes(saltHex), iterations);
      if (!constantTimeEqual(actualHash, expectedHash)) {
        return { valid: false, upgradedHash: null };
      }
      // 반복횟수가 현재 기준보다 낮으면 업그레이드
      const upgradedHash = iterations < PASSWORD_HASH_ITERATIONS
        ? await hashPassword(value)
        : null;
      return { valid: true, upgradedHash };
    } catch {
      return { valid: false, upgradedHash: null };
    }
  }

  const legacyHash = await sha256Hex(value);
  if (!constantTimeEqual(legacyHash, storedHash)) {
    return { valid: false, upgradedHash: null };
  }

  return {
    valid: true,
    upgradedHash: await hashPassword(value),
  };
}

async function getSessionUser(c: any): Promise<SessionUser | null> {
  const cookies = parseCookie(c.req.header('Cookie'));
  const sid = cookies[AUTH_COOKIE];
  if (!sid) return null;

  const row = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.name
       FROM users u
       JOIN sessions s ON s.user_id = u.id
      WHERE s.token = ?
        AND u.is_active = 1
        AND u.is_deleted = 0
        AND s.expires_at > datetime('now')`
  )
    .bind(sid)
    .first();

  if (!row) return null;
  return row as SessionUser;
}

async function requireAuth(c: any, next: () => Promise<void>) {
  const user = await getSessionUser(c);
  if (!user) {
    return c.json(apiErr('UNAUTHORIZED', '로그인이 필요합니다.'), 401);
  }
  c.set('user', user);
  await next();
}

function authSetCookie(token: string, secure: boolean) {
  return [
    `Set-Cookie`,
    `${AUTH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_SECONDS}; SameSite=Strict${secure ? '; Secure' : ''}`,
  ] as const;
}

function authClearCookie(secure: boolean) {
  return [
    `Set-Cookie`,
    `${AUTH_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict${secure ? '; Secure' : ''}`,
  ] as const;
}

async function writeAudit(
  db: D1Database,
  actorUserId: number | null,
  action: string,
  entityType: string,
  entityId: number | null,
  before?: unknown,
  after?: unknown,
) {
  await db
    .prepare(
      `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      actorUserId,
      action,
      entityType,
      entityId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null
    )
    .run();
}

function isOrderStatus(status: string): status is OrderStatus {
  return ORDER_STATUSES.includes(status as OrderStatus);
}

app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  if (PUBLIC_API_PATHS.has(path)) {
    return next();
  }
  return requireAuth(c, next);
});

app.get('/health', (c) => c.json(apiOk({ ok: true, ts: new Date().toISOString() })));

app.post('/api/auth/login', async (c) => {
  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const username = String(payload.username || '').trim();
  const password = String(payload.password || '');

  if (!username || !password) {
    return c.json(apiErr('INVALID_INPUT', 'username/password를 입력해주세요.'), 400);
  }

  const user = await c.env.DB.prepare(`
    SELECT id, username, password_hash, name
      FROM users
     WHERE username = ?
       AND is_active = 1
       AND is_deleted = 0
  `)
    .bind(username)
    .first<{ id: number; username: string; password_hash: string; name: string }>();

  if (!user) {
    return c.json(apiErr('INVALID_CREDENTIALS', '계정이 존재하지 않거나 비활성입니다.'), 401);
  }

  const passwordCheck = await verifyPassword(password, user.password_hash);
  if (!passwordCheck.valid) {
    return c.json(apiErr('INVALID_CREDENTIALS', '아이디 또는 비밀번호가 올바르지 않습니다.'), 401);
  }

  if (passwordCheck.upgradedHash) {
    await c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = datetime("now") WHERE id = ?')
      .bind(passwordCheck.upgradedHash, user.id)
      .run();
  }

  const sid = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();

  await c.env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`
  )
    .bind(sid, user.id, expiresAt)
    .run();

  const [header, value] = authSetCookie(sid, new URL(c.req.url).protocol === 'https:');
  c.res.headers.set(header, value);

  await writeAudit(c.env.DB, user.id, 'login', 'user', user.id, undefined, { username: user.username });

  return c.json(apiOk({ user: { id: user.id, username: user.username, name: user.name } }));
});

app.post('/api/auth/logout', async (c) => {
  const user = c.get('user') as SessionUser;
  const cookies = parseCookie(c.req.header('Cookie'));
  const sid = cookies[AUTH_COOKIE];

  if (sid) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token = ? AND user_id = ?')
      .bind(sid, user.id)
      .run();
  }

  const [header, value] = authClearCookie(new URL(c.req.url).protocol === 'https:');
  c.res.headers.set(header, value);

  await writeAudit(c.env.DB, user.id, 'logout', 'user', user.id);
  return c.json(apiOk({ loggedOut: true }));
});

app.get('/api/categories', async (c) => {
  const includeDeleted = c.req.query('includeDeleted') === 'true';
  const rows = await c.env.DB.prepare(
    `SELECT id, name, description
       FROM item_categories
      WHERE ${includeDeleted ? '1=1' : 'is_deleted = 0'}
      ORDER BY name ASC`
  )
    .all<{ id: number; name: string; description: string | null }>();

  return c.json(apiOk(rows.results));
});

app.post('/api/categories', async (c) => {
  const user = c.get('user') as SessionUser;
  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const name = String(payload.name || '').trim();
  const description = payload.description != null ? String(payload.description) : null;

  if (!name) {
    return c.json(apiErr('INVALID_INPUT', '카테고리명은 필수입니다.'), 400);
  }

  const existing = await c.env.DB.prepare('SELECT id FROM item_categories WHERE name = ? AND is_deleted = 0')
    .bind(name)
    .first<{ id: number }>();
  if (existing) {
    return c.json(apiErr('DUPLICATE', '동일한 이름의 카테고리가 이미 존재합니다.'), 409);
  }

  const result = await c.env.DB.prepare(
    `INSERT INTO item_categories (name, description) VALUES (?, ?)`
  ).bind(name, description).run();

  const id = Number(result.meta.last_row_id);
  const row = await c.env.DB.prepare('SELECT id, name, description FROM item_categories WHERE id = ?')
    .bind(id)
    .first();

  await writeAudit(c.env.DB, user.id, 'create', 'category', id, undefined, row);
  return c.json(apiOk(row));
});

app.patch('/api/categories/:id', async (c) => {
  const user = c.get('user') as SessionUser;
  const id = parseIntValue(c.req.param('id'), null);
  if (!id) return c.json(apiErr('INVALID_INPUT', '카테고리 ID가 유효하지 않습니다.'), 400);

  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const patches: string[] = [];
  const params: unknown[] = [];

  if ('name' in payload) {
    const name = String(payload.name || '').trim();
    if (!name) return c.json(apiErr('INVALID_INPUT', '카테고리명은 빈 값이 될 수 없습니다.'), 400);
    patches.push('name = ?');
    params.push(name);
  }

  if ('description' in payload) {
    const description = payload.description == null ? null : String(payload.description);
    patches.push('description = ?');
    params.push(description);
  }

  if (!patches.length) {
    return c.json(apiErr('INVALID_INPUT', '수정할 데이터가 없습니다.'), 400);
  }

  const before = await c.env.DB.prepare('SELECT id, name, description, is_deleted FROM item_categories WHERE id = ?')
    .bind(id)
    .first();
  if (!before) return c.json(apiErr('NOT_FOUND', '카테고리를 찾지 못했습니다.'), 404);

  const q = `UPDATE item_categories SET ${patches.join(', ')}, updated_at = datetime('now') WHERE id = ?`;
  await c.env.DB.prepare(q).bind(...params, id).run();

  const after = await c.env.DB.prepare('SELECT id, name, description, is_deleted FROM item_categories WHERE id = ?')
    .bind(id)
    .first();

  await writeAudit(c.env.DB, user.id, 'update', 'category', id, before, after);
  return c.json(apiOk(after));
});

app.delete('/api/categories/:id', async (c) => {
  const user = c.get('user') as SessionUser;
  const id = parseIntValue(c.req.param('id'), null);
  if (!id) return c.json(apiErr('INVALID_INPUT', '카테고리 ID가 유효하지 않습니다.'), 400);

  const before = await c.env.DB.prepare('SELECT id, name, is_deleted FROM item_categories WHERE id = ?')
    .bind(id)
    .first();
  if (!before) return c.json(apiErr('NOT_FOUND', '카테고리를 찾지 못했습니다.'), 404);

  await c.env.DB.prepare('UPDATE item_categories SET is_deleted = 1, deleted_at = datetime("now"), updated_at = datetime("now") WHERE id = ?')
    .bind(id)
    .run();

  const after = await c.env.DB.prepare('SELECT id, name, is_deleted FROM item_categories WHERE id = ?')
    .bind(id)
    .first();

  await writeAudit(c.env.DB, user.id, 'soft_delete', 'category', id, before, after);
  return c.json(apiOk({ deleted: true }));
});

app.get('/api/items', async (c) => {
  const q = c.req.query('q')?.trim() || '';
  const categoryId = parseIntValue(c.req.query('categoryId'), null);
  const needReorder = c.req.query('needReorder') === 'true';
  const includeDeleted = c.req.query('includeDeleted') === 'true';

  const whereClauses = [] as string[];
  const params: unknown[] = [];

  if (!includeDeleted) {
    whereClauses.push('i.is_deleted = 0');
  }

  if (categoryId) {
    whereClauses.push('i.category_id = ?');
    params.push(categoryId);
  }

  if (needReorder) {
    whereClauses.push('i.safety_stock > 0');
    whereClauses.push('i.current_stock <= i.safety_stock');
  }

  if (q) {
    whereClauses.push('(i.name LIKE ? ESCAPE \'\\\\\' OR i.spec LIKE ? ESCAPE \'\\\\\' OR c.name LIKE ? ESCAPE \'\\\\\')');
    const escaped = q.replace(/[%_\\]/g, '\\$&');
    const like = `%${escaped}%`;
    params.push(like, like, like);
  }

  const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const rows = await c.env.DB.prepare(
    `SELECT i.id, i.category_id, c.name AS category_name, i.name, i.spec, i.unit, i.safety_stock,
            i.min_stock, i.current_stock, i.unit_price, i.memo, i.created_at, i.updated_at,
            MAX(0, i.safety_stock - i.current_stock) AS suggested_qty
       FROM items i
       LEFT JOIN item_categories c ON c.id = i.category_id
       ${where}
       ORDER BY c.name ASC, i.name ASC`
  )
    .bind(...params)
    .all();

  const items = rows.results as Array<Record<string, unknown>>;
  return c.json(apiOk(items));
});

app.post('/api/items', async (c) => {
  const user = c.get('user') as SessionUser;
  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const categoryId = parseIntValue(payload.category_id == null ? undefined : String(payload.category_id), null);
  const name = String(payload.name || '').trim();
  const spec = String(payload.spec || '').trim();
  const safetyStock = parseIntValue(payload.safety_stock == null ? '0' : String(payload.safety_stock), 0);
  const minStock = parseIntValue(payload.min_stock == null ? '0' : String(payload.min_stock), 0);
  const currentStock = parseIntValue(payload.current_stock == null ? '0' : String(payload.current_stock), 0);
  const unitPrice = parseIntValue(payload.unit_price == null ? '0' : String(payload.unit_price), 0);
  const memo = payload.memo == null ? null : String(payload.memo);

  if (!name) {
    return c.json(apiErr('INVALID_INPUT', '품목명은 필수입니다.'), 400);
  }
  if (safetyStock < 0 || minStock < 0 || currentStock < 0 || unitPrice < 0) {
    return c.json(apiErr('INVALID_INPUT', '수량/금액은 0 이상이어야 합니다.'), 400);
  }

  const existing = await c.env.DB.prepare(
    `SELECT id FROM items WHERE name = ? AND COALESCE(spec, '') = ? AND is_deleted = 0`
  )
    .bind(name, spec)
    .first();
  if (existing) {
    return c.json(apiErr('DUPLICATE', '이미 동일한 품목이 존재합니다.'), 409);
  }

  const inserted = await c.env.DB.prepare(
    `INSERT INTO items (category_id, name, spec, unit, safety_stock, min_stock, current_stock, unit_price, memo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(categoryId, name, spec || null, '개', safetyStock, minStock, currentStock, unitPrice, memo).run();

  const id = Number(inserted.meta.last_row_id);
  const row = await c.env.DB.prepare('SELECT * FROM items WHERE id = ?')
    .bind(id)
    .first();

  await writeAudit(c.env.DB, user.id, 'create', 'item', id, undefined, row);
  return c.json(apiOk(row));
});

app.patch('/api/items/:id', async (c) => {
  const user = c.get('user') as SessionUser;
  const id = parseIntValue(c.req.param('id'), null);
  if (!id) return c.json(apiErr('INVALID_INPUT', '품목 ID가 유효하지 않습니다.'), 400);

  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const allowed = ['category_id', 'name', 'spec', 'safety_stock', 'min_stock', 'current_stock', 'unit_price', 'memo'];
  const patches: string[] = [];
  const params: unknown[] = [];

  for (const field of allowed) {
    if (!(field in payload)) continue;
    const raw = payload[field];

    if (field === 'name') {
      const value = String(raw || '').trim();
      if (!value) return c.json(apiErr('INVALID_INPUT', '품목명은 빈 값이 될 수 없습니다.'), 400);
      patches.push('name = ?');
      params.push(value);
      continue;
    }

    if (field === 'category_id') {
      const value = parseIntValue(raw == null ? undefined : String(raw), null);
      if (value !== null && value <= 0) return c.json(apiErr('INVALID_INPUT', '카테고리 ID가 유효하지 않습니다.'), 400);
      patches.push('category_id = ?');
      params.push(value);
      continue;
    }

    if (field === 'spec' || field === 'memo') {
      patches.push(`${field} = ?`);
      params.push(raw == null ? null : String(raw));
      continue;
    }

    if (field === 'safety_stock' || field === 'min_stock' || field === 'current_stock' || field === 'unit_price') {
      const value = parseIntValue(raw == null ? undefined : String(raw), null);
      if (value === null || value < 0) {
        return c.json(apiErr('INVALID_INPUT', `${field}는 0 이상 정수여야 합니다.`), 400);
      }
      patches.push(`${field} = ?`);
      params.push(value);
    }
  }

  if (!patches.length) return c.json(apiErr('INVALID_INPUT', '수정할 데이터가 없습니다.'), 400);

  const before = await c.env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  if (!before) return c.json(apiErr('NOT_FOUND', '품목을 찾지 못했습니다.'), 404);

  if (patches.length) {
    const sql = `UPDATE items SET ${patches.join(', ')}, updated_at = datetime('now') WHERE id = ?`;
    await c.env.DB.prepare(sql).bind(...params, id).run();
  }

  const after = await c.env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  await writeAudit(c.env.DB, user.id, 'update', 'item', id, before, after);
  return c.json(apiOk(after));
});

app.delete('/api/items/:id', async (c) => {
  const user = c.get('user') as SessionUser;
  const id = parseIntValue(c.req.param('id'), null);
  if (!id) return c.json(apiErr('INVALID_INPUT', '품목 ID가 유효하지 않습니다.'), 400);

  const before = await c.env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  if (!before) return c.json(apiErr('NOT_FOUND', '품목을 찾지 못했습니다.'), 404);

  await c.env.DB.prepare('UPDATE items SET is_deleted = 1, deleted_at = datetime("now"), updated_at = datetime("now") WHERE id = ?')
    .bind(id)
    .run();

  const after = await c.env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  await writeAudit(c.env.DB, user.id, 'soft_delete', 'item', id, before, after);
  return c.json(apiOk({ deleted: true }));
});

app.get('/api/stock/ledger/:item_id', async (c) => {
  const itemId = parseIntValue(c.req.param('item_id'), null);
  if (!itemId) return c.json(apiErr('INVALID_INPUT', 'item_id가 유효하지 않습니다.'), 400);

  const limit = parseIntPositive(c.req.query('limit'), 100);
  const rows = await c.env.DB.prepare(
    `SELECT id, item_id, movement_type, quantity, reason, created_at
       FROM stock_transactions
      WHERE item_id = ?
      ORDER BY id DESC
      LIMIT ?`
  )
    .bind(itemId, limit)
    .all();

  return c.json(apiOk(rows.results));
});

app.post('/api/stock/adjust', async (c) => {
  const user = c.get('user') as SessionUser;
  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const itemId = parseIntValue(String(payload.item_id ?? ''), null);
  const movementType = String(payload.movement_type || '').toUpperCase();
  const quantity = parseIntValue(String(payload.quantity ?? ''), null);
  const reason = payload.reason == null ? null : String(payload.reason);
  const orderItemId = payload.order_item_id == null ? null : parseIntValue(String(payload.order_item_id), null);

  if (!itemId) return c.json(apiErr('INVALID_INPUT', 'item_id가 유효하지 않습니다.'), 400);
  if (!['IN', 'OUT', 'ADJUST'].includes(movementType)) {
    return c.json(apiErr('INVALID_INPUT', 'movement_type은 IN/OUT/ADJUST만 허용됩니다.'), 400);
  }
  if (quantity === null || quantity === 0) {
    return c.json(apiErr('INVALID_INPUT', 'quantity는 0이 아닌 정수여야 합니다.'), 400);
  }

  let delta = 0;
  if (movementType === 'IN') {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return c.json(apiErr('INVALID_INPUT', 'IN은 양수 수량만 허용됩니다.'), 400);
    }
    delta = quantity;
  } else if (movementType === 'OUT') {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return c.json(apiErr('INVALID_INPUT', 'OUT은 양수 수량만 허용됩니다.'), 400);
    }
    delta = -quantity;
  } else {
    if (!Number.isInteger(quantity)) {
      return c.json(apiErr('INVALID_INPUT', 'ADJUST 수량은 정수여야 합니다.'), 400);
    }
    delta = quantity;
  }

  const item = await c.env.DB.prepare('SELECT id, current_stock, is_deleted, unit FROM items WHERE id = ?').bind(itemId).first<{ id: number; current_stock: number; is_deleted: number; unit: string }>();
  if (!item || item.is_deleted === 1) {
    return c.json(apiErr('NOT_FOUND', '품목이 존재하지 않거나 삭제되었습니다.'), 404);
  }

  const newStock = item.current_stock + delta;
  if (newStock < 0) {
    return c.json(apiErr('INVALID_INPUT', '재고가 음수가 됩니다. 현재고를 확인해주세요.'), 400);
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE items
          SET current_stock = current_stock + ?,
              updated_at = datetime('now')
        WHERE id = ?`
    ).bind(delta, itemId),
    c.env.DB.prepare(
      `INSERT INTO stock_transactions (item_id, movement_type, quantity, reason, order_item_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(itemId, movementType, delta, reason, orderItemId, user.id),
  ]);

  const after = await c.env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(itemId).first();
  await writeAudit(c.env.DB, user.id, 'stock_adjust', 'item', itemId, { current_stock: item.current_stock }, after);

  return c.json(apiOk({ item: after }));
});

app.get('/api/dashboard', async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const from = c.req.query('from') ?? defaultFrom;
  const to = c.req.query('to') ?? today;

  const rows = await c.env.DB.prepare(
    `SELECT i.id, i.name, i.current_stock, i.safety_stock,
            i.min_stock,
            MAX(0, i.safety_stock - i.current_stock) AS suggested_qty
       FROM items i
      WHERE i.is_deleted = 0
        AND i.safety_stock > 0
        AND i.current_stock <= i.safety_stock`
  ).all();

  const lowStockItems = rows.results as Array<Record<string, unknown>>;

  const summary = await c.env.DB.prepare(
    `SELECT
      (SELECT COUNT(1)
         FROM purchase_orders po
        WHERE po.is_deleted = 0
          AND po.order_date BETWEEN ? AND ?
          AND po.status IN ('ordered', 'partially_received', 'draft')) AS orders_open,
      (SELECT COALESCE(SUM(oi.ordered_qty - oi.received_qty), 0)
         FROM purchase_orders po
         JOIN order_items oi ON oi.order_id = po.id
        WHERE po.is_deleted = 0
          AND po.order_date BETWEEN ? AND ?
          AND oi.is_deleted = 0) AS open_qty,
      (SELECT COALESCE(SUM(st.quantity), 0)
         FROM stock_transactions st
        WHERE st.movement_type = 'IN'
          AND date(st.created_at) BETWEEN ? AND ?
      ) AS received_qty
    `
  )
    .bind(from, to, from, to, from, to)
    .first<{ orders_open: number; open_qty: number; received_qty: number }>();

  const totals = await c.env.DB.prepare(`
    SELECT
      (SELECT COUNT(1) FROM items WHERE is_deleted = 0) AS item_count,
      (SELECT COUNT(1) FROM item_categories WHERE is_deleted = 0) AS category_count
    `
  )
    .first<{ item_count: number; category_count: number }>();

  return c.json(apiOk({
    low_stock_count: lowStockItems.length,
    low_stock_items: lowStockItems,
    item_count: Number(totals?.item_count || 0),
    category_count: Number(totals?.category_count || 0),
    monthly_summary: {
      period_from: from,
      period_to: to,
      orders_open: Number(summary?.orders_open || 0),
      open_qty: Number(summary?.open_qty || 0),
      received_qty: Number(summary?.received_qty || 0),
    },
    today,
  }));
});

app.get('/api/purchase-orders', async (c) => {
  const status = c.req.query('status');
  const q = c.req.query('q')?.trim() || '';
  const from = c.req.query('from');
  const to = c.req.query('to');

  const where: string[] = ['po.is_deleted = 0'];
  const params: unknown[] = [];

  if (status !== undefined) {
    const normalizedStatus = String(status).trim();
    if (!normalizedStatus) {
      return c.json(apiErr('INVALID_STATUS', '발주 상태값이 올바르지 않습니다. 허용값: draft, ordered, partially_received, fully_received, canceled'), 400);
    }
    if (!isOrderStatus(normalizedStatus)) {
      return c.json(apiErr('INVALID_STATUS', '발주 상태값이 올바르지 않습니다. 허용값: draft, ordered, partially_received, fully_received, canceled'), 400);
    }
    where.push('po.status = ?');
    params.push(normalizedStatus);
  }

  if (from) {
    where.push('po.order_date >= ?');
    params.push(from);
  }

  if (to) {
    where.push('po.order_date <= ?');
    params.push(to);
  }

  if (q) {
    where.push('(po.title LIKE ? ESCAPE \'\\\\\' OR po.note LIKE ? ESCAPE \'\\\\\')');
    const escaped = q.replace(/[%_\\]/g, '\\$&');
    const like = `%${escaped}%`;
    params.push(like, like);
  }

  const sql = `SELECT po.id, po.title, po.status, po.order_date, po.external_order_ref, po.note, po.created_at, po.updated_at,
                      COALESCE(SUM(CASE WHEN oi.is_deleted = 0 THEN oi.ordered_qty ELSE 0 END), 0) AS ordered_qty,
                      COALESCE(SUM(CASE WHEN oi.is_deleted = 0 THEN oi.received_qty ELSE 0 END), 0) AS received_qty
               FROM purchase_orders po
               LEFT JOIN order_items oi ON oi.order_id = po.id
               WHERE ${where.join(' AND ')}
               GROUP BY po.id
               ORDER BY po.id DESC`;

  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(apiOk(rows.results));
});

app.post('/api/purchase-orders', async (c) => {
  const user = c.get('user') as SessionUser;
  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const title = String(payload.title || '').trim();
  const note = payload.note == null ? null : String(payload.note);
  const statusRaw = payload.status == null ? undefined : String(payload.status).trim();
  const status = statusRaw === undefined || statusRaw === '' ? 'draft' : statusRaw;

  if (!isOrderStatus(status)) {
    return c.json(apiErr('INVALID_STATUS', '발주 상태값이 올바르지 않습니다. 허용값: draft, ordered, partially_received, fully_received, canceled'), 400);
  }

  if (!title) return c.json(apiErr('INVALID_INPUT', '발주명은 필수입니다.'), 400);

  const r = await c.env.DB.prepare(
    `INSERT INTO purchase_orders (title, status, note) VALUES (?, ?, ?)`
  ).bind(title, status, note).run();

  const id = Number(r.meta.last_row_id);
  const row = await c.env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ?').bind(id).first();
  await writeAudit(c.env.DB, user.id, 'create', 'purchase_order', id, undefined, row);
  return c.json(apiOk(row));
});

app.get('/api/purchase-orders/:id', async (c) => {
  const id = parseIntValue(c.req.param('id'), null);
  if (!id) return c.json(apiErr('INVALID_INPUT', '발주 ID가 유효하지 않습니다.'), 400);

  const order = await c.env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!order) return c.json(apiErr('NOT_FOUND', '발주서를 찾지 못했습니다.'), 404);

  const items = await c.env.DB.prepare(
    `SELECT oi.id, oi.item_id, i.name AS item_name, i.spec,
            oi.ordered_qty, oi.received_qty, (oi.ordered_qty - oi.received_qty) AS remaining_qty, oi.memo
       FROM order_items oi
       LEFT JOIN items i ON i.id = oi.item_id
      WHERE oi.order_id = ? AND oi.is_deleted = 0
      ORDER BY oi.id DESC`
  ).bind(id).all();

  return c.json(apiOk({ ...order, items: items.results }));
});

app.patch('/api/purchase-orders/:id', async (c) => {
  const user = c.get('user') as SessionUser;
  const id = parseIntValue(c.req.param('id'), null);
  if (!id) return c.json(apiErr('INVALID_INPUT', '발주 ID가 유효하지 않습니다.'), 400);

  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const patches: string[] = [];
  const params: unknown[] = [];
  let requestedStatus: OrderStatus | null = null;

  if ('title' in payload) {
    const title = String(payload.title || '').trim();
    if (!title) return c.json(apiErr('INVALID_INPUT', '발주명은 빈 값이 될 수 없습니다.'), 400);
    patches.push('title = ?');
    params.push(title);
  }

  if ('status' in payload) {
    const status = String(payload.status).trim();
    if (!isOrderStatus(status)) {
      return c.json(apiErr('INVALID_STATUS', '발주 상태값이 올바르지 않습니다. 허용값: draft, ordered, partially_received, fully_received, canceled'), 400);
    }
    if (status === 'partially_received' || status === 'fully_received') {
      return c.json(apiErr('INVALID_STATUS_TRANSITION', '입고대기/입고완료 상태는 입고 처리에서 자동으로 변경됩니다.'), 400);
    }

    patches.push('status = ?');
    params.push(status);
    requestedStatus = status;
  }

  if ('note' in payload) {
    patches.push('note = ?');
    params.push(payload.note == null ? null : String(payload.note));
  }

  if ('external_order_ref' in payload) {
    patches.push('external_order_ref = ?');
    params.push(payload.external_order_ref == null ? null : String(payload.external_order_ref));
  }

  if (!patches.length) {
    return c.json(apiErr('INVALID_INPUT', '수정할 데이터가 없습니다.'), 400);
  }

  const before = await c.env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ? AND is_deleted = 0')
    .bind(id)
    .first();
  if (!before) return c.json(apiErr('NOT_FOUND', '발주서를 찾지 못했습니다.'), 404);

  if (requestedStatus === 'ordered') {
    const row = await c.env.DB.prepare(
      'SELECT COUNT(1) AS cnt FROM order_items WHERE order_id = ? AND is_deleted = 0'
    ).bind(id).first<{ cnt: number }>();
    const itemCount = Number(row?.cnt || 0);
    if (itemCount <= 0) {
      return c.json(apiErr('INVALID_STATUS_TRANSITION', '발주 항목이 없는 초안은 발주 확정할 수 없습니다.'), 400);
    }

    const prevStatus = String((before as { status?: string }).status || '');
    if (prevStatus === 'draft') {
      patches.push('order_date = date("now")');
    }
  }

  const q = `UPDATE purchase_orders SET ${patches.join(', ')}, updated_at = datetime('now') WHERE id = ?`;
  await c.env.DB.prepare(q).bind(...params, id).run();

  const after = await c.env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ? AND is_deleted = 0')
    .bind(id)
    .first();

  await writeAudit(c.env.DB, user.id, 'update', 'purchase_order', id, before, after);
  return c.json(apiOk(after));
});

app.delete('/api/purchase-orders/:id', async (c) => {
  const user = c.get('user') as SessionUser;
  const id = parseIntValue(c.req.param('id'), null);
  if (!id) return c.json(apiErr('INVALID_INPUT', '발주 ID가 유효하지 않습니다.'), 400);

  const before = await c.env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ?').bind(id).first();
  if (!before) return c.json(apiErr('NOT_FOUND', '발주서를 찾지 못했습니다.'), 404);

  await c.env.DB.prepare('UPDATE purchase_orders SET is_deleted = 1, deleted_at = datetime("now"), updated_at = datetime("now") WHERE id = ?')
    .bind(id)
    .run();

  await c.env.DB.prepare('UPDATE order_items SET is_deleted = 1, deleted_at = datetime("now") WHERE order_id = ?')
    .bind(id)
    .run();

  const after = await c.env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ?').bind(id).first();
  await writeAudit(c.env.DB, user.id, 'soft_delete', 'purchase_order', id, before, after);
  return c.json(apiOk({ deleted: true }));
});

app.post('/api/purchase-orders/:id/items', async (c) => {
  const user = c.get('user') as SessionUser;
  const orderId = parseIntValue(c.req.param('id'), null);
  if (!orderId) return c.json(apiErr('INVALID_INPUT', '발주 ID가 유효하지 않습니다.'), 400);

  const order = await c.env.DB.prepare('SELECT id, status FROM purchase_orders WHERE id = ? AND is_deleted = 0')
    .bind(orderId)
    .first<{ id: number; status: string }>();
  if (!order) return c.json(apiErr('NOT_FOUND', '발주서를 찾지 못했습니다.'), 404);
  if (order.status !== 'draft') {
    return c.json(apiErr('INVALID_STATUS', '초안 상태에서만 발주 항목을 추가할 수 있습니다.'), 400);
  }

  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const rawRows: Array<{ item_id?: unknown; ordered_qty?: unknown; memo?: unknown }> = (() => {
    if (Array.isArray(payload)) {
      return payload as Array<{ item_id?: unknown; ordered_qty?: unknown; memo?: unknown }>;
    }

    if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'item_id')) {
      return [payload as { item_id?: unknown; ordered_qty?: unknown; memo?: unknown }];
    }

    if (Array.isArray((payload as { items?: unknown }).items)) {
      return (payload as { items?: Array<{ item_id?: unknown; ordered_qty?: unknown; memo?: unknown }> }).items as Array<{
        item_id?: unknown;
        ordered_qty?: unknown;
        memo?: unknown;
      }>;
    }

    return [];
  })();

  const rows = rawRows
    .map((row) => {
      const itemId = parseIntValue(row.item_id == null ? undefined : String(row.item_id), null);
      const orderedQty = parseIntValue(row.ordered_qty == null ? undefined : String(row.ordered_qty), null);
      const memo = row.memo == null ? null : String(row.memo);

      if (itemId === null || orderedQty === null || orderedQty <= 0) {
        return null;
      }

      return {
        itemId,
        orderedQty,
        memo,
      };
    })
    .filter((value): value is { itemId: number; orderedQty: number; memo: string | null } => value !== null);

  if (!rows.length) {
    return c.json(apiErr('INVALID_INPUT', '항목과 수량을 확인해주세요.'), 400);
  }

  const mergedRows = rows.reduce<Map<number, { orderedQty: number; memo: string | null }>>((acc, row) => {
    const current = acc.get(row.itemId);
    acc.set(row.itemId, {
      orderedQty: (current?.orderedQty ?? 0) + row.orderedQty,
      memo: row.memo || current?.memo || null,
    });
    return acc;
  }, new Map());

  const groupedRows = Array.from(mergedRows.entries()).map(([itemId, row]) => ({
    itemId,
    orderedQty: row.orderedQty,
    memo: row.memo,
  }));

  for (const row of groupedRows) {
    const item = await c.env.DB.prepare('SELECT id FROM items WHERE id = ? AND is_deleted = 0').bind(row.itemId).first();
    if (!item) {
      return c.json(apiErr('INVALID_INPUT', `존재하지 않는 품목입니다. (id=${row.itemId})`), 400);
    }
  }

  for (const row of groupedRows) {
    const existing = await c.env.DB.prepare(
      `SELECT id, ordered_qty, received_qty, memo FROM order_items WHERE order_id = ? AND item_id = ? AND is_deleted = 0`
    )
      .bind(orderId, row.itemId)
      .first<{ id: number; ordered_qty: number; received_qty: number; memo: string | null }>();
    let orderItemId: number;
    let action: 'create' | 'update';
    let before: unknown = null;

    if (existing) {
      before = {
        id: existing.id,
        order_id: orderId,
        item_id: row.itemId,
        ordered_qty: existing.ordered_qty,
        received_qty: existing.received_qty,
        memo: existing.memo,
      };
      const nextQty = existing.ordered_qty + row.orderedQty;
      await c.env.DB.prepare(
        'UPDATE order_items SET ordered_qty = ?, memo = ?, updated_at = datetime("now") WHERE id = ?'
      )
        .bind(nextQty, row.memo, existing.id)
        .run();
      orderItemId = existing.id;
      action = 'update';
    } else {
      const inserted = await c.env.DB.prepare(
        `INSERT INTO order_items (order_id, item_id, ordered_qty, received_qty, memo)
       VALUES (?, ?, ?, 0, ?)`
      ).bind(orderId, row.itemId, row.orderedQty, row.memo).run();
      orderItemId = Number(inserted.meta.last_row_id);
      action = 'create';
    }

    const after = await c.env.DB.prepare(
      `SELECT oi.id, oi.order_id, oi.item_id, oi.ordered_qty, oi.received_qty, oi.memo
         FROM order_items oi
        WHERE oi.id = ?`
    ).bind(orderItemId).first();

    if (after) {
      await writeAudit(c.env.DB, user.id, action, 'order_item', Number(after.id), before ?? undefined, after);
    }
  }

  await c.env.DB.prepare('UPDATE purchase_orders SET updated_at = datetime("now") WHERE id = ?').bind(orderId).run();

  const targets = await c.env.DB.prepare(
    `SELECT oi.id, oi.order_id, oi.item_id, oi.ordered_qty, oi.received_qty, oi.memo
       FROM order_items oi
      WHERE oi.order_id = ? AND oi.is_deleted = 0`
  ).bind(orderId).all();

  return c.json(apiOk({ items: targets.results }));
});

app.patch('/api/purchase-orders/:id/items/:itemId', async (c) => {
  const user = c.get('user') as SessionUser;
  const orderId = parseIntValue(c.req.param('id'), null);
  const orderItemId = parseIntValue(c.req.param('itemId'), null);

  if (!orderId || !orderItemId) {
    return c.json(apiErr('INVALID_INPUT', '발주 ID 또는 항목 ID가 유효하지 않습니다.'), 400);
  }

  const order = await c.env.DB.prepare(
    'SELECT id, status FROM purchase_orders WHERE id = ? AND is_deleted = 0'
  ).bind(orderId).first<{ id: number; status: string }>();
  if (!order) return c.json(apiErr('NOT_FOUND', '발주서를 찾지 못했습니다.'), 404);
  if (order.status !== 'draft') {
    return c.json(apiErr('INVALID_STATUS', '초안 상태에서만 발주 항목을 수정할 수 있습니다.'), 400);
  }

  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const patch: string[] = [];
  const params: unknown[] = [];

  if ('ordered_qty' in payload) {
    const orderedQty = parseIntValue(String(payload.ordered_qty ?? ''), null);
    if (orderedQty === null || orderedQty <= 0) {
      return c.json(apiErr('INVALID_INPUT', 'ordered_qty는 1 이상의 정수여야 합니다.'), 400);
    }
    patch.push('ordered_qty = ?');
    params.push(orderedQty);
  }

  if ('memo' in payload) {
    patch.push('memo = ?');
    params.push(payload.memo == null ? null : String(payload.memo));
  }

  if (!patch.length) {
    return c.json(apiErr('INVALID_INPUT', '수정할 데이터가 없습니다.'), 400);
  }

  const before = await c.env.DB.prepare(
    `SELECT oi.id, oi.order_id, oi.item_id, oi.ordered_qty, oi.received_qty, oi.memo
       FROM order_items oi
      WHERE oi.id = ? AND oi.order_id = ? AND oi.is_deleted = 0`
  ).bind(orderItemId, orderId).first();
  if (!before) return c.json(apiErr('NOT_FOUND', '발주 항목을 찾지 못했습니다.'), 404);

  if ('ordered_qty' in payload) {
    const currentReceived = Number((before as any).received_qty || 0);
    if (currentReceived > Number((payload as any).ordered_qty)) {
      return c.json(apiErr('INVALID_INPUT', '수정하려는 수량이 이미 입고된 수량보다 작을 수 없습니다.'), 400);
    }
  }

  const sql = `UPDATE order_items SET ${patch.join(', ')}, updated_at = datetime('now') WHERE id = ?`;
  await c.env.DB.prepare(sql).bind(...params, orderItemId).run();

  const after = await c.env.DB.prepare(
    `SELECT oi.id, oi.order_id, oi.item_id, oi.ordered_qty, oi.received_qty, oi.memo
       FROM order_items oi
      WHERE oi.id = ?`
  ).bind(orderItemId).first();

  await writeAudit(c.env.DB, user.id, 'update', 'order_item', orderItemId, before, after);
  return c.json(apiOk(after));
});

app.post('/api/purchase-orders/:id/items/:itemId/receive', async (c) => {
  const user = c.get('user') as SessionUser;
  const orderId = parseIntValue(c.req.param('id'), null);
  const orderItemId = parseIntValue(c.req.param('itemId'), null);

  if (!orderId || !orderItemId) {
    return c.json(apiErr('INVALID_INPUT', '발주 ID 또는 항목 ID가 유효하지 않습니다.'), 400);
  }

  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const qty = parseIntValue(String(payload.qty ?? ''), null);
  if (qty === null || qty <= 0) {
    return c.json(apiErr('INVALID_INPUT', 'qty는 1 이상의 정수여야 합니다.'), 400);
  }

  const order = await c.env.DB.prepare(
    'SELECT id, status FROM purchase_orders WHERE id = ? AND is_deleted = 0'
  ).bind(orderId).first<{ id: number; status: string }>();
  if (!order) return c.json(apiErr('NOT_FOUND', '발주서를 찾지 못했습니다.'), 404);

  if (order.status === 'draft') {
    return c.json(apiErr('INVALID_STATUS', '초안 상태에서는 입고 처리할 수 없습니다.'), 400);
  }
  if (order.status === 'canceled') {
    return c.json(apiErr('INVALID_STATUS', '취소된 발주서는 입고 처리할 수 없습니다.'), 400);
  }

  const target = await c.env.DB.prepare(
    `SELECT oi.id, oi.item_id, oi.ordered_qty, oi.received_qty
       FROM order_items oi
      WHERE oi.id = ? AND oi.order_id = ? AND oi.is_deleted = 0`
  ).bind(orderItemId, orderId).first<{ id: number; item_id: number; ordered_qty: number; received_qty: number }>();
  if (!target) return c.json(apiErr('NOT_FOUND', '발주 항목을 찾지 못했습니다.'), 404);

  const remain = target.ordered_qty - target.received_qty;
  if (remain <= 0) {
    return c.json(apiErr('INVALID_INPUT', '이미 입고 완료된 항목입니다.'), 400);
  }
  if (qty > remain) {
    return c.json(apiErr('INVALID_INPUT', `최대 ${remain}개까지 입고 가능합니다.`), 400);
  }

  const newReceived = target.received_qty + qty;
  const item = await c.env.DB.prepare('SELECT current_stock FROM items WHERE id = ? AND is_deleted = 0').bind(target.item_id).first<{ current_stock: number }>();
  if (!item) return c.json(apiErr('INVALID_INPUT', '품목이 삭제되었거나 존재하지 않습니다.'), 404);

  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE order_items SET received_qty = ?, updated_at = datetime("now") WHERE id = ?')
      .bind(newReceived, orderItemId),
    c.env.DB.prepare('INSERT INTO stock_transactions (item_id, movement_type, quantity, order_item_id, reason, created_by) VALUES (?, "IN", ?, ?, ?, ?)')
      .bind(target.item_id, qty, orderItemId, payload.note == null ? '부분입고 처리' : String(payload.note), user.id),
    c.env.DB.prepare('UPDATE items SET current_stock = current_stock + ?, updated_at = datetime("now") WHERE id = ?')
      .bind(qty, target.item_id),
  ]);

  const sum = await c.env.DB.prepare(
    `SELECT
       SUM(ordered_qty - received_qty) AS remaining_qty,
       SUM(ordered_qty) AS ordered_qty,
       SUM(received_qty) AS received_qty
      FROM order_items
     WHERE order_id = ? AND is_deleted = 0`
  ).bind(orderId).first<{ remaining_qty: number; ordered_qty: number; received_qty: number }>();

  if (order.status !== 'canceled') {
    let nextStatus: OrderStatus = 'ordered';
    if (sum) {
      const rem = Number(sum.remaining_qty || 0);
      const recv = Number(sum.received_qty || 0);
      const ord = Number(sum.ordered_qty || 0);

      if (rem <= 0 || recv >= ord) nextStatus = 'fully_received';
      else if (recv > 0) nextStatus = 'partially_received';
      else nextStatus = 'ordered';
    }
    await c.env.DB.prepare('UPDATE purchase_orders SET status = ?, updated_at = datetime("now") WHERE id = ?')
      .bind(nextStatus, orderId)
      .run();
  }

  const updatedOrder = await c.env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ?').bind(orderId).first();
  const updatedItem = await c.env.DB.prepare(
    `SELECT oi.id, oi.item_id, oi.ordered_qty, oi.received_qty, oi.memo
       FROM order_items oi WHERE oi.id = ?`
  ).bind(orderItemId).first();

  await writeAudit(c.env.DB, user.id, 'receive', 'order_item', orderItemId, { ...target }, updatedItem);
  return c.json(apiOk({ order: updatedOrder, order_item: updatedItem }));
});

app.get('/api/audit-logs', async (c) => {
  const action = c.req.query('action')?.trim();
  const entityType = c.req.query('entity_type')?.trim();
  const actor = parseIntValue(c.req.query('actor'), null);
  const entityId = parseIntValue(c.req.query('entity_id'), null);
  const from = c.req.query('from');
  const to = c.req.query('to');

  const where: string[] = [];
  const params: unknown[] = [];

  if (action) {
    where.push('action = ?');
    params.push(action);
  }
  if (entityType) {
    where.push('entity_type = ?');
    params.push(entityType);
  }
  if (actor !== null) {
    where.push('actor_user_id = ?');
    params.push(actor);
  }
  if (entityId !== null) {
    where.push('entity_id = ?');
    params.push(entityId);
  }
  if (from) {
    where.push("created_at >= ?");
    params.push(from);
  }
  if (to) {
    where.push("created_at <= ?");
    params.push(to);
  }

  const sql = `SELECT * FROM audit_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 200`;
  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(apiOk(rows.results));
});

app.get('/', (c) => {
  return c.json(apiOk({
    name: 'hereisorder-api',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      api: '/api/*',
    },
  }));
});

for (const route of ['/login', '/dashboard', '/items', '/alerts', '/orders']) {
  app.get(route, (c) => {
    return c.json(apiErr('INVALID_ROUTE', 'Backend does not serve UI. Use the web frontend for screen routes.'), 404);
  });
}

app.notFound(async (c) => {
  return c.json(apiErr('NOT_FOUND', 'Not Found'), 404);
});

export default app;
