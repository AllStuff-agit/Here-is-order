import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import {
  D1_READINESS_SCHEMA_VERSION,
  D1_REQUIRED_SCHEMA_SQL,
  probeRequiredD1Schema,
} from '../src/readiness';

const REQUIRED_COLUMNS = {
  users: [
    'id',
    'username',
    'password_hash',
    'name',
    'is_active',
    'is_deleted',
    'created_at',
    'updated_at',
    'deleted_at',
    'role',
  ],
  sessions: ['id', 'token', 'user_id', 'expires_at', 'created_at'],
  item_categories: [
    'id',
    'name',
    'description',
    'is_deleted',
    'deleted_at',
    'created_at',
    'updated_at',
  ],
  items: [
    'id',
    'category_id',
    'name',
    'spec',
    'unit',
    'safety_stock',
    'min_stock',
    'current_stock',
    'unit_price',
    'memo',
    'is_deleted',
    'deleted_at',
    'created_at',
    'updated_at',
    'creation_token',
  ],
  stock_transactions: [
    'id',
    'item_id',
    'movement_type',
    'quantity',
    'reason',
    'order_item_id',
    'created_by',
    'created_at',
    'operation_token',
  ],
  purchase_orders: [
    'id',
    'title',
    'status',
    'order_date',
    'external_order_ref',
    'note',
    'is_deleted',
    'deleted_at',
    'created_at',
    'updated_at',
    'creation_token',
  ],
  order_items: [
    'id',
    'order_id',
    'item_id',
    'ordered_qty',
    'received_qty',
    'memo',
    'is_deleted',
    'deleted_at',
    'created_at',
    'updated_at',
  ],
  audit_logs: [
    'id',
    'actor_user_id',
    'action',
    'entity_type',
    'entity_id',
    'before_json',
    'after_json',
    'created_at',
  ],
} as const;

function fakeDb(result: unknown): D1Database {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn(async () => {
        if (result instanceof Error) throw result;
        return result;
      }),
    })),
  } as unknown as D1Database;
}

function readinessRequest(bindings: Record<string, unknown>) {
  return worker.fetch(
    new Request('https://api.example.com/ready'),
    bindings as { DB: D1Database },
  );
}

describe('required D1 schema probe', () => {
  it('compile-checks every required table and column without a mutation statement', () => {
    expect(D1_REQUIRED_SCHEMA_SQL).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|PRAGMA|ATTACH|DETACH|VACUUM)\b/i,
    );

    for (const [table, expectedColumns] of Object.entries(REQUIRED_COLUMNS)) {
      const escapedTable = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = D1_REQUIRED_SCHEMA_SQL.match(new RegExp(
        `NOT\\s+EXISTS\\s*\\(\\s*SELECT\\s+([\\w\\s,]+?)\\s+FROM\\s+${escapedTable}\\s+WHERE\\s+0\\s*\\)`,
        'i',
      ));
      expect(match, `missing compile-only subquery for ${table}`).not.toBeNull();
      const actualColumns = match?.[1]
        .split(',')
        .map((column) => column.trim()) ?? [];
      expect(actualColumns).toEqual(expectedColumns);
    }
  });

  it('returns the exact safe projection against the migrated Miniflare D1', async () => {
    await expect(probeRequiredD1Schema(env.DB)).resolves.toEqual({
      ready: true,
      schemaVersion: 'd1-required-schema-v1',
    });
  });

  it.each([
    ['missing binding', undefined],
    ['query failure', fakeDb(new Error('sensitive missing column detail'))],
    ['empty result', fakeDb({ success: true, results: [] })],
    ['multiple results', fakeDb({
      success: true,
      results: [
        { ready: 1, schema_version: D1_READINESS_SCHEMA_VERSION },
        { ready: 1, schema_version: D1_READINESS_SCHEMA_VERSION },
      ],
    })],
    ['malformed marker', fakeDb({
      success: true,
      results: [{ ready: 0, schema_version: D1_READINESS_SCHEMA_VERSION }],
    })],
    ['wrong schema version', fakeDb({
      success: true,
      results: [{ ready: 1, schema_version: 'unexpected-schema' }],
    })],
    ['extra result field', fakeDb({
      success: true,
      results: [{
        ready: 1,
        schema_version: D1_READINESS_SCHEMA_VERSION,
        leaked: 'row-data',
      }],
    })],
    ['unsuccessful D1 result', fakeDb({
      success: false,
      results: [{ ready: 1, schema_version: D1_READINESS_SCHEMA_VERSION }],
    })],
  ])('fails closed for %s', async (_label, db) => {
    await expect(probeRequiredD1Schema(db as D1Database | undefined)).resolves.toEqual({
      ready: false,
    });
  });
});

describe('GET /ready', () => {
  it('returns the exact safe success envelope without caching', async () => {
    const response = await readinessRequest({ DB: env.DB });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        ready: true,
        schemaVersion: 'd1-required-schema-v1',
      },
    });
  });

  it.each([
    ['missing binding', {}],
    ['query failure', { DB: fakeDb(new Error('secret table token=abc')) }],
    ['empty result', { DB: fakeDb({ success: true, results: [] }) }],
    ['multiple results', { DB: fakeDb({
      success: true,
      results: [
        { ready: 1, schema_version: D1_READINESS_SCHEMA_VERSION },
        { ready: 1, schema_version: D1_READINESS_SCHEMA_VERSION },
      ],
    }) }],
    ['malformed result', { DB: fakeDb({
      success: true,
      results: [{ ready: '1', schema_version: D1_READINESS_SCHEMA_VERSION }],
    }) }],
  ])('returns the same detail-free 503 for %s', async (_label, bindings) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await readinessRequest(bindings);
      const body = await response.text();

      expect(response.status).toBe(503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(JSON.parse(body)).toEqual({
        ok: false,
        error: {
          code: 'NOT_READY',
          message: '서비스가 준비되지 않았습니다.',
        },
      });
      expect(body).not.toMatch(/secret|table|column|token|binding/i);
      expect(error).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith(JSON.stringify({ event: 'd1_readiness_failed' }));
      expect(error.mock.calls.flat().join(' ')).not.toMatch(/secret|table|column|token|binding/i);
    } finally {
      error.mockRestore();
    }
  });

  it('keeps liveness independent when the D1 binding is missing', async () => {
    const response = await worker.fetch(
      new Request('https://api.example.com/health'),
      {} as { DB: D1Database },
    );
    const body = await response.json() as { ok: boolean; data: { ok: boolean; ts: string } };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.ok).toBe(true);
    expect(Number.isNaN(Date.parse(body.data.ts))).toBe(false);
  });
});
