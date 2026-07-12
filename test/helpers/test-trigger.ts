const TEST_TRIGGER_NAME = /^test_[a-z0-9_]+$/;

export async function withTestTrigger<T>(
  db: D1Database,
  triggerName: string,
  createSql: string,
  callback: () => Promise<T>,
): Promise<T> {
  if (!TEST_TRIGGER_NAME.test(triggerName)) {
    throw new Error('Test trigger name must start with test_ and use lowercase identifiers.');
  }

  const createPattern = new RegExp(
    `^\\s*CREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${triggerName}\\b`,
    'i',
  );
  if (!createPattern.test(createSql)) {
    throw new Error(`Trigger SQL must create ${triggerName}.`);
  }

  const dropSql = `DROP TRIGGER IF EXISTS ${triggerName}`;
  await db.prepare(dropSql).run();
  try {
    await db.prepare(createSql).run();
    return await callback();
  } finally {
    await db.prepare(dropSql).run();
  }
}
