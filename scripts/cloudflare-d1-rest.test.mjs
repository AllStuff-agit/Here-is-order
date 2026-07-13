import assert from 'node:assert/strict';
import test from 'node:test';

import { createCloudflareD1RestClient } from './cloudflare-d1-rest.mjs';

const ACCOUNT_ID = 'sensitive-account-id';
const API_TOKEN = 'sensitive-api-token';
const DATABASE_ID = 'database-id';
const BASE_URL = 'https://cloudflare.invalid/client/v4';

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('모든 REST 요청은 Bearer 인증과 JSON content type을 사용한다', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (init.method === 'POST' && url.endsWith('/d1/database')) {
      return jsonResponse({
        success: true,
        result: { name: 'temporary', uuid: DATABASE_ID },
      });
    }
    if (init.method === 'DELETE') {
      return jsonResponse({ success: true, result: null });
    }
    return jsonResponse({
      success: true,
      result: [{ success: true, results: [], meta: {} }],
    });
  };
  const client = createCloudflareD1RestClient({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    fetchImpl,
    baseUrl: BASE_URL,
  });

  assert.deepEqual(await client.createDatabase('temporary'), {
    name: 'temporary',
    uuid: DATABASE_ID,
  });
  await client.deleteDatabase(DATABASE_ID);
  await client.query(DATABASE_ID, { sql: 'SELECT ?', params: ['1'] });
  await client.queryAllowingFailure(DATABASE_ID, {
    batch: [{ sql: 'SELECT ?', params: ['1'] }],
  });

  assert.equal(requests.length, 4);
  for (const { init } of requests) {
    assert.equal(init.headers.Authorization, `Bearer ${API_TOKEN}`);
    assert.equal(init.headers['Content-Type'], 'application/json');
  }
  assert.deepEqual(JSON.parse(requests[0].init.body), { name: 'temporary' });
  assert.equal(requests[1].init.body, undefined);
  assert.deepEqual(JSON.parse(requests[2].init.body), {
    sql: 'SELECT ?',
    params: ['1'],
  });
  assert.deepEqual(JSON.parse(requests[3].init.body), {
    batch: [{ sql: 'SELECT ?', params: ['1'] }],
  });
});

test('HTTP/envelope/transport 실패 오류에는 token, account, 응답 detail을 노출하지 않는다', async (t) => {
  await t.test('HTTP 또는 envelope 실패', async () => {
    const client = createCloudflareD1RestClient({
      accountId: ACCOUNT_ID,
      apiToken: API_TOKEN,
      baseUrl: BASE_URL,
      fetchImpl: async () => jsonResponse({
        success: false,
        errors: [{ message: `${ACCOUNT_ID}/${API_TOKEN}/server-detail` }],
      }, { status: 403 }),
    });

    await assert.rejects(
      client.query(DATABASE_ID, { sql: 'SELECT 1', params: [] }),
      (error) => {
        assert.equal(error.message, 'Cloudflare D1 request failed with HTTP 403.');
        assert.doesNotMatch(error.message, new RegExp(ACCOUNT_ID));
        assert.doesNotMatch(error.message, new RegExp(API_TOKEN));
        assert.doesNotMatch(error.message, /server-detail/);
        return true;
      },
    );
  });

  await t.test('transport 실패', async () => {
    const client = createCloudflareD1RestClient({
      accountId: ACCOUNT_ID,
      apiToken: API_TOKEN,
      baseUrl: BASE_URL,
      fetchImpl: async () => {
        throw new Error(`transport ${ACCOUNT_ID}/${API_TOKEN}`);
      },
    });

    await assert.rejects(
      client.createDatabase('temporary'),
      (error) => {
        assert.match(error.message, /Cloudflare D1 request failed/);
        assert.doesNotMatch(error.message, new RegExp(ACCOUNT_ID));
        assert.doesNotMatch(error.message, new RegExp(API_TOKEN));
        return true;
      },
    );
  });
});

test('query는 top-level과 모든 statement success가 true여야 한다', async () => {
  const envelopes = [
    { success: true, result: undefined },
    { success: true, result: [{ success: true }, { success: false }] },
    { success: true, result: [{ success: true }, {}] },
    { success: true, result: [null] },
  ];
  const client = createCloudflareD1RestClient({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    fetchImpl: async () => jsonResponse(envelopes.shift()),
    baseUrl: BASE_URL,
  });

  for (let index = 0; index < 4; index += 1) {
    await assert.rejects(
      client.query(DATABASE_ID, { sql: 'SELECT 1', params: [] }),
      /did not fully succeed/,
    );
  }
});

test('queryAllowingFailure는 HTTP와 Cloudflare failure envelope를 그대로 반환한다', async () => {
  const failureEnvelope = {
    success: false,
    errors: [{ code: 7500, message: 'constraint failed' }],
    result: [{ success: false, results: [], meta: {} }],
  };
  const client = createCloudflareD1RestClient({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    fetchImpl: async () => jsonResponse(failureEnvelope, { status: 400 }),
    baseUrl: BASE_URL,
  });

  assert.deepEqual(
    await client.queryAllowingFailure(DATABASE_ID, {
      batch: [{ sql: 'INSERT INTO guard VALUES (?)', params: ['0'] }],
    }),
    { httpOk: false, envelope: failureEnvelope },
  );
});
