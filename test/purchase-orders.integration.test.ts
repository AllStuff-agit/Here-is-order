import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { purchaseOrders } from '../src/purchase-orders';
import { withTestTrigger } from './helpers/test-trigger';

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

describe('test trigger helper', () => {
  it('rejects trigger names outside the controlled test namespace', async () => {
    await expect(withTestTrigger(
      env.DB,
      'unsafe_trigger',
      'CREATE TRIGGER unsafe_trigger AFTER INSERT ON users BEGIN SELECT 1; END',
      async () => undefined,
    )).rejects.toThrow('test_');
  });

  it('replaces stale fixtures and drops the trigger after callback failure', async () => {
    const triggerName = 'test_helper_cleanup';
    const triggerSql = `CREATE TRIGGER ${triggerName}
      AFTER INSERT ON users
      BEGIN
        SELECT 1;
      END`;
    await env.DB.prepare(triggerSql).run();

    await expect(withTestTrigger(
      env.DB,
      triggerName,
      triggerSql,
      async () => {
        throw new Error('expected callback failure');
      },
    )).rejects.toThrow('expected callback failure');

    const trigger = await env.DB.prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = ?`,
    ).bind(triggerName).first();
    expect(trigger).toBeNull();
  });
});

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
    await withTestTrigger(
      env.DB,
      'test_delete_plain_draft_before_readback',
      `CREATE TRIGGER test_delete_plain_draft_before_readback
       AFTER UPDATE OF creation_token ON purchase_orders
       WHEN OLD.creation_token IS NOT NULL AND NEW.creation_token IS NULL
       BEGIN
         UPDATE purchase_orders
            SET is_deleted = 1, deleted_at = datetime('now')
          WHERE id = NEW.id;
       END`,
      async () => {
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
      },
    );
  });

  it('returns null when a plain draft disappears before readback', async () => {
    await withTestTrigger(
      env.DB,
      'test_remove_plain_draft_before_readback',
      `CREATE TRIGGER test_remove_plain_draft_before_readback
       AFTER UPDATE OF creation_token ON purchase_orders
       WHEN OLD.creation_token IS NOT NULL AND NEW.creation_token IS NULL
       BEGIN
         DELETE FROM purchase_orders WHERE id = NEW.id;
       END`,
      async () => {
        const { module } = await createActor();
        const created = await module.createDraft({
          title: 'null plain readback 초안',
          note: null,
        });

        expect(created).toEqual({ ok: true, value: null });
      },
    );
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
    await withTestTrigger(
      env.DB,
      'test_delete_populated_draft_before_readback',
      `CREATE TRIGGER test_delete_populated_draft_before_readback
       AFTER UPDATE OF creation_token ON purchase_orders
       WHEN OLD.creation_token IS NOT NULL AND NEW.creation_token IS NULL
       BEGIN
         UPDATE purchase_orders
            SET is_deleted = 1, deleted_at = datetime('now')
          WHERE id = NEW.id;
       END`,
      async () => {
        const created = await module.createDraftWithItems({
          title: 'null readback 초안',
          note: null,
          items: [{ itemId, orderedQty: 1, memo: null }],
        });

        expect(created).toEqual({ ok: true, value: null });
      },
    );
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

    await withTestTrigger(
      env.DB,
      'test_delete_revised_order_before_readback',
      `CREATE TRIGGER test_delete_revised_order_before_readback
       AFTER INSERT ON audit_logs
       WHEN NEW.action = 'update' AND NEW.entity_type = 'purchase_order'
       BEGIN
         UPDATE purchase_orders
            SET is_deleted = 1, deleted_at = datetime('now')
          WHERE id = NEW.entity_id;
       END`,
      async () => {
        const revised = await module.revise(created.value.id, {
          title: 'revision readback 수정',
        });
        expect(revised).toEqual({ ok: true, value: null });
      },
    );
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

describe('Purchase Order module draft items', () => {
  it('adds, merges, returns all active rows, clears existing memo, and revises an item', async () => {
    const { module } = await createActor();
    const firstItemId = await createInventoryItem('item 원두');
    const secondItemId = await createInventoryItem('item 우유');
    const draft = await module.createDraft({ title: 'item 초안', note: null });
    if (!draft.ok || !draft.value) throw new Error('expected creation success');

    const added = await module.addItemsToDraft(draft.value.id, [
      { itemId: firstItemId, orderedQty: 1, memo: '첫 memo' },
      { itemId: firstItemId, orderedQty: 2, memo: '' },
      { itemId: secondItemId, orderedQty: 1, memo: '우유 memo' },
    ]);
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error('expected add success');
    expect(added.value.items).toHaveLength(2);
    const first = added.value.items.find((row) => row.item_id === firstItemId);
    expect(first).toEqual(expect.objectContaining({ ordered_qty: 3, memo: '첫 memo' }));

    const cleared = await module.addItemsToDraft(draft.value.id, [
      { itemId: firstItemId, orderedQty: 1, memo: null },
    ]);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) throw new Error('expected clear memo success');
    const clearedFirst = cleared.value.items.find((row) => row.item_id === firstItemId);
    expect(clearedFirst).toEqual(expect.objectContaining({ ordered_qty: 4, memo: null }));

    const revised = await module.editDraftItem(draft.value.id, first!.id, {
      orderedQty: 5,
      memo: '수정 memo',
    });
    expect(revised).toEqual({
      ok: true,
      value: expect.objectContaining({ ordered_qty: 5, memo: '수정 memo' }),
    });
  });

  it('rejects item changes after confirmation', async () => {
    const { module } = await createActor();
    const itemId = await createInventoryItem('confirmed 원두');
    const draft = await module.createDraftWithItems({
      title: 'confirmed 발주',
      note: null,
      items: [{ itemId, orderedQty: 1, memo: null }],
    });
    if (!draft.ok || !draft.value) throw new Error('expected creation success');
    const detail = await module.getDetail(draft.value.id);
    if (!detail.ok) throw new Error('expected detail success');
    await module.revise(draft.value.id, { requestedStatus: 'ordered' });

    const added = await module.addItemsToDraft(draft.value.id, [
      { itemId, orderedQty: 1, memo: null },
    ]);
    expect(added).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: 'invalid', code: 'INVALID_STATUS' }),
    });
    const edited = await module.editDraftItem(
      draft.value.id,
      detail.value.items[0].id,
      { orderedQty: 2 },
    );
    expect(edited).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: 'invalid', code: 'INVALID_STATUS' }),
    });
  });

  it('returns null when a revised item disappears before readback', async () => {
    const { module } = await createActor();
    const itemId = await createInventoryItem('item readback 원두');
    const draft = await module.createDraftWithItems({
      title: 'item readback 초안',
      note: null,
      items: [{ itemId, orderedQty: 1, memo: null }],
    });
    if (!draft.ok || !draft.value) throw new Error('expected creation success');
    const detail = await module.getDetail(draft.value.id);
    if (!detail.ok) throw new Error('expected detail success');
    const orderItemId = detail.value.items[0].id;

    await withTestTrigger(
      env.DB,
      'test_remove_revised_item_before_readback',
      `CREATE TRIGGER test_remove_revised_item_before_readback
       AFTER INSERT ON audit_logs
       WHEN NEW.action = 'update' AND NEW.entity_type = 'order_item'
       BEGIN
         DELETE FROM order_items WHERE id = NEW.entity_id;
       END`,
      async () => {
        const revised = await module.editDraftItem(draft.value.id, orderItemId, {
          memo: 'readback memo',
        });
        expect(revised).toEqual({ ok: true, value: null });
      },
    );
  });
});

describe('Purchase Order module partial receipt', () => {
  it('allows one concurrent receipt and keeps stock, ledger, status, and audit aligned', async () => {
    const { actorUserId, module } = await createActor();
    const itemId = await createInventoryItem('receive 원두');
    const draft = await module.createDraftWithItems({
      title: 'receive 발주',
      note: null,
      items: [{ itemId, orderedQty: 5, memo: null }],
    });
    if (!draft.ok || !draft.value) throw new Error('expected creation success');
    const detail = await module.getDetail(draft.value.id);
    if (!detail.ok) throw new Error('expected detail success');
    const orderItemId = detail.value.items[0].id;
    const confirmed = await module.revise(draft.value.id, {
      requestedStatus: 'ordered',
    });
    expect(confirmed).toEqual({
      ok: true,
      value: expect.objectContaining({ status: 'ordered' }),
    });

    const receive = () => module.receive(draft.value.id, orderItemId, {
      quantity: 4,
      note: null,
    });
    const results = await Promise.all([receive(), receive()]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      {
        ok: false,
        error: {
          kind: 'conflict',
          code: 'RECEIVE_CONFLICT',
          message: '남은 입고 수량 또는 발주 상태가 변경되었습니다.',
        },
      },
    ]);

    const item = await env.DB.prepare(
      `SELECT current_stock FROM items WHERE id = ?`,
    ).bind(itemId).first<{ current_stock: number }>();
    expect(item?.current_stock).toBe(4);
    const ledger = await env.DB.prepare(
      `SELECT quantity, reason, order_item_id, operation_token
         FROM stock_transactions WHERE item_id = ?`,
    ).bind(itemId).all<{
      quantity: number;
      reason: string;
      order_item_id: number;
      operation_token: string | null;
    }>();
    expect(ledger.results).toEqual([
      expect.objectContaining({
        quantity: 4,
        reason: '부분입고 처리',
        order_item_id: orderItemId,
      }),
    ]);
    expect(ledger.results[0].operation_token).not.toBeNull();

    const after = await module.getDetail(draft.value.id);
    expect(after).toEqual({
      ok: true,
      value: expect.objectContaining({
        status: 'partially_received',
        items: [expect.objectContaining({ received_qty: 4, remaining_qty: 1 })],
      }),
    });
    const audit = await env.DB.prepare(
      `SELECT action, entity_type, actor_user_id, before_json, after_json
         FROM audit_logs
        WHERE action = 'receive' AND entity_type = 'order_item' AND entity_id = ?`,
    ).bind(orderItemId).all();
    expect(audit.results).toEqual([
      expect.objectContaining({
        actor_user_id: actorUserId,
        before_json: JSON.stringify({
          id: orderItemId,
          item_id: itemId,
          ordered_qty: 5,
          received_qty: 0,
        }),
        after_json: JSON.stringify({
          id: orderItemId,
          item_id: itemId,
          ordered_qty: 5,
          received_qty: 4,
        }),
      }),
    ]);
  });

  it('rolls back receipt stock and quantities when receive audit insertion fails', async () => {
    const { module } = await createActor();
    const itemId = await createInventoryItem('rollback receive 원두');
    const draft = await module.createDraftWithItems({
      title: 'rollback receive 발주',
      note: null,
      items: [{ itemId, orderedQty: 2, memo: null }],
    });
    if (!draft.ok || !draft.value) throw new Error('expected creation success');
    const detail = await module.getDetail(draft.value.id);
    if (!detail.ok) throw new Error('expected detail success');
    const confirmed = await module.revise(draft.value.id, {
      requestedStatus: 'ordered',
    });
    expect(confirmed).toEqual({
      ok: true,
      value: expect.objectContaining({ status: 'ordered' }),
    });

    await withTestTrigger(
      env.DB,
      'test_fail_receive_audit',
      `CREATE TRIGGER test_fail_receive_audit
       BEFORE INSERT ON audit_logs
       WHEN NEW.action = 'receive'
       BEGIN
         SELECT RAISE(ABORT, 'TEST_RECEIVE_AUDIT_FAILURE');
       END`,
      async () => {
        const received = await module.receive(
          draft.value.id,
          detail.value.items[0].id,
          { quantity: 1, note: '' },
        );
        expect(received).toEqual({
          ok: false,
          error: expect.objectContaining({
            kind: 'conflict',
            code: 'RECEIVE_CONFLICT',
          }),
        });
      },
    );

    const item = await env.DB.prepare(
      `SELECT current_stock FROM items WHERE id = ?`,
    ).bind(itemId).first<{ current_stock: number }>();
    expect(item?.current_stock).toBe(0);
    const orderItem = await env.DB.prepare(
      `SELECT received_qty FROM order_items WHERE id = ?`,
    ).bind(detail.value.items[0].id).first<{ received_qty: number }>();
    expect(orderItem?.received_qty).toBe(0);
    const ledgerCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM stock_transactions WHERE item_id = ?`,
    ).bind(itemId).first<{ count: number }>();
    expect(Number(ledgerCount?.count ?? 0)).toBe(0);
  });

  it('retains greater-than-or-equal status aggregation for legacy over-received rows', async () => {
    const { module } = await createActor();
    const legacyItemId = await createInventoryItem('legacy over-received 원두');
    const targetItemId = await createInventoryItem('legacy receipt target 원두');
    const draft = await module.createDraftWithItems({
      title: 'legacy aggregation 발주',
      note: null,
      items: [
        { itemId: legacyItemId, orderedQty: 1, memo: null },
        { itemId: targetItemId, orderedQty: 2, memo: null },
      ],
    });
    if (!draft.ok || !draft.value) throw new Error('expected creation success');
    const detail = await module.getDetail(draft.value.id);
    if (!detail.ok) throw new Error('expected detail success');
    const legacyOrderItem = detail.value.items.find(
      (row) => row.item_id === legacyItemId,
    );
    const targetOrderItem = detail.value.items.find(
      (row) => row.item_id === targetItemId,
    );
    if (!legacyOrderItem || !targetOrderItem) {
      throw new Error('expected both order items');
    }
    const confirmed = await module.revise(draft.value.id, {
      requestedStatus: 'ordered',
    });
    expect(confirmed).toEqual({
      ok: true,
      value: expect.objectContaining({ status: 'ordered' }),
    });

    await env.DB.prepare(
      'DROP TRIGGER IF EXISTS trg_order_items_validate_update',
    ).run();
    try {
      await env.DB.prepare(
        `UPDATE order_items SET received_qty = 3 WHERE id = ?`,
      ).bind(legacyOrderItem.id).run();
    } finally {
      await env.DB.prepare(
        `CREATE TRIGGER IF NOT EXISTS trg_order_items_validate_update
         BEFORE UPDATE OF order_id, item_id, ordered_qty, received_qty, is_deleted ON order_items
         WHEN NEW.ordered_qty <= 0 OR NEW.received_qty < 0 OR NEW.received_qty > NEW.ordered_qty
           OR NEW.is_deleted NOT IN (0, 1)
           OR (NEW.is_deleted = 0 AND (
             NOT EXISTS (SELECT 1 FROM items i WHERE i.id = NEW.item_id AND i.is_deleted = 0)
             OR NOT EXISTS (
               SELECT 1 FROM purchase_orders po
                WHERE po.id = NEW.order_id AND po.is_deleted = 0
             )
           ))
         BEGIN
           SELECT RAISE(ABORT, 'INVALID_ORDER_ITEM');
         END`,
      ).run();
    }

    const received = await module.receive(
      draft.value.id,
      targetOrderItem.id,
      { quantity: 1, note: null },
    );
    expect(received).toEqual({
      ok: true,
      value: {
        order: expect.objectContaining({ status: 'fully_received' }),
        order_item: expect.objectContaining({
          id: targetOrderItem.id,
          received_qty: 1,
        }),
      },
    });
  });

  it('returns independently nullable order and order-item receipt readbacks', async () => {
    const { module } = await createActor();

    const removedItemId = await createInventoryItem('removed receipt item 원두');
    const removedItemDraft = await module.createDraftWithItems({
      title: 'removed receipt item 발주',
      note: null,
      items: [{ itemId: removedItemId, orderedQty: 1, memo: 'item memo' }],
    });
    if (!removedItemDraft.ok || !removedItemDraft.value) {
      throw new Error('expected creation success');
    }
    const removedItemDetail = await module.getDetail(removedItemDraft.value.id);
    if (!removedItemDetail.ok) throw new Error('expected detail success');
    const removedOrderItemId = removedItemDetail.value.items[0].id;
    const removedItemConfirmed = await module.revise(
      removedItemDraft.value.id,
      { requestedStatus: 'ordered' },
    );
    expect(removedItemConfirmed).toEqual({
      ok: true,
      value: expect.objectContaining({ status: 'ordered' }),
    });

    await withTestTrigger(
      env.DB,
      'test_remove_received_item_before_readback',
      `CREATE TRIGGER test_remove_received_item_before_readback
       AFTER INSERT ON audit_logs
       WHEN NEW.action = 'receive'
         AND NEW.entity_type = 'order_item'
         AND NEW.entity_id = ${removedOrderItemId}
       BEGIN
         DELETE FROM order_items WHERE id = NEW.entity_id;
       END`,
      async () => {
        const received = await module.receive(
          removedItemDraft.value.id,
          removedOrderItemId,
          { quantity: 1, note: null },
        );
        expect(received).toEqual({
          ok: true,
          value: {
            order: expect.objectContaining({
              id: removedItemDraft.value.id,
              status: 'fully_received',
            }),
            order_item: null,
          },
        });
      },
    );

    const removedOrderItemInventoryId = await createInventoryItem(
      'removed receipt order 원두',
    );
    const removedOrderDraft = await module.createDraftWithItems({
      title: 'removed receipt order 발주',
      note: null,
      items: [{
        itemId: removedOrderItemInventoryId,
        orderedQty: 1,
        memo: 'order memo',
      }],
    });
    if (!removedOrderDraft.ok || !removedOrderDraft.value) {
      throw new Error('expected creation success');
    }
    const removedOrderDetail = await module.getDetail(removedOrderDraft.value.id);
    if (!removedOrderDetail.ok) throw new Error('expected detail success');
    const retainedOrderItemId = removedOrderDetail.value.items[0].id;
    const removedOrderConfirmed = await module.revise(
      removedOrderDraft.value.id,
      { requestedStatus: 'ordered' },
    );
    expect(removedOrderConfirmed).toEqual({
      ok: true,
      value: expect.objectContaining({ status: 'ordered' }),
    });
    const holdingOrder = await module.createDraft({
      title: 'receipt readback holding order',
      note: null,
    });
    if (!holdingOrder.ok || !holdingOrder.value) {
      throw new Error('expected holding order creation success');
    }

    await withTestTrigger(
      env.DB,
      'test_remove_received_order_before_readback',
      `CREATE TRIGGER test_remove_received_order_before_readback
       AFTER INSERT ON audit_logs
       WHEN NEW.action = 'receive'
         AND NEW.entity_type = 'order_item'
         AND NEW.entity_id = ${retainedOrderItemId}
       BEGIN
         UPDATE order_items
            SET order_id = ${holdingOrder.value.id}
          WHERE id = NEW.entity_id;
         DELETE FROM purchase_orders WHERE id = ${removedOrderDraft.value.id};
       END`,
      async () => {
        const received = await module.receive(
          removedOrderDraft.value.id,
          retainedOrderItemId,
          { quantity: 1, note: '' },
        );
        expect(received).toEqual({
          ok: true,
          value: {
            order: null,
            order_item: {
              id: retainedOrderItemId,
              item_id: removedOrderItemInventoryId,
              ordered_qty: 1,
              received_qty: 1,
              memo: 'order memo',
            },
          },
        });
      },
    );
  });
});
