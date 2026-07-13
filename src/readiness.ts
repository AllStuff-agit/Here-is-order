export const D1_READINESS_SCHEMA_VERSION = 'd1-required-schema-v1';

export const D1_REQUIRED_SCHEMA_SQL = `
SELECT 1 AS ready, '${D1_READINESS_SCHEMA_VERSION}' AS schema_version
 WHERE NOT EXISTS (
   SELECT id, username, password_hash, name, is_active, is_deleted,
          created_at, updated_at, deleted_at, role
     FROM users
    WHERE 0
 )
   AND NOT EXISTS (
   SELECT id, token, user_id, expires_at, created_at
     FROM sessions
    WHERE 0
 )
   AND NOT EXISTS (
   SELECT id, name, description, is_deleted, deleted_at, created_at, updated_at
     FROM item_categories
    WHERE 0
 )
   AND NOT EXISTS (
   SELECT id, category_id, name, spec, unit, safety_stock, min_stock,
          current_stock, unit_price, memo, is_deleted, deleted_at, created_at,
          updated_at, creation_token
     FROM items
    WHERE 0
 )
   AND NOT EXISTS (
   SELECT id, item_id, movement_type, quantity, reason, order_item_id,
          created_by, created_at, operation_token
     FROM stock_transactions
    WHERE 0
 )
   AND NOT EXISTS (
   SELECT id, title, status, order_date, external_order_ref, note, is_deleted,
          deleted_at, created_at, updated_at, creation_token
     FROM purchase_orders
    WHERE 0
 )
   AND NOT EXISTS (
   SELECT id, order_id, item_id, ordered_qty, received_qty, memo, is_deleted,
          deleted_at, created_at, updated_at
     FROM order_items
    WHERE 0
 )
   AND NOT EXISTS (
   SELECT id, actor_user_id, action, entity_type, entity_id, before_json,
          after_json, created_at
     FROM audit_logs
    WHERE 0
 )`;

export type D1Readiness =
  | { ready: true; schemaVersion: typeof D1_READINESS_SCHEMA_VERSION }
  | { ready: false };

type ProbeRow = {
  ready: number;
  schema_version: string;
};

function isExactProbeRow(value: unknown): value is ProbeRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  return keys.length === 2
    && keys[0] === 'ready'
    && keys[1] === 'schema_version'
    && row.ready === 1
    && row.schema_version === D1_READINESS_SCHEMA_VERSION;
}

export async function probeRequiredD1Schema(
  db: D1Database | undefined,
): Promise<D1Readiness> {
  if (!db || typeof db.prepare !== 'function') {
    return { ready: false };
  }

  try {
    const result = await db.prepare(D1_REQUIRED_SCHEMA_SQL).all<ProbeRow>();
    if (result.success !== true
      || !Array.isArray(result.results)
      || result.results.length !== 1
      || !isExactProbeRow(result.results[0])) {
      return { ready: false };
    }

    return {
      ready: true,
      schemaVersion: D1_READINESS_SCHEMA_VERSION,
    };
  } catch {
    return { ready: false };
  }
}
