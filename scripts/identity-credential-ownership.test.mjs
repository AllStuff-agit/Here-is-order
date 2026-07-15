import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readScript(fileName) {
  return readFileSync(new URL(fileName, import.meta.url), 'utf8');
}

test('admin seed generation does not own Node credential primitives', () => {
  const source = readScript('generate-admin-seed.mjs');

  assert.doesNotMatch(source, /from ['"]node:crypto['"]/);
});

test('operator credential entrypoints consume the shared Node adapter', () => {
  for (const fileName of ['recover-password.mjs', 'manage-smoke-identity.mjs']) {
    const source = readScript(fileName);

    assert.match(
      source,
      /from ['"]\.\/node-credential-crypto\.mjs['"]/,
      `${fileName} must import the shared Node credential adapter`,
    );
  }
});

test('recovery and smoke lifecycle cores do not own the current PBKDF2 format', () => {
  for (const fileName of ['recover-password-core.mjs', 'smoke-identity-lifecycle.mjs']) {
    const source = readScript(fileName);

    assert.doesNotMatch(
      source,
      /pbkdf2_sha256(?:\\\$|\$)100000(?:\\\$|\$)/,
      `${fileName} must consume the package-owned current hash format`,
    );
  }
});

test('the versioned compatibility audit keeps its independent fixed-format literal', () => {
  const source = readFileSync(
    new URL('sql/identity-compatibility-v1.sql', import.meta.url),
    'utf8',
  );

  assert.match(source, /pbkdf2_sha256\$100000\$/);
});
