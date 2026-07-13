# Wave 0C Overreceipt Status Defense Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a legacy over-received Order Item from making a Purchase Order appear fully received while another active item still has remaining quantity.

**Architecture:** Keep the existing deep `PurchaseOrderModule`, D1 batch, HTTP Adapter, and public response unchanged. Replace only the receipt-time status projection inside the atomic D1 batch: completion is determined by whether any active Order Item has `received_qty < ordered_qty`, not by whether aggregate received quantity reaches aggregate ordered quantity.

**Tech Stack:** TypeScript 5.6, Hono 4, Cloudflare Workers/D1, Vitest 4, Miniflare D1.

## Global Constraints

- Preserve every valid Purchase Order lifecycle result, HTTP path, response shape, error code, Korean message, stock movement, audit fact, and D1 batch order.
- Change behavior only for invalid legacy rows where `received_qty > ordered_qty` can offset another active row's remaining quantity.
- Do not mutate or clamp legacy production data in this delivery.
- Do not add a schema migration, repository Interface, or new dependency.
- Keep the status decision inside `src/purchase-orders.ts`; the Hono Adapter must remain unchanged.
- Use 2-space indentation, single quotes, and semicolons.
- Follow RED → GREEN → REFACTOR and record the focused failing and passing commands.
- Commit only the two files listed in this plan.

---

### Task 1: Derive receipt status from item-level remaining quantity

**Files:**
- Modify: `test/purchase-orders.integration.test.ts:617-684`
- Modify: `src/purchase-orders.ts:832-847`

**Interfaces:**
- Consumes: existing `PurchaseOrderModule.receive(orderId, orderItemId, receipt)` and the existing active `order_items` projection.
- Produces: the same `PurchaseOrderResult<PartialReceiptResult>` Interface, with corrected `order.status` for legacy over-received data.

- [ ] **Step 1: Change the legacy characterization into the failing corrected expectation**

Apply this exact two-line patch to the existing test; every fixture and trigger line between them remains unchanged:

```diff
-  it('retains greater-than-or-equal status aggregation for legacy over-received rows', async () => {
+  it('does not let a legacy over-received row hide another item remaining quantity', async () => {
     const { module } = await createActor();
     const legacyItemId = await createInventoryItem('legacy over-received 원두');
     const targetItemId = await createInventoryItem('legacy receipt target 원두');
@@
     expect(received).toEqual({
       ok: true,
       value: {
-        order: expect.objectContaining({ status: 'fully_received' }),
+        order: expect.objectContaining({ status: 'partially_received' }),
         order_item: expect.objectContaining({
           id: targetOrderItem.id,
           received_qty: 1,
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm exec -- vitest run test/purchase-orders.integration.test.ts -t "does not let a legacy over-received row hide"
```

Expected: FAIL because the existing aggregate `SUM(received_qty) >= SUM(ordered_qty)` returns `fully_received`.

- [ ] **Step 3: Replace aggregate offset logic with item-level predicates**

In the `UPDATE purchase_orders` statement inside `receiveStagedOrderItem`, replace the scalar status `CASE` with this exact projection:

```sql
SELECT CASE
  WHEN SUM(
         CASE WHEN received_qty < ordered_qty THEN 1 ELSE 0 END
       ) = 0
    THEN 'fully_received'
  WHEN SUM(
         CASE WHEN received_qty > 0 THEN 1 ELSE 0 END
       ) > 0
    THEN 'partially_received'
  ELSE 'ordered'
END
  FROM order_items
 WHERE order_id = ? AND is_deleted = 0
```

The surrounding statement and bind list remain structurally unchanged:

```ts
db.prepare(
  `UPDATE purchase_orders
      SET status = (
            SELECT CASE
              WHEN SUM(
                     CASE WHEN received_qty < ordered_qty THEN 1 ELSE 0 END
                   ) = 0
                THEN 'fully_received'
              WHEN SUM(
                     CASE WHEN received_qty > 0 THEN 1 ELSE 0 END
                   ) > 0
                THEN 'partially_received'
              ELSE 'ordered'
            END
              FROM order_items
             WHERE order_id = ? AND is_deleted = 0
          ),
          updated_at = datetime('now')
    WHERE id = ? AND status IN ('ordered', 'partially_received')
      AND EXISTS (
        SELECT 1 FROM stock_transactions WHERE operation_token = ?
      )`,
).bind(orderId, orderId, operationToken),
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npm exec -- vitest run test/purchase-orders.integration.test.ts -t "does not let a legacy over-received row hide"
```

Expected: PASS.

- [ ] **Step 5: Run all Purchase Order Module and HTTP integration tests**

Run:

```bash
npm exec -- vitest run test/purchase-orders.integration.test.ts test/api.integration.test.ts
```

Expected: all tests pass. Existing valid cases must still produce `ordered`, `partially_received`, and `fully_received` exactly as before.

- [ ] **Step 6: Run static verification**

Run:

```bash
npm run typecheck
npm run build
npm test
git diff --check
```

Expected: TypeScript, Wrangler dry-run, the full root suite, and whitespace validation succeed.

- [ ] **Step 7: Commit the isolated correctness fix**

```bash
git add src/purchase-orders.ts test/purchase-orders.integration.test.ts
git commit -m "fix: derive receipt status from item remaining quantities"
```

---

## Plan Completion Gate

- The focused regression is observed failing before the SQL change and passing afterward.
- All Purchase Order Module and HTTP integration tests pass.
- No migration, frontend, contract, or response shape changes are present.
- `git diff --check` reports no whitespace errors.
