import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { experimental_readRawConfig } from 'wrangler';

const repositoryRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

test('API Wrangler config enables only persisted invocation logs at full sampling', () => {
  const { rawConfig } = experimental_readRawConfig({
    config: path.join(repositoryRoot, 'wrangler.toml'),
  });

  assert.deepEqual(rawConfig.observability, {
    enabled: true,
    logs: {
      enabled: true,
      persist: true,
      invocation_logs: true,
      head_sampling_rate: 1,
    },
  });
});
