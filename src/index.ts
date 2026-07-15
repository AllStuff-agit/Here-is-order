import { Hono } from 'hono';
import type { RuntimeSchema } from '@here-is-order/http-contract/envelope';
import {
  addPurchaseOrderItemsResultSchema,
  deletePurchaseOrderResultSchema,
  editPurchaseOrderItemResultSchema,
  purchaseOrderDetailSchema,
  purchaseOrderRoutePatterns,
  purchaseOrderRowResultSchema,
  purchaseOrderSummaryListSchema,
  receivePurchaseOrderItemResultSchema,
} from '@here-is-order/http-contract/purchase-orders';
import {
  isPurchaseOrderStatus,
  purchaseOrders,
  type OrderItemRevision,
  type PurchaseOrderRevision,
  type PurchaseOrderResult,
} from './purchase-orders';
import { identity, type IdentityPrincipal } from './identity';
import {
  authClearCookie,
  authSetCookie,
  parseAuthCookie,
} from './identity/http-cookie';
import { logApiErrorEvent } from './observability';
import { probeRequiredD1Schema } from './readiness';

type Env = {
  Bindings: {
    DB: D1Database;
  };
};

type UserRole = 'admin' | 'staff';

type AppVariables = {
  principal?: IdentityPrincipal;
};


const app = new Hono<{ Bindings: Env['Bindings']; Variables: AppVariables }>();

app.onError((_err, c) => {
  logApiErrorEvent('unhandled_request_error');
  return c.json(apiErr('INTERNAL_ERROR', '서버 오류가 발생했습니다.'), 500);
});

const USER_ROLES = ['admin', 'staff'] as const;
const ITEM_PUBLIC_COLUMNS = `i.id, i.category_id, i.name, i.spec, i.unit,
  i.safety_stock, i.min_stock, i.current_stock, i.unit_price, i.memo,
  i.is_deleted, i.deleted_at, i.created_at, i.updated_at`;

function apiOk<T>(data: T) {
  return { ok: true, data };
}

function apiErr(code: string, message: string, status = 400) {
  return {
    ok: false,
    error: { code, message },
  } as const;
}

function purchaseOrderResponse<T>(
  c: any,
  result: PurchaseOrderResult<T>,
  schema: RuntimeSchema<T>,
  successStatus: 200 | 201 = 200,
) {
  if (result.ok) return c.json(apiOk(schema.parse(result.value)), successStatus);
  const status = result.error.kind === 'invalid'
    ? 400
    : result.error.kind === 'not_found'
      ? 404
      : 409;
  return c.json(apiErr(result.error.code, result.error.message), status);
}

function parseIntValue(raw: string | undefined, fallback: null): number | null;
function parseIntValue(raw: string | undefined, fallback: number): number;
function parseIntValue(raw: string | undefined, fallback?: undefined): number | undefined;
function parseIntValue(raw: string | undefined, fallback?: number | null): number | null | undefined {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) ? n : fallback;
}

function parseIntPositive(raw: string | undefined, fallback: number | null = null) {
  const n = parseIntValue(raw, null);
  if (n === null || n <= 0) return fallback;
  return n;
}

function scheduleExpiredSessionCleanup(c: any) {
  const runtimeIdentity = identity(c.env.DB);
  c.executionCtx.waitUntil(
    runtimeIdentity
      .cleanupExpiredSessions()
      .catch(() => {
        logApiErrorEvent('expired_session_cleanup_failed');
      }),
  );
}

function requireAdmin(c: any) {
  const principal = c.get('principal') as IdentityPrincipal;
  if (principal.role !== 'admin') {
    return c.json(apiErr('FORBIDDEN', '관리자 권한이 필요합니다.'), 403);
  }
  return null;
}

async function requireAuth(c: any, next: () => Promise<void>) {
  const rawToken = parseAuthCookie(c.req.header('Cookie'));
  if (!rawToken) {
    return c.json(apiErr('UNAUTHORIZED', '로그인이 필요합니다.'), 401);
  }
  const runtimeIdentity = identity(c.env.DB);
  const principal = await runtimeIdentity.resolveSession(rawToken);
  if (!principal) {
    return c.json(apiErr('UNAUTHORIZED', '로그인이 필요합니다.'), 401);
  }
  c.set('principal', principal);
  await next();
}

function isUserRole(role: string): role is UserRole {
  return USER_ROLES.includes(role as UserRole);
}


app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  if (path === '/api/auth/login') {
    return next();
  }
  return requireAuth(c, next);
});

app.get('/health', (c) => c.json(apiOk({ ok: true, ts: new Date().toISOString() })));

app.get('/ready', async (c) => {
  c.header('Cache-Control', 'no-store');
  const readiness = await probeRequiredD1Schema(c.env?.DB);
  if (!readiness.ready) {
    logApiErrorEvent('d1_readiness_failed');
    return c.json(apiErr('NOT_READY', '서비스가 준비되지 않았습니다.'), 503);
  }

  return c.json(apiOk(readiness));
});

app.post('/api/auth/login', async (c) => {
  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const username = String(payload.username || '').trim();
  const password = String(payload.password || '');

  if (!username || !password) {
    return c.json(apiErr('INVALID_INPUT', 'username/password를 입력해주세요.'), 400);
  }

  const runtimeIdentity = identity(c.env.DB);
  const result = await runtimeIdentity.authenticate({ username, password });
  if (!result.ok) {
    const message = result.error.kind === 'account_unavailable'
      ? '계정이 존재하지 않거나 비활성입니다.'
      : '아이디 또는 비밀번호가 올바르지 않습니다.';
    return c.json(apiErr('INVALID_CREDENTIALS', message), 401);
  }

  const [header, value] = authSetCookie(
    result.value.token,
    new URL(c.req.url).protocol === 'https:',
  );
  c.res.headers.set(header, value);

  scheduleExpiredSessionCleanup(c);

  return c.json(apiOk({ user: result.value.user }));
});

app.post('/api/auth/logout', async (c) => {
  const principal = c.get('principal') as IdentityPrincipal;
  const rawToken = parseAuthCookie(c.req.header('Cookie')) || '';
  const runtimeIdentity = identity(c.env.DB);
  const result = await runtimeIdentity.logout({ principal, rawToken });

  const [header, value] = authClearCookie(new URL(c.req.url).protocol === 'https:');
  c.res.headers.set(header, value);

  scheduleExpiredSessionCleanup(c);

  return c.json(apiOk(result.value));
});

app.get('/api/users', async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;

  const principal = c.get('principal') as IdentityPrincipal;
  const runtimeIdentity = identity(c.env.DB);
  const result = await runtimeIdentity.listUsers(principal);
  if (!result.ok) {
    return c.json(apiErr('FORBIDDEN', '관리자 권한이 필요합니다.'), 403);
  }
  return c.json(apiOk(result.value));
});

app.post('/api/users', async (c) => {
  const principal = c.get('principal') as IdentityPrincipal;
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;

  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const username = String(payload.username || '').trim();
  const name = String(payload.name || '').trim();
  const password = String(payload.password || '');
  const role = payload.role == null ? 'staff' : String(payload.role).trim();

  if (!username || !password) {
    return c.json(apiErr('INVALID_INPUT', '아이디와 비밀번호는 필수입니다.'), 400);
  }
  if (password.length < 6) {
    return c.json(apiErr('INVALID_INPUT', '비밀번호는 6자 이상이어야 합니다.'), 400);
  }
  if (!isUserRole(role)) {
    return c.json(apiErr('INVALID_INPUT', 'role은 admin 또는 staff여야 합니다.'), 400);
  }

  const runtimeIdentity = identity(c.env.DB);
  const result = await runtimeIdentity.createUser(principal, {
    username,
    name: name || username,
    password,
    role,
  });
  if (!result.ok && result.error.kind === 'duplicate_username') {
    return c.json(apiErr('DUPLICATE_USERNAME', '이미 사용 중인 아이디입니다.'), 409);
  }
  if (!result.ok) {
    return c.json(apiErr('FORBIDDEN', '관리자 권한이 필요합니다.'), 403);
  }
  return c.json(apiOk(result.value), 201);
});

app.get('/api/users/me', async (c) => {
  const principal = c.get('principal') as IdentityPrincipal;
  const runtimeIdentity = identity(c.env.DB);
  return c.json(apiOk(runtimeIdentity.currentUser(principal)));
});

app.patch('/api/users/me/password', async (c) => {
  const principal = c.get('principal') as IdentityPrincipal;
  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const currentPassword = String(payload.current_password || '');
  const newPassword = String(payload.new_password || '');

  if (!currentPassword || !newPassword) {
    return c.json(apiErr('INVALID_INPUT', '현재 비밀번호와 새 비밀번호를 입력해주세요.'), 400);
  }
  if (newPassword.length < 6) {
    return c.json(apiErr('INVALID_INPUT', '새 비밀번호는 6자 이상이어야 합니다.'), 400);
  }

  const currentRawToken = parseAuthCookie(c.req.header('Cookie')) || '';
  const runtimeIdentity = identity(c.env.DB);
  const result = await runtimeIdentity.changeOwnPassword(principal, {
    currentPassword,
    newPassword,
    currentRawToken,
  });
  if (!result.ok && result.error.kind === 'not_found') {
    return c.json(apiErr('NOT_FOUND', '계정을 찾을 수 없습니다.'), 404);
  }
  if (!result.ok) {
    return c.json(apiErr('INVALID_CREDENTIALS', '현재 비밀번호가 올바르지 않습니다.'), 401);
  }
  return c.json(apiOk(result.value));
});

app.patch('/api/users/:id/password', async (c) => {
  const principal = c.get('principal') as IdentityPrincipal;
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;

  const targetId = parseIntValue(c.req.param('id'), null);
  if (!targetId) return c.json(apiErr('INVALID_INPUT', '유효하지 않은 사용자 ID입니다.'), 400);

  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const newPassword = String(payload.new_password || '');

  if (!newPassword || newPassword.length < 6) {
    return c.json(apiErr('INVALID_INPUT', '새 비밀번호는 6자 이상이어야 합니다.'), 400);
  }

  const runtimeIdentity = identity(c.env.DB);
  const result = await runtimeIdentity.resetPassword(principal, {
    targetId,
    newPassword,
  });
  if (!result.ok && result.error.kind === 'not_found') {
    return c.json(apiErr('NOT_FOUND', '사용자를 찾을 수 없습니다.'), 404);
  }
  if (!result.ok) {
    return c.json(apiErr('FORBIDDEN', '관리자 권한이 필요합니다.'), 403);
  }
  return c.json(apiOk(result.value));
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
  const principal = c.get('principal') as IdentityPrincipal;
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

  let result;
  try {
    result = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO item_categories (name, description) VALUES (?, ?)`
      ).bind(name, description),
      c.env.DB.prepare(
        `INSERT INTO audit_logs
           (actor_user_id, action, entity_type, entity_id, before_json, after_json)
         VALUES (?, 'create', 'category', last_insert_rowid(), NULL, ?)`
      ).bind(principal.userId, JSON.stringify({ name, description })),
    ]);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE constraint failed')) {
      return c.json(apiErr('DUPLICATE', '동일한 이름의 카테고리가 이미 존재합니다.'), 409);
    }
    throw e;
  }

  const id = Number((result[0] as D1Result).meta.last_row_id);
  const row = await c.env.DB.prepare('SELECT id, name, description FROM item_categories WHERE id = ?')
    .bind(id)
    .first();

  return c.json(apiOk(row), 201);
});

app.patch('/api/categories/:id', async (c) => {
  const principal = c.get('principal') as IdentityPrincipal;
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

  const before = await c.env.DB.prepare('SELECT id, name, description, is_deleted FROM item_categories WHERE id = ? AND is_deleted = 0')
    .bind(id)
    .first();
  if (!before) return c.json(apiErr('NOT_FOUND', '카테고리를 찾지 못했습니다.'), 404);

  const q = `UPDATE item_categories SET ${patches.join(', ')}, updated_at = datetime('now') WHERE id = ? AND is_deleted = 0`;
  const batchResult = await c.env.DB.batch([
    c.env.DB.prepare(q).bind(...params, id),
    c.env.DB.prepare(
      `INSERT INTO audit_logs
         (actor_user_id, action, entity_type, entity_id, before_json, after_json)
       SELECT ?, 'update', 'category', c.id, ?,
              json_object('id', c.id, 'name', c.name, 'description', c.description,
                          'is_deleted', c.is_deleted)
         FROM item_categories c
        WHERE c.id = ? AND changes() = 1`
    ).bind(principal.userId, JSON.stringify(before), id),
  ]);
  if ((batchResult[0] as D1Result).meta.changes === 0) {
    return c.json(apiErr('CONFLICT', '카테고리 상태가 변경되어 수정할 수 없습니다.'), 409);
  }

  const after = await c.env.DB.prepare('SELECT id, name, description, is_deleted FROM item_categories WHERE id = ?')
    .bind(id)
    .first();

  return c.json(apiOk(after));
});

app.delete('/api/categories/:id', async (c) => {
  const principal = c.get('principal') as IdentityPrincipal;
  const id = parseIntValue(c.req.param('id'), null);
  if (!id) return c.json(apiErr('INVALID_INPUT', '카테고리 ID가 유효하지 않습니다.'), 400);

  const before = await c.env.DB.prepare('SELECT id, name, is_deleted FROM item_categories WHERE id = ? AND is_deleted = 0')
    .bind(id)
    .first();
  if (!before) return c.json(apiErr('NOT_FOUND', '카테고리를 찾지 못했습니다.'), 404);

  const itemCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM items WHERE category_id = ? AND is_deleted = 0'
  )
    .bind(id)
    .first<{ count: number }>();
  if (itemCount && itemCount.count > 0) {
    return c.json(apiErr('CONFLICT', '이 분류에 속한 품목이 있어 삭제할 수 없습니다.'), 409);
  }

  const after = { ...before, is_deleted: 1 };
  const batchResult = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE item_categories
          SET is_deleted = 1, deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND is_deleted = 0
          AND NOT EXISTS (
            SELECT 1 FROM items WHERE category_id = ? AND is_deleted = 0
          )`
    ).bind(id, id),
    c.env.DB.prepare(
      `INSERT INTO audit_logs
         (actor_user_id, action, entity_type, entity_id, before_json, after_json)
       SELECT ?, 'soft_delete', 'category', ?, ?, ? WHERE changes() = 1`
    ).bind(principal.userId, id, JSON.stringify(before), JSON.stringify(after)),
  ]);

  if ((batchResult[0] as D1Result).meta.changes === 0) {
    return c.json(apiErr('CONFLICT', '활성 품목이 추가되어 카테고리를 삭제할 수 없습니다.'), 409);
  }
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
    whereClauses.push('i.current_stock < i.safety_stock');
  }

  if (q) {
    whereClauses.push("(i.name LIKE ? ESCAPE '!' OR i.spec LIKE ? ESCAPE '!' OR c.name LIKE ? ESCAPE '!')");
    const escaped = q.replace(/[%_!]/g, '!$&');
    const like = `%${escaped}%`;
    params.push(like, like, like);
  }

  const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const rows = await c.env.DB.prepare(
    `SELECT i.id, i.category_id, c.name AS category_name, i.name, i.spec, i.unit, i.safety_stock,
            i.min_stock, i.current_stock, i.unit_price, i.memo, i.created_at, i.updated_at,
            MAX(0, i.safety_stock - i.current_stock - (
              SELECT COALESCE(SUM(oi.ordered_qty - oi.received_qty), 0)
              FROM order_items oi
              JOIN purchase_orders po ON po.id = oi.order_id
              WHERE oi.item_id = i.id
                AND oi.is_deleted = 0
                AND po.is_deleted = 0
                AND po.status NOT IN ('canceled', 'fully_received')
            )) AS suggested_qty
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
  const principal = c.get('principal') as IdentityPrincipal;
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
  if (
    safetyStock == null || minStock == null || currentStock == null || unitPrice == null ||
    safetyStock < 0 || minStock < 0 || currentStock < 0 || unitPrice < 0
  ) {
    return c.json(apiErr('INVALID_INPUT', '수량/금액은 0 이상이어야 합니다.'), 400);
  }
  if (payload.category_id != null && (categoryId == null || categoryId <= 0)) {
    return c.json(apiErr('INVALID_INPUT', '카테고리 ID가 유효하지 않습니다.'), 400);
  }
  if (categoryId !== null) {
    const category = await c.env.DB.prepare(
      'SELECT id FROM item_categories WHERE id = ? AND is_deleted = 0'
    ).bind(categoryId).first();
    if (!category) return c.json(apiErr('INVALID_INPUT', '활성 카테고리를 찾지 못했습니다.'), 400);
  }

  const existing = await c.env.DB.prepare(
    `SELECT id FROM items WHERE name = ? AND COALESCE(spec, '') = ? AND is_deleted = 0`
  )
    .bind(name, spec)
    .first();
  if (existing) {
    return c.json(apiErr('DUPLICATE', '이미 동일한 품목이 존재합니다.'), 409);
  }

  const creationToken = crypto.randomUUID();
  const operationToken = crypto.randomUUID();
  let batchResult: D1Result[];
  try {
    const statements = [
      c.env.DB.prepare(
        `INSERT INTO items
           (category_id, name, spec, unit, safety_stock, min_stock, current_stock, unit_price, memo, creation_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(categoryId, name, spec || null, '개', safetyStock, minStock, currentStock, unitPrice, memo, creationToken),
    ];

    if (currentStock > 0) {
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO stock_transactions
             (item_id, movement_type, quantity, reason, created_by, operation_token)
           SELECT id, 'ADJUST', current_stock, '초기 재고', ?, ?
             FROM items WHERE creation_token = ?`
        ).bind(principal.userId, operationToken, creationToken),
      );
    }

    statements.push(
      c.env.DB.prepare(
        `INSERT INTO audit_logs
           (actor_user_id, action, entity_type, entity_id, before_json, after_json)
         SELECT ?, 'create', 'item', id, NULL, ?
           FROM items WHERE creation_token = ?`
      ).bind(
        principal.userId,
        JSON.stringify({ category_id: categoryId, name, spec: spec || null, current_stock: currentStock }),
        creationToken,
      ),
    );
    statements.push(
      c.env.DB.prepare('UPDATE items SET creation_token = NULL WHERE creation_token = ?').bind(creationToken),
    );
    batchResult = await c.env.DB.batch(statements);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE constraint failed')) {
      return c.json(apiErr('DUPLICATE_ITEM', '이미 동일한 이름의 품목이 존재합니다.'), 409);
    }
    throw e;
  }

  const id = Number(batchResult[0].meta.last_row_id);
  const row = await c.env.DB.prepare(
    `SELECT ${ITEM_PUBLIC_COLUMNS}, c.name AS category_name FROM items i LEFT JOIN item_categories c ON c.id = i.category_id WHERE i.id = ?`
  )
    .bind(id)
    .first();

  return c.json(apiOk(row), 201);
});

app.patch('/api/items/:id', async (c) => {
  const principal = c.get('principal') as IdentityPrincipal;
  const id = parseIntValue(c.req.param('id'), null);
  if (!id) return c.json(apiErr('INVALID_INPUT', '품목 ID가 유효하지 않습니다.'), 400);

  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  if ('current_stock' in payload) {
    return c.json(apiErr('INVENTORY_LEDGER_REQUIRED', '현재고는 재고 조정 API를 통해서만 변경할 수 있습니다.'), 400);
  }

  const allowed = ['category_id', 'name', 'spec', 'safety_stock', 'min_stock', 'unit_price', 'memo'];
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
      if (raw != null && (value === null || value <= 0)) {
        return c.json(apiErr('INVALID_INPUT', '카테고리 ID가 유효하지 않습니다.'), 400);
      }
      if (value !== null) {
        const category = await c.env.DB.prepare(
          'SELECT id FROM item_categories WHERE id = ? AND is_deleted = 0'
        ).bind(value).first();
        if (!category) return c.json(apiErr('INVALID_INPUT', '활성 카테고리를 찾지 못했습니다.'), 400);
      }
      patches.push('category_id = ?');
      params.push(value);
      continue;
    }

    if (field === 'spec' || field === 'memo') {
      patches.push(`${field} = ?`);
      params.push(raw == null ? null : String(raw));
      continue;
    }

    if (field === 'safety_stock' || field === 'min_stock' || field === 'unit_price') {
      const value = parseIntValue(raw == null ? undefined : String(raw), null);
      if (value === null || value < 0) {
        return c.json(apiErr('INVALID_INPUT', `${field}는 0 이상 정수여야 합니다.`), 400);
      }
      patches.push(`${field} = ?`);
      params.push(value);
    }
  }

  if (!patches.length) return c.json(apiErr('INVALID_INPUT', '수정할 데이터가 없습니다.'), 400);

  const before = await c.env.DB.prepare('SELECT * FROM items WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!before) return c.json(apiErr('NOT_FOUND', '품목을 찾지 못했습니다.'), 404);

  const sql = `UPDATE items SET ${patches.join(', ')}, updated_at = datetime('now') WHERE id = ? AND is_deleted = 0`;
  const batchResult = await c.env.DB.batch([
    c.env.DB.prepare(sql).bind(...params, id),
    c.env.DB.prepare(
      `INSERT INTO audit_logs
         (actor_user_id, action, entity_type, entity_id, before_json, after_json)
       SELECT ?, 'update', 'item', i.id, ?,
              json_object(
                'id', i.id, 'category_id', i.category_id, 'name', i.name,
                'spec', i.spec, 'unit', i.unit, 'safety_stock', i.safety_stock,
                'min_stock', i.min_stock, 'current_stock', i.current_stock,
                'unit_price', i.unit_price, 'memo', i.memo, 'is_deleted', i.is_deleted
              )
         FROM items i
        WHERE i.id = ? AND changes() = 1`
    ).bind(principal.userId, JSON.stringify(before), id),
  ]);

  if ((batchResult[0] as D1Result).meta.changes === 0) {
    return c.json(apiErr('CONFLICT', '품목 상태가 변경되어 수정할 수 없습니다.'), 409);
  }

  const after = await c.env.DB.prepare(
    `SELECT ${ITEM_PUBLIC_COLUMNS}, c.name AS category_name FROM items i LEFT JOIN item_categories c ON c.id = i.category_id WHERE i.id = ?`
  ).bind(id).first();
  return c.json(apiOk(after));
});

app.delete('/api/items/:id', async (c) => {
  const principal = c.get('principal') as IdentityPrincipal;
  const id = parseIntValue(c.req.param('id'), null);
  if (!id) return c.json(apiErr('INVALID_INPUT', '품목 ID가 유효하지 않습니다.'), 400);

  const before = await c.env.DB.prepare('SELECT * FROM items WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!before) return c.json(apiErr('NOT_FOUND', '품목을 찾지 못했습니다.'), 404);

  const outstanding = await c.env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM order_items oi
       JOIN purchase_orders po ON po.id = oi.order_id
      WHERE oi.item_id = ? AND oi.is_deleted = 0
        AND po.is_deleted = 0 AND po.status NOT IN ('fully_received', 'canceled')`
  ).bind(id).first<{ cnt: number }>();
  if (outstanding && outstanding.cnt > 0) {
    return c.json(apiErr('CONFLICT', '미완료 발주서에 포함된 품목은 삭제할 수 없습니다.'), 409);
  }

  const after = { ...before, is_deleted: 1 };
  const batchResult = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE items
          SET is_deleted = 1, deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND is_deleted = 0
          AND NOT EXISTS (
            SELECT 1
              FROM order_items oi
              JOIN purchase_orders po ON po.id = oi.order_id
             WHERE oi.item_id = ? AND oi.is_deleted = 0
               AND po.is_deleted = 0
               AND po.status NOT IN ('fully_received', 'canceled')
          )`
    ).bind(id, id),
    c.env.DB.prepare(
      `INSERT INTO audit_logs
         (actor_user_id, action, entity_type, entity_id, before_json, after_json)
       SELECT ?, 'soft_delete', 'item', ?, ?, ? WHERE changes() = 1`
    ).bind(principal.userId, id, JSON.stringify(before), JSON.stringify(after)),
  ]);

  if ((batchResult[0] as D1Result).meta.changes === 0) {
    return c.json(apiErr('CONFLICT', '미완료 발주가 추가되어 품목을 삭제할 수 없습니다.'), 409);
  }
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
  const principal = c.get('principal') as IdentityPrincipal;
  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const itemId = parseIntValue(String(payload.item_id ?? ''), null);
  const movementType = String(payload.movement_type || '').toUpperCase();
  const quantity = parseIntValue(String(payload.quantity ?? ''), null);
  const reason = payload.reason == null ? null : String(payload.reason);

  if (!itemId) return c.json(apiErr('INVALID_INPUT', 'item_id가 유효하지 않습니다.'), 400);
  if (!['IN', 'OUT', 'ADJUST'].includes(movementType)) {
    return c.json(apiErr('INVALID_INPUT', 'movement_type은 IN/OUT/ADJUST만 허용됩니다.'), 400);
  }
  if (payload.order_item_id != null) {
    return c.json(apiErr('INVALID_INPUT', '발주 입고는 발주 항목 입고 API를 사용해주세요.'), 400);
  }
  if (quantity === null || (quantity === 0 && movementType !== 'ADJUST')) {
    return c.json(apiErr('INVALID_INPUT', 'quantity는 0이 아닌 정수여야 합니다.'), 400);
  }

  let requestedDelta = 0;
  if (movementType === 'IN') {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return c.json(apiErr('INVALID_INPUT', 'IN은 양수 수량만 허용됩니다.'), 400);
    }
    requestedDelta = quantity;
  } else if (movementType === 'OUT') {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return c.json(apiErr('INVALID_INPUT', 'OUT은 양수 수량만 허용됩니다.'), 400);
    }
    requestedDelta = -quantity;
  } else {
    if (!Number.isInteger(quantity) || quantity < 0) {
      return c.json(apiErr('INVALID_INPUT', 'ADJUST 수량은 0 이상의 정수여야 합니다.'), 400);
    }
  }

  const item = await c.env.DB.prepare(
    'SELECT id, current_stock, is_deleted FROM items WHERE id = ?'
  ).bind(itemId).first<{ id: number; current_stock: number; is_deleted: number }>();
  if (!item || item.is_deleted === 1) {
    return c.json(apiErr('NOT_FOUND', '품목이 존재하지 않거나 삭제되었습니다.'), 404);
  }

  if (movementType !== 'ADJUST' && item.current_stock + requestedDelta < 0) {
    return c.json(apiErr('INVALID_INPUT', '재고가 음수가 됩니다. 현재고를 확인해주세요.'), 400);
  }

  const operationToken = crypto.randomUUID();
  const batchResult = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO stock_transactions
         (item_id, movement_type, quantity, reason, order_item_id, created_by, operation_token)
       SELECT id, ?,
              CASE WHEN ? = 'ADJUST' THEN ? - current_stock ELSE ? END,
              ?, NULL, ?, ?
         FROM items
        WHERE id = ?
          AND is_deleted = 0
          AND CASE WHEN ? = 'ADJUST' THEN ? ELSE current_stock + ? END >= 0`
    ).bind(
      movementType,
      movementType,
      quantity,
      requestedDelta,
      reason,
      principal.userId,
      operationToken,
      itemId,
      movementType,
      quantity,
      requestedDelta,
    ),
    c.env.DB.prepare(
      `UPDATE items
          SET current_stock = current_stock + (
                SELECT quantity FROM stock_transactions WHERE operation_token = ?
              ),
              updated_at = datetime('now')
        WHERE id = ?
          AND EXISTS (SELECT 1 FROM stock_transactions WHERE operation_token = ?)`
    ).bind(operationToken, itemId, operationToken),
    c.env.DB.prepare(
      `INSERT INTO audit_logs
         (actor_user_id, action, entity_type, entity_id, before_json, after_json)
       SELECT ?, 'stock_adjust', 'item', i.id,
              json_object('current_stock', i.current_stock - st.quantity),
              json_object('current_stock', i.current_stock)
         FROM items i
         JOIN stock_transactions st ON st.item_id = i.id
        WHERE st.operation_token = ?`
    ).bind(principal.userId, operationToken),
  ]);

  if ((batchResult[0] as D1Result).meta.changes === 0) {
    return c.json(apiErr('CONFLICT', '재고가 음수가 되어 조정할 수 없습니다. 현재 재고를 확인해주세요.'), 409);
  }

  const after = await c.env.DB.prepare(`SELECT ${ITEM_PUBLIC_COLUMNS} FROM items i WHERE i.id = ?`).bind(itemId).first();
  return c.json(apiOk({ item: after }));
});

app.get('/api/dashboard', async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const from = c.req.query('from') ?? defaultFrom;
  const to = c.req.query('to') ?? today;

  const rows = await c.env.DB.prepare(
    `SELECT i.id, i.name, i.unit, i.current_stock, i.safety_stock,
            i.min_stock, c.name AS category_name,
            MAX(0, i.safety_stock - i.current_stock - (
              SELECT COALESCE(SUM(oi.ordered_qty - oi.received_qty), 0)
              FROM order_items oi
              JOIN purchase_orders po ON po.id = oi.order_id
              WHERE oi.item_id = i.id
                AND oi.is_deleted = 0
                AND po.is_deleted = 0
                AND po.status NOT IN ('canceled', 'fully_received')
            )) AS suggested_qty
       FROM items i
       LEFT JOIN item_categories c ON c.id = i.category_id
      WHERE i.is_deleted = 0
        AND i.safety_stock > 0
        AND i.current_stock < i.safety_stock`
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
          AND po.status IN ('draft', 'ordered', 'partially_received')
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

app.get(purchaseOrderRoutePatterns.collection, async (c) => {
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
    if (!isPurchaseOrderStatus(normalizedStatus)) {
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
    where.push("(po.title LIKE ? ESCAPE '!' OR po.note LIKE ? ESCAPE '!')");
    const escaped = q.replace(/[%_!]/g, '!$&');
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
  return c.json(apiOk(purchaseOrderSummaryListSchema.parse(rows.results)));
});

app.post(purchaseOrderRoutePatterns.collection, async (c) => {
  const principal = c.get('principal') as IdentityPrincipal;
  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const title = String(payload.title || '');
  const note = payload.note == null ? null : String(payload.note);
  const requestedStatus = payload.status == null ? undefined : String(payload.status);
  return purchaseOrderResponse(
    c,
    await purchaseOrders(c.env.DB, principal.userId).createDraft({
      title,
      note,
      ...(requestedStatus === undefined ? {} : { requestedStatus }),
    }),
    purchaseOrderRowResultSchema,
    201,
  );
});

app.post(purchaseOrderRoutePatterns.withItems, async (c) => {
  const principal = c.get('principal') as IdentityPrincipal;
  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const title = String(payload.title || '');
  const note = payload.note == null ? null : String(payload.note);

  if (!title.trim()) return c.json(apiErr('INVALID_INPUT', '발주명은 필수입니다.'), 400);

  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return c.json(apiErr('INVALID_INPUT', '품목 목록은 비어있을 수 없습니다.'), 400);
  }

  const parsedItems: Array<{ itemId: number; orderedQty: number; memo: string | null }> = [];
  for (let index = 0; index < payload.items.length; index += 1) {
    const rawRow = payload.items[index];
    if (rawRow == null || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
      return c.json(apiErr('INVALID_INPUT', `items[${index}] 형식이 올바르지 않습니다.`), 400);
    }

    const row = rawRow as { item_id?: unknown; ordered_qty?: unknown; memo?: unknown };
    const itemId = parseIntValue(row.item_id == null ? undefined : String(row.item_id), null);
    const orderedQty = parseIntValue(row.ordered_qty == null ? undefined : String(row.ordered_qty), null);
    if (itemId === null || itemId <= 0 || orderedQty === null || orderedQty <= 0) {
      return c.json(apiErr('INVALID_INPUT', `items[${index}]의 품목과 수량을 확인해주세요.`), 400);
    }

    parsedItems.push({
      itemId,
      orderedQty,
      memo: row.memo == null ? null : String(row.memo),
    });
  }

  return purchaseOrderResponse(
    c,
    await purchaseOrders(c.env.DB, principal.userId).createDraftWithItems({
      title,
      note,
      items: parsedItems,
    }),
    purchaseOrderRowResultSchema,
    201,
  );
});

app.get(purchaseOrderRoutePatterns.detail, async (c) => {
  const principal = c.get('principal') as IdentityPrincipal;
  const orderId = parseIntValue(c.req.param('id'), null);
  if (!orderId) return c.json(apiErr('INVALID_INPUT', '발주 ID가 유효하지 않습니다.'), 400);
  return purchaseOrderResponse(
    c,
    await purchaseOrders(c.env.DB, principal.userId).getDetail(orderId),
    purchaseOrderDetailSchema,
  );
});

app.patch(purchaseOrderRoutePatterns.detail, async (c) => {
  const principal = c.get('principal') as IdentityPrincipal;
  const id = parseIntValue(c.req.param('id'), null);
  if (!id) return c.json(apiErr('INVALID_INPUT', '발주 ID가 유효하지 않습니다.'), 400);

  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const change: PurchaseOrderRevision = {};

  if ('title' in payload) {
    const title = String(payload.title || '').trim();
    if (!title) {
      return c.json(apiErr('INVALID_INPUT', '발주명은 빈 값이 될 수 없습니다.'), 400);
    }
    change.title = title;
  }

  if ('status' in payload) {
    const status = String(payload.status).trim();
    if (!isPurchaseOrderStatus(status)) {
      return c.json(apiErr('INVALID_STATUS', '발주 상태값이 올바르지 않습니다. 허용값: draft, ordered, partially_received, fully_received, canceled'), 400);
    }
    if (status === 'partially_received' || status === 'fully_received') {
      return c.json(apiErr('INVALID_STATUS_TRANSITION', '부분입고/입고완료 상태는 입고 처리에서 자동으로 변경됩니다.'), 400);
    }
    change.requestedStatus = status;
  }

  if ('note' in payload) {
    change.note = payload.note == null ? null : String(payload.note);
  }

  if ('external_order_ref' in payload) {
    change.externalOrderRef = payload.external_order_ref == null
      ? null
      : String(payload.external_order_ref);
  }

  return purchaseOrderResponse(
    c,
    await purchaseOrders(c.env.DB, principal.userId).revise(id, change),
    purchaseOrderRowResultSchema,
  );
});

app.delete(purchaseOrderRoutePatterns.detail, async (c) => {
  const principal = c.get('principal') as IdentityPrincipal;
  const id = parseIntValue(c.req.param('id'), null);
  if (!id) return c.json(apiErr('INVALID_INPUT', '발주 ID가 유효하지 않습니다.'), 400);
  return purchaseOrderResponse(
    c,
    await purchaseOrders(c.env.DB, principal.userId).deleteDraft(id),
    deletePurchaseOrderResultSchema,
  );
});

app.post(purchaseOrderRoutePatterns.items, async (c) => {
  const principal = c.get('principal') as IdentityPrincipal;
  const orderId = parseIntValue(c.req.param('id'), null);
  if (!orderId) return c.json(apiErr('INVALID_INPUT', '발주 ID가 유효하지 않습니다.'), 400);

  const stage = await purchaseOrders(c.env.DB, principal.userId).stageAddItemsToDraft(orderId);
  if (!stage.ok) return purchaseOrderResponse(c, stage, addPurchaseOrderItemsResultSchema);

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

  if (!rows.length || rows.length !== rawRows.length) {
    return c.json(apiErr('INVALID_INPUT', '항목과 수량을 확인해주세요.'), 400);
  }

  return purchaseOrderResponse(
    c,
    await stage.value.execute(rows),
    addPurchaseOrderItemsResultSchema,
  );
});

app.patch(purchaseOrderRoutePatterns.item, async (c) => {
  const principal = c.get('principal') as IdentityPrincipal;
  const orderId = parseIntValue(c.req.param('id'), null);
  const orderItemId = parseIntValue(c.req.param('itemId'), null);

  if (!orderId || !orderItemId) {
    return c.json(apiErr('INVALID_INPUT', '발주 ID 또는 항목 ID가 유효하지 않습니다.'), 400);
  }

  const stage = await purchaseOrders(c.env.DB, principal.userId).stageEditDraftItem(orderId);
  if (!stage.ok) return purchaseOrderResponse(c, stage, editPurchaseOrderItemResultSchema);

  const payload = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const change: OrderItemRevision = {};

  if ('ordered_qty' in payload) {
    const orderedQty = parseIntValue(String(payload.ordered_qty ?? ''), null);
    if (orderedQty === null || orderedQty <= 0) {
      return c.json(apiErr('INVALID_INPUT', 'ordered_qty는 1 이상의 정수여야 합니다.'), 400);
    }
    change.orderedQty = orderedQty;
  }

  if ('memo' in payload) {
    change.memo = payload.memo == null ? null : String(payload.memo);
  }

  return purchaseOrderResponse(
    c,
    await stage.value.execute(orderItemId, change),
    editPurchaseOrderItemResultSchema,
  );
});

app.post(purchaseOrderRoutePatterns.receive, async (c) => {
  const principal = c.get('principal') as IdentityPrincipal;
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

  const stage = await purchaseOrders(c.env.DB, principal.userId).stageReceive(
    orderId,
    orderItemId,
    qty,
  );
  if (!stage.ok) return purchaseOrderResponse(c, stage, receivePurchaseOrderItemResultSchema);

  const note = payload.note == null ? null : String(payload.note);
  return purchaseOrderResponse(
    c,
    await stage.value.execute(note),
    receivePurchaseOrderItemResultSchema,
  );
});

app.get('/api/audit-logs', async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;

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
