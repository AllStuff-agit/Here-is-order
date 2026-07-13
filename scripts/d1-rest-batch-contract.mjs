import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCloudflareD1RestClient } from './cloudflare-d1-rest.mjs';

const ROLLBACK_GUARD_MARKER = 'hio_rollback_guard';
const D1_QUERY_ERROR_CODE = 7500;

const delay = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

function hasExactMarker(message) {
  return new RegExp(
    `(?:^|[^A-Za-z0-9_])${ROLLBACK_GUARD_MARKER}(?:$|[^A-Za-z0-9_])`,
  ).test(message);
}

function isExpectedConstraintFailure(failure) {
  if (!failure
    || failure.httpOk !== false
    || failure.httpStatus !== 400
    || failure.envelope?.success !== false
    || !Array.isArray(failure.envelope.errors)
    || failure.envelope.errors.length !== 1) {
    return false;
  }

  const [error] = failure.envelope.errors;
  return error?.code === D1_QUERY_ERROR_CODE
    && typeof error.message === 'string'
    && hasExactMarker(error.message);
}

async function retryReady(operation, sleep = delay) {
  let lastError;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < 10) await sleep(500);
    }
  }
  throw lastError;
}

export async function runD1RestBatchContract({
  client,
  runId,
  runAttempt,
  sleep = delay,
  log = console.log,
}) {
  const databaseName = `hio-rb-${runId}-${runAttempt}`.slice(0, 32);
  let database;
  try {
    database = await client.createDatabase(databaseName);
    await retryReady(() => client.query(database.uuid, {
      sql: 'CREATE TABLE contract_state(id INTEGER PRIMARY KEY, value INTEGER)',
      params: [],
    }), sleep);
    await client.query(database.uuid, {
      sql: 'CREATE TABLE contract_guard(value INTEGER CONSTRAINT hio_rollback_guard CHECK(value = 0))',
      params: [],
    });
    await client.query(database.uuid, {
      sql: 'INSERT INTO contract_state(id, value) VALUES (?, ?)',
      params: ['1', '0'],
    });

    const failedBatch = await client.queryAllowingFailure(database.uuid, {
      batch: [
        { sql: 'UPDATE contract_state SET value = 1 WHERE id = ?', params: ['1'] },
        {
          sql: 'INSERT INTO contract_guard(value) SELECT value FROM contract_state WHERE id = ?',
          params: ['1'],
        },
      ],
    });
    if (!isExpectedConstraintFailure(failedBatch)) {
      throw new Error('D1 REST failure batch가 예상한 constraint 오류를 반환하지 않았습니다.');
    }

    const verification = await client.query(database.uuid, {
      sql: 'SELECT value FROM contract_state WHERE id = ?',
      params: ['1'],
    });
    const verificationResult = Array.isArray(verification) && verification.length === 1
      ? verification[0]
      : undefined;
    const verificationRows = Array.isArray(verificationResult?.results)
      ? verificationResult.results
      : [];
    const rollbackValue = verificationRows.length === 1
      ? verificationRows[0]?.value
      : undefined;
    if (typeof rollbackValue !== 'number' || rollbackValue !== 0) {
      throw new Error('D1 REST batch의 선행 update가 rollback되지 않았습니다.');
    }
    log(`D1 REST batch rollback verified: ${database.name}/${database.uuid}`);
  } finally {
    if (database?.uuid) await client.deleteDatabase(database.uuid);
  }
}

async function main() {
  const {
    CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID,
    CONTRACT_RUN_ID,
    CONTRACT_RUN_ATTEMPT,
  } = process.env;
  if (!CLOUDFLARE_API_TOKEN
    || !CLOUDFLARE_ACCOUNT_ID
    || !CONTRACT_RUN_ID
    || !CONTRACT_RUN_ATTEMPT) {
    throw new Error('D1 REST batch contract 환경변수가 필요합니다.');
  }
  const client = createCloudflareD1RestClient({
    accountId: CLOUDFLARE_ACCOUNT_ID,
    apiToken: CLOUDFLARE_API_TOKEN,
  });
  await runD1RestBatchContract({
    client,
    runId: CONTRACT_RUN_ID,
    runAttempt: CONTRACT_RUN_ATTEMPT,
  });
}

const isContractMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isContractMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'D1 REST batch contract failed.');
    process.exitCode = 1;
  });
}
