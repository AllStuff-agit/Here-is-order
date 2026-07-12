import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { purchaseOrders } from '../src/purchase-orders';

const TABLES_IN_DELETE_ORDER = [
  'stock_transactions',
  'order_items',
  'audit_logs',
  'sessions',
  'purchase_orders',
  'items',
  'item_categories',
  'users',
] as const;

beforeEach(async () => {
  await env.DB.batch(
    TABLES_IN_DELETE_ORDER.map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
});

async function createActor() {
  const result = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, name, role)
     VALUES (?, ?, ?, 'admin')`,
  ).bind(`actor-${crypto.randomUUID()}`, 'unused', '관리자').run();
  const actorUserId = Number(result.meta.last_row_id);
  return { actorUserId, module: purchaseOrders(env.DB, actorUserId) };
}

async function createInventoryItem(name: string) {
  const result = await env.DB.prepare(
    `INSERT INTO items (name, unit, safety_stock, min_stock, current_stock, unit_price)
     VALUES (?, '개', 0, 0, 0, 0)`,
  ).bind(name).run();
  return Number(result.meta.last_row_id);
}

describe('Purchase Order module draft creation', () => {
  it('creates and reads a plain draft through the module interface', async () => {
    const { module } = await createActor();
    const created = await module.createDraft({
      title: 'module 초안',
      note: null,
      requestedStatus: 'draft',
    });
    expect(created).toEqual({
      ok: true,
      value: expect.objectContaining({ title: 'module 초안', status: 'draft' }),
    });
    if (!created.ok || !created.value) throw new Error('expected draft creation success');

    const detail = await module.getDetail(created.value.id);
    expect(detail).toEqual({
      ok: true,
      value: expect.objectContaining({
        id: created.value.id,
        title: 'module 초안',
        items: [],
      }),
    });
  });

  it('returns the plain draft row when it is deleted before readback', async () => {
    await env.DB.prepare(
      `CREATE TRIGGER test_delete_plain_draft_before_readback
       AFTER UPDATE OF creation_token ON purchase_orders
       WHEN OLD.creation_token IS NOT NULL AND NEW.creation_token IS NULL
       BEGIN
         UPDATE purchase_orders
            SET is_deleted = 1, deleted_at = datetime('now')
          WHERE id = NEW.id;
       END`,
    ).run();

    try {
      const { module } = await createActor();
      const created = await module.createDraft({
        title: 'readback 초안',
        note: null,
      });

      expect(created).toEqual({
        ok: true,
        value: expect.objectContaining({
          title: 'readback 초안',
          is_deleted: 1,
        }),
      });
    } finally {
      await env.DB.prepare(
        'DROP TRIGGER IF EXISTS test_delete_plain_draft_before_readback',
      ).run();
    }
  });

  it('returns null when a plain draft disappears before readback', async () => {
    await env.DB.prepare(
      `CREATE TRIGGER test_remove_plain_draft_before_readback
       AFTER UPDATE OF creation_token ON purchase_orders
       WHEN OLD.creation_token IS NOT NULL AND NEW.creation_token IS NULL
       BEGIN
         DELETE FROM purchase_orders WHERE id = NEW.id;
       END`,
    ).run();

    try {
      const { module } = await createActor();
      const created = await module.createDraft({
        title: 'null plain readback 초안',
        note: null,
      });

      expect(created).toEqual({ ok: true, value: null });
    } finally {
      await env.DB.prepare(
        'DROP TRIGGER IF EXISTS test_remove_plain_draft_before_readback',
      ).run();
    }
  });

  it('atomically merges populated draft rows and preserves create memo precedence', async () => {
    const { module } = await createActor();
    const itemId = await createInventoryItem('module 원두');
    const created = await module.createDraftWithItems({
      title: 'module populated 초안',
      note: null,
      items: [
        { itemId, orderedQty: 1, memo: '첫 memo' },
        { itemId, orderedQty: 2, memo: '' },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok || !created.value) {
      throw new Error('expected populated draft creation success');
    }

    const detail = await module.getDetail(created.value.id);
    expect(detail).toEqual({
      ok: true,
      value: expect.objectContaining({
        items: [expect.objectContaining({ item_id: itemId, ordered_qty: 3, memo: '' })],
      }),
    });

    const audits = await env.DB.prepare(
      `SELECT action, entity_type, before_json, after_json
         FROM audit_logs ORDER BY id ASC`,
    ).all<{
      action: string;
      entity_type: string;
      before_json: string | null;
      after_json: string;
    }>();
    expect(audits.results).toHaveLength(2);
    expect(audits.results[0]).toEqual(expect.objectContaining({
      action: 'create',
      entity_type: 'order_item',
      before_json: null,
      after_json: JSON.stringify({
        item_id: itemId,
        ordered_qty: 3,
        received_qty: 0,
        memo: '',
      }),
    }));
    expect(audits.results[1]).toEqual(expect.objectContaining({
      action: 'create',
      entity_type: 'purchase_order',
      before_json: null,
      after_json: JSON.stringify({
        title: 'module populated 초안',
        status: 'draft',
        note: null,
        items: [{ itemId, orderedQty: 3, memo: '' }],
      }),
    }));
  });

  it('returns null when a populated draft is deleted before active readback', async () => {
    const { module } = await createActor();
    const itemId = await createInventoryItem('null readback 원두');
    await env.DB.prepare(
      `CREATE TRIGGER test_delete_populated_draft_before_readback
       AFTER UPDATE OF creation_token ON purchase_orders
       WHEN OLD.creation_token IS NOT NULL AND NEW.creation_token IS NULL
       BEGIN
         UPDATE purchase_orders
            SET is_deleted = 1, deleted_at = datetime('now')
          WHERE id = NEW.id;
       END`,
    ).run();

    try {
      const created = await module.createDraftWithItems({
        title: 'null readback 초안',
        note: null,
        items: [{ itemId, orderedQty: 1, memo: null }],
      });

      expect(created).toEqual({ ok: true, value: null });
    } finally {
      await env.DB.prepare(
        'DROP TRIGGER IF EXISTS test_delete_populated_draft_before_readback',
      ).run();
    }
  });

  it('rejects every row when one populated draft item is invalid', async () => {
    const { module } = await createActor();
    const itemId = await createInventoryItem('rollback 원두');
    const result = await module.createDraftWithItems({
      title: 'rollback 초안',
      note: null,
      items: [
        { itemId, orderedQty: 1, memo: null },
        { itemId, orderedQty: 0, memo: null },
      ],
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: 'invalid', code: 'INVALID_INPUT' }),
    });
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM purchase_orders WHERE title = ?`,
    ).bind('rollback 초안').first<{ count: number }>();
    expect(Number(row?.count ?? 0)).toBe(0);
  });
});

describe('Purchase Order module revision and deletion', () => {
  it('preserves same-status updates and terminal metadata revisions', async () => {
    const { module } = await createActor();
    const itemId = await createInventoryItem('revision 원두');
    const created = await module.createDraftWithItems({
      title: 'revision 발주',
      note: null,
      items: [{ itemId, orderedQty: 1, memo: null }],
    });
    if (!created.ok || !created.value) throw new Error('expected creation success');

    const confirmed = await module.revise(created.value.id, { requestedStatus: 'ordered' });
    expect(confirmed).toEqual({
      ok: true,
      value: expect.objectContaining({ status: 'ordered' }),
    });
    const sameStatus = await module.revise(created.value.id, { requestedStatus: 'ordered' });
    expect(sameStatus.ok).toBe(true);

    await env.DB.prepare(
      `UPDATE purchase_orders SET status = 'fully_received' WHERE id = ?`,
    ).bind(created.value.id).run();
    const metadata = await module.revise(created.value.id, {
      title: '완료 후 수정',
      note: '완료 memo',
      externalOrderRef: 'external-2',
    });
    expect(metadata).toEqual({
      ok: true,
      value: expect.objectContaining({
        title: '완료 후 수정',
        status: 'fully_received',
        note: '완료 memo',
        external_order_ref: 'external-2',
      }),
    });
  });

  it('returns null when a revised order is deleted before active readback', async () => {
    const { module } = await createActor();
    const created = await module.createDraft({
      title: 'revision readback 초안',
      note: null,
    });
    if (!created.ok || !created.value) throw new Error('expected creation success');

    await env.DB.prepare(
      `CREATE TRIGGER test_delete_revised_order_before_readback
       AFTER INSERT ON audit_logs
       WHEN NEW.action = 'update' AND NEW.entity_type = 'purchase_order'
       BEGIN
         UPDATE purchase_orders
            SET is_deleted = 1, deleted_at = datetime('now')
          WHERE id = NEW.entity_id;
       END`,
    ).run();

    try {
      const revised = await module.revise(created.value.id, {
        title: 'revision readback 수정',
      });
      expect(revised).toEqual({ ok: true, value: null });
    } finally {
      await env.DB.prepare(
        'DROP TRIGGER IF EXISTS test_delete_revised_order_before_readback',
      ).run();
    }
  });

  it('deletes only an unreceived draft and rejects received rows even when deleted', async () => {
    const { module } = await createActor();
    const itemId = await createInventoryItem('delete 원두');
    const deletable = await module.createDraft({ title: '삭제 가능', note: null });
    if (!deletable.ok || !deletable.value) throw new Error('expected creation success');
    await expect(module.deleteDraft(deletable.value.id)).resolves.toEqual({
      ok: true,
      value: { deleted: true },
    });

    const blocked = await module.createDraftWithItems({
      title: '삭제 충돌',
      note: null,
      items: [{ itemId, orderedQty: 1, memo: null }],
    });
    if (!blocked.ok || !blocked.value) throw new Error('expected creation success');
    await env.DB.prepare(
      `UPDATE order_items
          SET received_qty = 1, is_deleted = 1, deleted_at = datetime('now')
        WHERE order_id = ?`,
    ).bind(blocked.value.id).run();
    await expect(module.deleteDraft(blocked.value.id)).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({
        kind: 'conflict',
        code: 'ORDER_DELETE_CONFLICT',
      }),
    });
  });
});
