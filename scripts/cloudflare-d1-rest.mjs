function requestFailure(status) {
  return status === undefined
    ? new Error('Cloudflare D1 request failed.')
    : new Error(`Cloudflare D1 request failed with HTTP ${status}.`);
}

function sanitizeHttpStatus(status) {
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
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
      throw requestFailure();
    }

    try {
      return { response, envelope: await response.json() };
    } catch {
      throw requestFailure(response.status);
    }
  }

  async function request(pathname, init) {
    const { response, envelope } = await fetchEnvelope(pathname, init);
    if (!response.ok || envelope?.success !== true) {
      throw requestFailure(response.status);
    }
    return envelope;
  }

  const databasePath = `/accounts/${accountId}/d1/database`;

  return {
    async createDatabase(name) {
      const envelope = await request(databasePath, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      return envelope.result;
    },

    async deleteDatabase(databaseId) {
      await request(`${databasePath}/${databaseId}`, { method: 'DELETE' });
    },

    async query(databaseId, body) {
      const envelope = await request(`${databasePath}/${databaseId}/query`, {
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
        `${databasePath}/${databaseId}/query`,
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
