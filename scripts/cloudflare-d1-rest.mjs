function requestFailure(status, {
  mayHaveSucceeded = false,
  retryable = false,
} = {}) {
  const safeStatus = sanitizeHttpStatus(status);
  const error = safeStatus === undefined
    ? new Error('Cloudflare D1 request failed.')
    : new Error(`Cloudflare D1 request failed with HTTP ${safeStatus}.`);
  if (safeStatus !== undefined) {
    Object.defineProperty(error, 'httpStatus', { value: safeStatus });
  }
  if (mayHaveSucceeded) {
    Object.defineProperty(error, 'requestMayHaveSucceeded', { value: true });
  }
  if (retryable) {
    Object.defineProperty(error, 'retryable', { value: true });
  }
  return error;
}

function sanitizeHttpStatus(status) {
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

const DATABASE_UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function isUsableDatabaseUuid(value) {
  return typeof value === 'string'
    && DATABASE_UUID_PATTERN.test(value);
}

function invalidCreateResponse(result) {
  const error = new Error('Cloudflare D1 create response was invalid.');
  Object.defineProperty(error, 'mayHaveCreatedDatabase', { value: true });
  Object.defineProperty(error, 'cleanupRequired', { value: true });
  if (isUsableDatabaseUuid(result?.uuid)) {
    Object.defineProperty(error, 'cleanupUuid', { value: result.uuid });
  }
  return error;
}

export function createCloudflareD1RestClient({
  accountId,
  apiToken,
  fetchImpl = fetch,
  baseUrl = 'https://api.cloudflare.com/client/v4',
}) {
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  async function fetchEnvelope(pathname, init) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${pathname}`, {
        ...init,
        headers,
      });
    } catch {
      throw requestFailure(undefined, {
        mayHaveSucceeded: true,
        retryable: true,
      });
    }

    try {
      return { response, envelope: await response.json() };
    } catch {
      throw requestFailure(response.status, {
        mayHaveSucceeded: response.ok || response.status >= 500,
        retryable: isRetryableStatus(response.status),
      });
    }
  }

  async function request(pathname, init) {
    const { response, envelope } = await fetchEnvelope(pathname, init);
    if (!response.ok || envelope?.success !== true) {
      throw requestFailure(response.status, {
        mayHaveSucceeded: response.status >= 500,
        retryable: isRetryableStatus(response.status),
      });
    }
    return envelope;
  }

  const databasePath = `/accounts/${encodeURIComponent(accountId)}/d1/database`;

  function databaseResourcePath(databaseId) {
    if (!isUsableDatabaseUuid(databaseId)) {
      throw new Error('Cloudflare D1 database identifier was invalid.');
    }
    return `${databasePath}/${encodeURIComponent(databaseId)}`;
  }

  return {
    async createDatabase(name) {
      let envelope;
      try {
        envelope = await request(databasePath, {
          method: 'POST',
          body: JSON.stringify({ name }),
        });
      } catch (error) {
        if (error?.requestMayHaveSucceeded === true) {
          Object.defineProperty(error, 'mayHaveCreatedDatabase', { value: true });
        }
        throw error;
      }
      if (!envelope.result
        || typeof envelope.result !== 'object'
        || Array.isArray(envelope.result)
        || envelope.result.name !== name
        || !isUsableDatabaseUuid(envelope.result.uuid)) {
        throw invalidCreateResponse(envelope.result);
      }
      return { name: envelope.result.name, uuid: envelope.result.uuid };
    },

    async listDatabasesByExactName(name) {
      const envelope = await request(
        `${databasePath}?name=${encodeURIComponent(name)}`,
        { method: 'GET' },
      );
      if (!Array.isArray(envelope.result)
        || envelope.result.some((database) => !database
          || typeof database !== 'object'
          || Array.isArray(database)
          || database.name !== name
          || !isUsableDatabaseUuid(database.uuid))) {
        throw new Error('Cloudflare D1 list response was invalid.');
      }
      return envelope.result.map((database) => ({
        name: database.name,
        uuid: database.uuid,
      }));
    },

    async deleteDatabase(databaseId) {
      await request(databaseResourcePath(databaseId), { method: 'DELETE' });
    },

    async query(databaseId, body) {
      const envelope = await request(`${databaseResourcePath(databaseId)}/query`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!Array.isArray(envelope.result)
        || envelope.result.some((result) => result?.success !== true)) {
        throw new Error('Cloudflare D1 query did not fully succeed.');
      }
      return envelope.result;
    },

    async queryAllowingFailure(databaseId, body) {
      const { response, envelope } = await fetchEnvelope(
        `${databaseResourcePath(databaseId)}/query`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      return {
        httpOk: response.ok,
        httpStatus: sanitizeHttpStatus(response.status),
        envelope,
      };
    },
  };
}
