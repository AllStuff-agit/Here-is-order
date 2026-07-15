import assert from 'node:assert/strict';
import test from 'node:test';

test('identity HTTP contract is directly Node-loadable through its package export', async () => {
  const identityContract = await import('@here-is-order/http-contract/identity');

  assert.equal(typeof identityContract.decodeIdentityHttpResponse, 'function');
});
