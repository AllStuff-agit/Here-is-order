import assert from 'node:assert/strict';
import test from 'node:test';

import { createCloudflareD1RestClient } from './cloudflare-d1-rest.mjs';

const ACCOUNT_ID = 'sensitive-account-id';
const API_TOKEN = 'sensitive-api-token';
const DATABASE_ID = 'ca1f6a9d-06f3-4b85-a4c7-fef570d9ca42';
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

test('createDatabase는 exact name과 usable UUID를 검증하고 cleanup UUID만 안전하게 보존한다', async (t) => {
  const requestedName = 'hio-rb-123-1';
  const sensitiveResponseName = 'unexpected-server-name';
  const cleanupUuid = 'ca1f6a9d-06f3-4b85-a4c7-fef570d9ca42';
  const cases = [
    { name: 'missing uuid', result: { name: requestedName } },
    { name: 'empty uuid', result: { name: requestedName, uuid: '' } },
    { name: 'whitespace uuid', result: { name: requestedName, uuid: '   ' } },
    { name: 'non-string uuid', result: { name: requestedName, uuid: 42 } },
    { name: 'non-canonical uuid', result: { name: requestedName, uuid: 'not-a-uuid' } },
    { name: 'path-separator uuid', result: { name: requestedName, uuid: '../other-endpoint' } },
    {
      name: 'mismatched name with usable uuid',
      result: { name: sensitiveResponseName, uuid: cleanupUuid },
      cleanupUuid,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const client = createCloudflareD1RestClient({
        accountId: ACCOUNT_ID,
        apiToken: API_TOKEN,
        baseUrl: BASE_URL,
        fetchImpl: async () => jsonResponse({
          success: true,
          result: scenario.result,
        }),
      });

      await assert.rejects(
        client.createDatabase(requestedName),
        (error) => {
          assert.equal(error.message, 'Cloudflare D1 create response was invalid.');
          assert.equal(error.cleanupUuid, scenario.cleanupUuid);
          assert.equal(error.mayHaveCreatedDatabase, true);
          assert.equal(error.cleanupRequired, true);
          assert.equal(Object.keys(error).includes('cleanupUuid'), false);
          assert.equal(Object.keys(error).includes('mayHaveCreatedDatabase'), false);
          assert.equal(Object.keys(error).includes('cleanupRequired'), false);
          assert.ok(!error.message.includes(sensitiveResponseName));
          assert.ok(!error.message.includes(cleanupUuid));
          assert.ok(!error.message.includes(API_TOKEN));
          assert.ok(!error.message.includes(ACCOUNT_ID));
          return true;
        },
      );
    });
  }
});

test('create의 ambiguous transport/non-JSON만 name fallback 가능성을 표시한다', async (t) => {
  const cases = [
    {
      name: 'transport',
      fetchImpl: async () => { throw new Error('sensitive transport detail'); },
      mayHaveCreatedDatabase: true,
      retryable: true,
      httpStatus: undefined,
    },
    {
      name: 'non-JSON response',
      fetchImpl: async () => new Response('sensitive server detail', { status: 200 }),
      mayHaveCreatedDatabase: true,
      retryable: undefined,
      httpStatus: 200,
    },
    {
      name: 'parsed rejection',
      fetchImpl: async () => jsonResponse({
        success: false,
        errors: [{ message: 'sensitive rejection detail' }],
      }, { status: 409 }),
      mayHaveCreatedDatabase: undefined,
      retryable: undefined,
      httpStatus: 409,
    },
    {
      name: 'parsed 429',
      fetchImpl: async () => jsonResponse({
        success: false,
        errors: [{ message: 'sensitive rate-limit detail' }],
      }, { status: 429 }),
      mayHaveCreatedDatabase: undefined,
      retryable: true,
      httpStatus: 429,
    },
    {
      name: 'parsed 5xx',
      fetchImpl: async () => jsonResponse({
        success: false,
        errors: [{ message: 'sensitive upstream detail' }],
      }, { status: 503 }),
      mayHaveCreatedDatabase: true,
      retryable: true,
      httpStatus: 503,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const client = createCloudflareD1RestClient({
        accountId: ACCOUNT_ID,
        apiToken: API_TOKEN,
        baseUrl: BASE_URL,
        fetchImpl: scenario.fetchImpl,
      });

      await assert.rejects(
        client.createDatabase('hio-rb-123-1'),
        (error) => {
          assert.equal(error.mayHaveCreatedDatabase, scenario.mayHaveCreatedDatabase);
          assert.equal(error.retryable, scenario.retryable);
          assert.equal(error.httpStatus, scenario.httpStatus);
          assert.equal(Object.keys(error).includes('mayHaveCreatedDatabase'), false);
          assert.equal(Object.keys(error).includes('retryable'), false);
          assert.equal(Object.keys(error).includes('httpStatus'), false);
          assert.doesNotMatch(error.message, /sensitive/);
          assert.ok(!error.message.includes(API_TOKEN));
          assert.ok(!error.message.includes(ACCOUNT_ID));
          return true;
        },
      );
    });
  }
});

test('listDatabasesByExactName은 encoded exact-name GET만 사용한다', async () => {
  const requestedName = 'hio rb/한글?';
  const uuid = 'ca1f6a9d-06f3-4b85-a4c7-fef570d9ca42';
  const requests = [];
  const client = createCloudflareD1RestClient({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    baseUrl: BASE_URL,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({
        success: true,
        result: [{ name: requestedName, uuid }],
      });
    },
  });

  assert.deepEqual(await client.listDatabasesByExactName(requestedName), [
    { name: requestedName, uuid },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    `${BASE_URL}/accounts/${ACCOUNT_ID}/d1/database?name=${encodeURIComponent(requestedName)}`,
  );
  assert.equal(requests[0].init.method, 'GET');
  assert.equal(requests[0].init.body, undefined);
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${API_TOKEN}`);
});

test('exact-name list는 malformed, non-exact, unusable UUID 결과를 fail closed 한다', async (t) => {
  const requestedName = 'hio-rb-123-1';
  const cases = [
    { name: 'non-array result', result: null },
    { name: 'malformed entry', result: [null] },
    {
      name: 'non-exact name',
      result: [{ name: 'other-database', uuid: 'ca1f6a9d-06f3-4b85-a4c7-fef570d9ca42' }],
    },
    { name: 'missing uuid', result: [{ name: requestedName }] },
    { name: 'empty uuid', result: [{ name: requestedName, uuid: '' }] },
    { name: 'malformed uuid', result: [{ name: requestedName, uuid: false }] },
    { name: 'non-canonical uuid', result: [{ name: requestedName, uuid: 'not-a-uuid' }] },
    { name: 'path-separator uuid', result: [{ name: requestedName, uuid: '../other-endpoint' }] },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const client = createCloudflareD1RestClient({
        accountId: ACCOUNT_ID,
        apiToken: API_TOKEN,
        baseUrl: BASE_URL,
        fetchImpl: async () => jsonResponse({
          success: true,
          result: scenario.result,
        }),
      });

      await assert.rejects(
        client.listDatabasesByExactName(requestedName),
        (error) => {
          assert.equal(error.message, 'Cloudflare D1 list response was invalid.');
          assert.ok(!error.message.includes(API_TOKEN));
          assert.ok(!error.message.includes(ACCOUNT_ID));
          assert.ok(!error.message.includes('other-database'));
          return true;
        },
      );
    });
  }
});

test('getTimeTravelBookmark는 fixed bookmark GET과 strict opaque 결과만 허용한다', async () => {
  const requests = [];
  const bookmark = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
  const client = createCloudflareD1RestClient({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    baseUrl: BASE_URL,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({ success: true, result: { bookmark } });
    },
  });

  assert.equal(await client.getTimeTravelBookmark(DATABASE_ID), bookmark);
  assert.deepEqual(requests, [{
    url: `${BASE_URL}/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/time_travel/bookmark`,
    init: {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    },
  }]);
});

test('getTimeTravelBookmark는 malformed bookmark response를 fail closed 한다', async (t) => {
  const cases = [
    { name: 'missing result', result: undefined },
    { name: 'null result', result: null },
    { name: 'array result', result: [] },
    { name: 'missing bookmark', result: {} },
    { name: 'empty bookmark', result: { bookmark: '' } },
    { name: 'whitespace bookmark', result: { bookmark: 'bookmark value' } },
    { name: 'control bookmark', result: { bookmark: 'bookmark\nvalue' } },
    { name: 'path bookmark', result: { bookmark: '../restore' } },
    { name: 'non-string bookmark', result: { bookmark: 42 } },
    { name: 'oversized bookmark', result: { bookmark: 'a'.repeat(513) } },
    { name: 'extra result field', result: { bookmark: 'abc-123', database: 'sensitive' } },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const client = createCloudflareD1RestClient({
        accountId: ACCOUNT_ID,
        apiToken: API_TOKEN,
        baseUrl: BASE_URL,
        fetchImpl: async () => jsonResponse({
          success: true,
          ...(scenario.result === undefined ? {} : { result: scenario.result }),
        }),
      });

      await assert.rejects(
        client.getTimeTravelBookmark(DATABASE_ID),
        (error) => {
          assert.equal(error.message, 'Cloudflare D1 bookmark response was invalid.');
          assert.doesNotMatch(error.message, /sensitive/);
          assert.doesNotMatch(error.message, new RegExp(API_TOKEN));
          assert.doesNotMatch(error.message, new RegExp(ACCOUNT_ID));
          return true;
        },
      );
    });
  }
});

test('database operation은 canonical UUID가 아니면 fetch 전에 거부한다', async () => {
  let fetchCalls = 0;
  const client = createCloudflareD1RestClient({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    baseUrl: BASE_URL,
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({ success: true, result: [] });
    },
  });

  for (const databaseId of ['', 'not-a-uuid', '../other-endpoint']) {
    await assert.rejects(
      client.deleteDatabase(databaseId),
      /database identifier was invalid/,
    );
    await assert.rejects(
      client.query(databaseId, { sql: 'SELECT 1', params: [] }),
      /database identifier was invalid/,
    );
    await assert.rejects(
      client.queryAllowingFailure(databaseId, { sql: 'SELECT 1', params: [] }),
      /database identifier was invalid/,
    );
    await assert.rejects(
      client.getTimeTravelBookmark(databaseId),
      /database identifier was invalid/,
    );
  }
  assert.equal(fetchCalls, 0);
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

test('queryAllowingFailure는 sanitized numeric HTTP status와 failure envelope를 반환한다', async () => {
  const failureEnvelope = {
    success: false,
    errors: [{ code: 7500, message: 'constraint failed: hio_rollback_guard' }],
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
    { httpOk: false, httpStatus: 400, envelope: failureEnvelope },
  );
});

test('queryAllowingFailure는 transport와 non-JSON 응답 detail을 노출하지 않고 거부한다', async (t) => {
  await t.test('transport failure', async () => {
    const client = createCloudflareD1RestClient({
      accountId: ACCOUNT_ID,
      apiToken: API_TOKEN,
      fetchImpl: async () => {
        throw new Error(`${ACCOUNT_ID}/${API_TOKEN}/transport-detail`);
      },
      baseUrl: BASE_URL,
    });

    await assert.rejects(
      client.queryAllowingFailure(DATABASE_ID, { batch: [] }),
      (error) => {
        assert.equal(error.message, 'Cloudflare D1 request failed.');
        assert.doesNotMatch(error.message, /transport-detail/);
        assert.doesNotMatch(error.message, new RegExp(ACCOUNT_ID));
        assert.doesNotMatch(error.message, new RegExp(API_TOKEN));
        return true;
      },
    );
  });

  await t.test('non-JSON failure', async () => {
    const client = createCloudflareD1RestClient({
      accountId: ACCOUNT_ID,
      apiToken: API_TOKEN,
      fetchImpl: async () => new Response(
        `${ACCOUNT_ID}/${API_TOKEN}/server-detail`,
        { status: 400 },
      ),
      baseUrl: BASE_URL,
    });

    await assert.rejects(
      client.queryAllowingFailure(DATABASE_ID, { batch: [] }),
      (error) => {
        assert.equal(error.message, 'Cloudflare D1 request failed with HTTP 400.');
        assert.doesNotMatch(error.message, /server-detail/);
        assert.doesNotMatch(error.message, new RegExp(ACCOUNT_ID));
        assert.doesNotMatch(error.message, new RegExp(API_TOKEN));
        return true;
      },
    );
  });
});
