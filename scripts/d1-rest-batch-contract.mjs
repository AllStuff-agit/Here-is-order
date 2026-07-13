import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCloudflareD1RestClient } from './cloudflare-d1-rest.mjs';

const ROLLBACK_GUARD_MARKER = 'hio_rollback_guard';
const D1_QUERY_ERROR_CODE = 7500;
const DATABASE_UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const INVOCATION_SUFFIX_PATTERN = /^[0-9a-f]{12}$/;
const RUN_IDENTITY_PATTERN = /^[0-9]+$/;
const MAX_DATABASE_NAME_LENGTH = 32;
const MAX_RUN_IDENTITY_LENGTH = 12;

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

function isUsableDatabaseUuid(value) {
  return typeof value === 'string'
    && DATABASE_UUID_PATTERN.test(value);
}

function cleanupUuidFrom(value) {
  try {
    return isUsableDatabaseUuid(value?.cleanupUuid)
      ? value.cleanupUuid
      : undefined;
  } catch {
    return undefined;
  }
}

function mayHaveCreatedDatabase(value) {
  try {
    return value?.mayHaveCreatedDatabase === true;
  } catch {
    return false;
  }
}

function cleanupRequiredFrom(value) {
  try {
    return value?.cleanupRequired === true;
  } catch {
    return false;
  }
}

function retryableFrom(value) {
  try {
    return value?.retryable === true;
  } catch {
    return false;
  }
}

function httpStatusFrom(value) {
  try {
    return Number.isInteger(value?.httpStatus)
      ? value.httpStatus
      : undefined;
  } catch {
    return undefined;
  }
}

function invalidCreateResponse(cleanupUuid) {
  const error = new Error('Cloudflare D1 create response was invalid.');
  Object.defineProperty(error, 'mayHaveCreatedDatabase', { value: true });
  Object.defineProperty(error, 'cleanupRequired', { value: true });
  if (isUsableDatabaseUuid(cleanupUuid)) {
    Object.defineProperty(error, 'cleanupUuid', { value: cleanupUuid });
  }
  return error;
}

function validateCreatedDatabase(database, expectedName) {
  let cleanupUuid;
  try {
    cleanupUuid = isUsableDatabaseUuid(database?.uuid)
      ? database.uuid
      : undefined;
    if (!database
      || typeof database !== 'object'
      || Array.isArray(database)
      || database.name !== expectedName
      || !cleanupUuid) {
      throw invalidCreateResponse(cleanupUuid);
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    throw invalidCreateResponse(cleanupUuid);
  }
  return { name: expectedName, uuid: cleanupUuid };
}

function validateExactNameMatches(matches, databaseName) {
  if (!Array.isArray(matches)
    || matches.some((match) => !match
      || typeof match !== 'object'
      || Array.isArray(match)
      || match.name !== databaseName
      || !isUsableDatabaseUuid(match.uuid))) {
    throw new Error('invalid exact-name lookup');
  }
  return matches;
}

function defaultRandomSuffix() {
  return randomBytes(6).toString('hex');
}

function buildDisposableDatabaseName(runId, runAttempt, randomSuffix) {
  if (typeof runId !== 'string'
    || !RUN_IDENTITY_PATTERN.test(runId)
    || typeof runAttempt !== 'string'
    || !RUN_IDENTITY_PATTERN.test(runAttempt)) {
    throw new Error('Disposable D1 invocation identity was invalid.');
  }

  let suffix;
  try {
    suffix = randomSuffix();
  } catch {
    throw new Error('Disposable D1 invocation suffix generation failed.');
  }
  if (typeof suffix !== 'string' || !INVOCATION_SUFFIX_PATTERN.test(suffix)) {
    throw new Error('Disposable D1 invocation suffix generation failed.');
  }

  const attemptPart = runAttempt.slice(-4);
  const runIdPart = runId.slice(
    0,
    MAX_RUN_IDENTITY_LENGTH - attemptPart.length - 1,
  );
  const runIdentity = `${runIdPart}-${attemptPart}`;
  const databaseName = `hio-rb-${runIdentity}-${suffix}`;
  if (databaseName.length > MAX_DATABASE_NAME_LENGTH) {
    throw new Error('Disposable D1 database name generation failed.');
  }
  return databaseName;
}

async function listExactNameMatchesWithRetry({
  client,
  databaseName,
  retryEmpty,
  sleep,
}) {
  let lastRetryableError;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    let rawMatches;
    try {
      rawMatches = await client.listDatabasesByExactName(databaseName);
    } catch (error) {
      if (!retryableFrom(error)) throw error;
      lastRetryableError = error;
      if (attempt < 10) await sleep(500);
      continue;
    }

    lastRetryableError = undefined;
    const matches = validateExactNameMatches(rawMatches, databaseName);
    if (matches.length > 1) throw new Error('ambiguous exact-name lookup');
    if (matches.length === 1 || !retryEmpty) return matches;
    if (attempt < 10) await sleep(500);
  }

  if (lastRetryableError) throw lastRetryableError;
  return [];
}

async function deleteDisposableDatabaseWithRetry({
  client,
  databaseName,
  databaseUuid,
  sleep,
}) {
  let lastRetryableError;
  let sawRetryableFailure = false;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await client.deleteDatabase(databaseUuid);
      return;
    } catch (error) {
      if (!retryableFrom(error)) {
        if (sawRetryableFailure && httpStatusFrom(error) === 404) {
          const matches = await listExactNameMatchesWithRetry({
            client,
            databaseName,
            retryEmpty: false,
            sleep,
          });
          if (matches.length === 0) return;
          if (matches[0].uuid === databaseUuid && attempt < 10) {
            await sleep(500);
            continue;
          }
        }
        throw error;
      }
      sawRetryableFailure = true;
      lastRetryableError = error;
      if (attempt < 10) await sleep(500);
    }
  }
  throw lastRetryableError;
}

async function cleanupDisposableDatabase({
  client,
  databaseName,
  cleanupUuid,
  shouldLookupByName,
  cleanupRequired,
  sleep,
}) {
  if (isUsableDatabaseUuid(cleanupUuid)) {
    await deleteDisposableDatabaseWithRetry({
      client,
      databaseName,
      databaseUuid: cleanupUuid,
      sleep,
    });
    return;
  }
  if (!shouldLookupByName) return;

  const matches = await listExactNameMatchesWithRetry({
    client,
    databaseName,
    retryEmpty: true,
    sleep,
  });
  if (matches.length === 1) {
    await deleteDisposableDatabaseWithRetry({
      client,
      databaseName,
      databaseUuid: matches[0].uuid,
      sleep,
    });
    return;
  }

  if (cleanupRequired) throw new Error('required cleanup target was not found');
}

export async function runD1RestBatchContract({
  client,
  runId,
  runAttempt,
  randomSuffix = defaultRandomSuffix,
  sleep = delay,
  log = console.log,
}) {
  const databaseName = buildDisposableDatabaseName(
    runId,
    runAttempt,
    randomSuffix,
  );
  let baselineMatches;
  try {
    baselineMatches = validateExactNameMatches(
      await client.listDatabasesByExactName(databaseName),
      databaseName,
    );
  } catch {
    throw new Error('Disposable D1 ownership preflight failed.');
  }
  if (baselineMatches.length !== 0) {
    throw new Error('Disposable D1 name is already in use.');
  }

  let cleanupUuid;
  let operationError;
  let operationFailed = false;
  let shouldLookupByName = false;
  let cleanupRequired = false;
  try {
    let database;
    try {
      database = await client.createDatabase(databaseName);
      cleanupUuid = isUsableDatabaseUuid(database?.uuid)
        ? database.uuid
        : undefined;
      database = validateCreatedDatabase(database, databaseName);
    } catch (error) {
      cleanupUuid ??= cleanupUuidFrom(error);
      shouldLookupByName = mayHaveCreatedDatabase(error);
      cleanupRequired = cleanupRequiredFrom(error);
      throw error;
    }

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
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  try {
    await cleanupDisposableDatabase({
      client,
      databaseName,
      cleanupUuid,
      shouldLookupByName,
      cleanupRequired,
      sleep,
    });
  } catch {
    throw new Error('Disposable D1 cleanup failed.');
  }

  if (operationFailed) throw operationError;
  log(`D1 REST batch rollback verified: ${databaseName}/${cleanupUuid}`);
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
