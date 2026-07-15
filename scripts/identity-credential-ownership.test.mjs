import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function readScript(fileName) {
  return readFileSync(new URL(fileName, import.meta.url), 'utf8');
}
function parseSource(source) {
  return ts.createSourceFile('ownership-check.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}
function visit(node, callback) {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}
function staticString(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isParenthesizedExpression(node)) return staticString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}
function namedImport(sourceFile, moduleName, exportName) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)
      || staticString(statement.moduleSpecifier) !== moduleName
      || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      if ((element.propertyName ?? element.name).text === exportName) {
        return element.name.text;
      }
    }
  }
  return null;
}

function loadedModules(sourceFile) {
  const modules = [];
  visit(sourceFile, (node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = staticString(node.moduleSpecifier);
      if (specifier !== null) modules.push(specifier);
      return;
    }
    if (!ts.isCallExpression(node)) return;
    const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      || (ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'require');
    if (!isDynamicImport && !isRequire) return;
    const specifier = staticString(node.arguments[0]);
    if (specifier !== null) modules.push(specifier);
  });
  return modules;
}
function findFunction(sourceFile, functionName) {
  return sourceFile.statements.find((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === functionName) ?? null;
}
function hasAwaitedCall(functionNode, identifier) {
  let found = false;
  visit(functionNode.body, (node) => {
    if (ts.isAwaitExpression(node)
      && ts.isCallExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === identifier) {
      found = true;
    }
  });
  return found;
}
function hasDefaultBinding(functionNode, localName, initializerName) {
  return functionNode.parameters.some((parameter) =>
    ts.isObjectBindingPattern(parameter.name)
    && parameter.name.elements.some((element) =>
      ts.isIdentifier(element.name)
      && element.name.text === localName
      && element.initializer
      && ts.isIdentifier(element.initializer)
      && element.initializer.text === initializerName));
}
function hasSharedCredentialFlow(source, { functionName, mode }) {
  const sourceFile = parseSource(source);
  const binding = namedImport(sourceFile, './node-credential-crypto.mjs', 'createPasswordHash');
  const target = findFunction(sourceFile, functionName);
  if (!binding || !target || loadedModules(sourceFile).includes('./generate-admin-seed.mjs')) {
    return false;
  }
  if (mode === 'direct') return hasAwaitedCall(target, binding);
  return mode === 'injected'
    && hasDefaultBinding(target, 'createHash', binding)
    && hasAwaitedCall(target, 'createHash');
}
function usesIdentifierOutsideImports(sourceFile, identifier) {
  let used = false;
  visit(sourceFile, (node) => {
    if (!ts.isIdentifier(node) || node.text !== identifier) return;
    let parent = node.parent;
    while (parent && !ts.isSourceFile(parent)) {
      if (ts.isImportDeclaration(parent)) return;
      parent = parent.parent;
    }
    used = true;
  });
  return used;
}
function ownsCredentialName(name) {
  const normalized = name.replaceAll('_', '').toLowerCase();
  if (['scheme', 'iteration', 'iterations', 'hashpattern', 'hashprefix'].includes(normalized)) {
    return true;
  }
  return ['scheme', 'iteration', 'pattern', 'prefix'].some((term) =>
    normalized.includes(term))
    && ['hash', 'password', 'pbkdf2'].some((term) => normalized.includes(term));
}
function hasLocalCredentialOwnership(sourceFile) {
  let owns = false;
  visit(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && ownsCredentialName(node.name.text)) owns = true;
      const value = staticString(node.initializer)?.replaceAll('_', '');
      if (value?.includes('pbkdf2sha256') || value?.includes('100000')) owns = true;
    }
    if (ts.isNumericLiteral(node)
      && node.getText(sourceFile).replaceAll('_', '') === '100000') {
      owns = true;
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      && /pbkdf2sha256|100000/.test(node.text.replaceAll('_', ''))) owns = true;
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const value = node.getText(sourceFile).replaceAll('\\', '').replaceAll('_', '');
      if (value.includes('pbkdf2sha256') || value.includes('100000')) owns = true;
    }
  });
  return owns;
}
function hasPortableCoreOwnership(source, requiredExports) {
  const sourceFile = parseSource(source);
  for (const exportName of requiredExports) {
    const binding = namedImport(sourceFile, '@here-is-order/identity-credential', exportName);
    if (!binding || !usesIdentifierOutsideImports(sourceFile, binding)) return false;
  }
  return !hasLocalCredentialOwnership(sourceFile);
}
test('production files keep credential ownership at the shared modules', () => {
  const seed = readScript('generate-admin-seed.mjs');
  assert.equal(loadedModules(parseSource(seed)).includes('node:crypto'), false);
  assert.equal(hasSharedCredentialFlow(seed, {
    functionName: 'generateAdminSeed', mode: 'direct',
  }), true);

  for (const [fileName, functionName] of [
    ['recover-password.mjs', 'runPasswordRecovery'],
    ['manage-smoke-identity.mjs', 'runManageSmokeIdentity'],
  ]) {
    assert.equal(hasSharedCredentialFlow(readScript(fileName), {
      functionName, mode: 'injected',
    }), true, fileName);
  }

  assert.equal(hasPortableCoreOwnership(readScript('recover-password-core.mjs'), [
    'CURRENT_PASSWORD_HASH_PREFIX',
  ]), true);
  assert.equal(hasPortableCoreOwnership(readScript('smoke-identity-lifecycle.mjs'), [
    'CURRENT_PASSWORD_HASH_PREFIX', 'isCurrentPasswordHash',
  ]), true);
});
test('Node crypto validator catches static, dynamic, require, and joined specifiers', () => {
  for (const source of [
    "import { pbkdf2 } from 'node:crypto';",
    "await import('node:' + 'crypto');",
    "require('node:crypto');",
  ]) {
    assert.equal(loadedModules(parseSource(source)).includes('node:crypto'), true, source);
  }
  assert.equal(loadedModules(parseSource("const note = \"import('node:crypto')\";"))
    .includes('node:crypto'), false);
  assert.equal(loadedModules(parseSource("// require('node:crypto')\nconst safe = true;"))
    .includes('node:crypto'), false);
});
test('shared adapter validator requires a named import used in the target flow', () => {
  const valid = `import { createPasswordHash } from './node-credential-crypto.mjs';
    export async function generateAdminSeed() { return await createPasswordHash('pw'); }`;
  assert.equal(hasSharedCredentialFlow(valid, {
    functionName: 'generateAdminSeed', mode: 'direct',
  }), true);
  for (const source of [
    `import { createPasswordHash } from './node-credential-crypto.mjs';
     export async function generateAdminSeed() { /* await createPasswordHash('pw') */ }`,
    `import createPasswordHash from './node-credential-crypto.mjs';
     export async function generateAdminSeed() { return await createPasswordHash('pw'); }`,
    `import { createPasswordHash } from './node-credential-crypto.mjs';
     export async function generateAdminSeed() { return "await createPasswordHash('pw')"; }`,
  ]) {
    assert.equal(hasSharedCredentialFlow(source, {
      functionName: 'generateAdminSeed', mode: 'direct',
    }), false, source);
  }
});
test('injected flow rejects legacy seed ownership and missing adapter default', () => {
  for (const source of [
    `import { createPasswordHash } from './node-credential-crypto.mjs';
     import { createPasswordHash as legacyHash } from './generate-admin-seed.mjs';
     export async function runPasswordRecovery({ createHash = legacyHash } = {}) {
       return await createHash('pw');
     }`,
    `import { createPasswordHash } from './node-credential-crypto.mjs';
     export async function runPasswordRecovery({ createHash } = {}) {
       return await createHash('pw');
     }`,
  ]) {
    assert.equal(hasSharedCredentialFlow(source, {
      functionName: 'runPasswordRecovery', mode: 'injected',
    }), false, source);
  }
});
test('portable core validator rejects unused, wrong-source, and split local ownership', () => {
  for (const source of [
    `import { CURRENT_PASSWORD_HASH_PREFIX } from '@here-is-order/identity-credential';
     const note = 'CURRENT_PASSWORD_HASH_PREFIX'; // import remains unused
    `,
    `import { CURRENT_PASSWORD_HASH_PREFIX } from './local-credential.mjs';
     export const prefix = () => CURRENT_PASSWORD_HASH_PREFIX;`,
    `import { CURRENT_PASSWORD_HASH_PREFIX } from '@here-is-order/identity-credential';
     export const prefix = () => CURRENT_PASSWORD_HASH_PREFIX + 'pbkdf2_sha256$100000$';`,
    `import { CURRENT_PASSWORD_HASH_PREFIX } from '@here-is-order/identity-credential';
     const workFactor = 100000; export const prefix = () => CURRENT_PASSWORD_HASH_PREFIX;`,
    `import { CURRENT_PASSWORD_HASH_PREFIX } from '@here-is-order/identity-credential';
     const PASSWORD_HASH_SCHEME = 'pbkdf2_' + 'sha256';
     const PASSWORD_HASH_ITERATIONS = 100_000;
     const HASH_PATTERN = new RegExp(PASSWORD_HASH_SCHEME + PASSWORD_HASH_ITERATIONS);
     export const prefix = () => CURRENT_PASSWORD_HASH_PREFIX;`,
  ]) {
    assert.equal(hasPortableCoreOwnership(source, ['CURRENT_PASSWORD_HASH_PREFIX']), false, source);
  }
});
test('the versioned compatibility audit keeps its independent fixed-format literal', () => {
  const source = readFileSync(new URL('sql/identity-compatibility-v1.sql', import.meta.url), 'utf8');
  assert.match(source, /pbkdf2_sha256\$100000\$/);
});
