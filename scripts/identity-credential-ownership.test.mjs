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
  if (callback(node) === false) return;
  node.forEachChild((child) => visit(child, callback));
}
function staticValue(node, sourceFile, seen = new Set()) {
  if (!node) return null;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll('_', ''));
  if (ts.isParenthesizedExpression(node)) return staticValue(node.expression, sourceFile, seen);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticValue(node.left, sourceFile, seen);
    const right = staticValue(node.right, sourceFile, seen);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'join' && ts.isArrayLiteralExpression(node.expression.expression)
    && node.arguments.length === 1
    && staticValue(node.arguments[0], sourceFile, seen) === '') {
    const values = node.expression.expression.elements.map((element) => staticValue(element, sourceFile, seen));
    return values.includes(null) ? null : values.join('');
  }
  if (sourceFile && ts.isIdentifier(node) && !seen.has(node.text)) {
    let initializer;
    visit(sourceFile, (candidate) => {
      if (!initializer && ts.isVariableDeclaration(candidate)
        && ts.isIdentifier(candidate.name) && candidate.name.text === node.text
        && candidate.initializer && (candidate.parent.flags & ts.NodeFlags.Const)) {
        initializer = candidate.initializer;
      }
    });
    if (initializer) return staticValue(initializer, sourceFile, new Set([...seen, node.text]));
  }
  return null;
}
function staticString(node) {
  return typeof staticValue(node) === 'string' ? staticValue(node) : null;
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
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
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
  return sourceFile.statements.find((statement) => ts.isFunctionDeclaration(statement)
    && statement.name?.text === functionName) ?? null;
}
function isNestedScope(node) { return ts.isFunctionLike(node) || ts.isClassLike(node); }
function bindsName(name, identifier) {
  if (ts.isIdentifier(name)) return name.text === identifier;
  return name.elements.some((element) => ts.isBindingElement(element)
    && bindsName(element.name, identifier));
}
function hasAwaitedCall(functionNode, identifier) {
  let found = false;
  visit(functionNode.body, (node) => {
    if (node !== functionNode.body && isNestedScope(node)) return false;
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === identifier) {
      found = true;
    }
  });
  return found;
}
function hasTargetBindingConflict(functionNode, identifier, includeParameters = true) {
  if (includeParameters && functionNode.parameters.some((parameter) =>
    bindsName(parameter.name, identifier))) return true;
  let conflict = false;
  visit(functionNode.body, (node) => {
    if (node !== functionNode.body && isNestedScope(node)) {
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
        && node.name?.text === identifier) conflict = true;
      return false;
    }
    if (ts.isVariableDeclaration(node) && bindsName(node.name, identifier)) conflict = true;
    if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.left.text === identifier
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      conflict = true;
    }
  });
  return conflict;
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
  if (hasTargetBindingConflict(target, binding)) return false;
  if (mode === 'direct') return hasAwaitedCall(target, binding);
  return mode === 'injected'
    && hasDefaultBinding(target, 'createHash', binding)
    && !hasTargetBindingConflict(target, 'createHash', false)
    && hasAwaitedCall(target, 'createHash');
}
function targetUses(sourceFile, functionName, identifier, predicate) {
  const target = findFunction(sourceFile, functionName);
  if (!target) return false;
  let used = false;
  visit(target.body, (node) => {
    if (node !== target.body && isNestedScope(node)) return false;
    if (ts.isIdentifier(node) && node.text === identifier && predicate(node)) used = true;
  });
  return used;
}
function usesSharedExport(sourceFile, exportName, binding) {
  if (exportName === 'CURRENT_PASSWORD_HASH_PREFIX') {
    return ['buildRecoveryPostflightQuery', 'buildSmokeIdentityPostflightQuery'].some((name) =>
      targetUses(sourceFile, name, binding, (node) => ts.isArrayLiteralExpression(node.parent)));
  }
  if (exportName === 'isCurrentPasswordHash') {
    return ['buildSmokeIdentityMutation', 'buildSmokeIdentityPostflightQuery'].every((name) =>
      targetUses(sourceFile, name, binding, (node) =>
        ts.isCallExpression(node.parent) && node.parent.expression === node));
  }
  return false;
}
function ownsCredentialName(name) {
  const normalized = name.replaceAll('_', '').toLowerCase();
  if (['scheme', 'iteration', 'iterations', 'hashpattern', 'hashprefix'].includes(normalized)) return true;
  return ['scheme', 'iteration', 'pattern', 'prefix'].some((term) =>
    normalized.includes(term))
    && ['hash', 'password', 'pbkdf2'].some((term) => normalized.includes(term));
}
function ownsCredentialValue(value) {
  const normalized = String(value ?? '').replaceAll('\\', '').replaceAll('_', '');
  return normalized.includes('pbkdf2sha256') || normalized.includes('100000');
}
function hasLocalCredentialOwnership(sourceFile) {
  let owns = false;
  visit(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && ownsCredentialName(node.name.text)) owns = true;
      if (ownsCredentialValue(staticValue(node.initializer, sourceFile))) owns = true;
    }
    if ((ts.isNumericLiteral(node) || ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node))
      && ownsCredentialValue(node.getText(sourceFile))) owns = true;
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral
      && ownsCredentialValue(node.getText(sourceFile))) owns = true;
    if (ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'RegExp'
      && ownsCredentialValue(staticValue(node.arguments?.[0], sourceFile))) {
      owns = true;
    }
  });
  return owns;
}
function hasPortableCoreOwnership(source, requiredExports) {
  const sourceFile = parseSource(source);
  for (const exportName of requiredExports) {
    const binding = namedImport(sourceFile, '@here-is-order/identity-credential', exportName);
    if (!binding || !usesSharedExport(sourceFile, exportName, binding)) return false;
  }
  return !hasLocalCredentialOwnership(sourceFile);
}

function parseTypeScriptSource(source, fileName = 'src/index.ts') {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
const WORKER_IDENTITY_ROUTES = [
  ['post', '/api/auth/login', 'authenticate', true],
  ['post', '/api/auth/logout', 'logout', true],
  ['get', '/api/users', 'listUsers', true],
  ['post', '/api/users', 'createUser', true],
  ['get', '/api/users/me', 'currentUser', false],
  ['patch', '/api/users/me/password', 'changeOwnPassword', true],
  ['patch', '/api/users/:id/password', 'resetPassword', true],
];
function topLevelRoutes(sourceFile) {
  const routes = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement)
      || !ts.isCallExpression(statement.expression)
      || !ts.isPropertyAccessExpression(statement.expression.expression)
      || !ts.isIdentifier(statement.expression.expression.expression)
      || statement.expression.expression.expression.text !== 'app') {
      continue;
    }
    const [pathNode, callback] = statement.expression.arguments;
    if (!ts.isStringLiteral(pathNode)
      || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
      continue;
    }
    routes.push({
      callback,
      method: statement.expression.expression.name.text,
      path: pathNode.text,
      statement,
    });
  }
  return routes;
}
function uniqueWorkerRoute(sourceFile, method, path) {
  const matches = topLevelRoutes(sourceFile).filter((route) =>
    route.method === method && route.path === path);
  assert.equal(matches.length, 1, `${method.toUpperCase()} ${path} must be one unique top-level route`);
  return matches[0];
}
function workerIdentitySlice(sourceFile) {
  const routes = topLevelRoutes(sourceFile);
  const login = uniqueWorkerRoute(sourceFile, 'post', '/api/auth/login');
  const firstCategory = routes.find((route) => route.path.startsWith('/api/categories'));
  assert.ok(firstCategory, 'the first categories route boundary must exist');
  assert.deepEqual(
    { method: firstCategory.method, path: firstCategory.path },
    { method: 'get', path: '/api/categories' },
    'the identity slice must end at the first GET /api/categories route',
  );
  assert.ok(login.statement.pos < firstCategory.statement.pos, 'login must precede categories');
  let previousPosition = -1;
  for (const [method, path] of WORKER_IDENTITY_ROUTES) {
    const route = uniqueWorkerRoute(sourceFile, method, path);
    assert.ok(
      route.statement.pos >= login.statement.pos
        && route.statement.pos < firstCategory.statement.pos,
      `${method.toUpperCase()} ${path} must remain inside the bounded Identity slice`,
    );
    assert.ok(
      route.statement.pos > previousPosition,
      'Identity routes must retain their established top-level order',
    );
    previousPosition = route.statement.pos;
  }
  return sourceFile.statements.filter((statement) =>
    statement.pos >= login.statement.pos && statement.pos < firstCategory.statement.pos);
}
function visitOwnScope(root, callback) {
  visit(root, (node) => {
    if (node !== root && (ts.isFunctionLike(node) || ts.isClassLike(node))) return false;
    return callback(node);
  });
}
function workerRuntimeBinding(sourceFile) {
  return namedImport(sourceFile, './identity', 'identity');
}
function runtimeLocalBindings(sourceFile, target) {
  const identityBinding = workerRuntimeBinding(sourceFile);
  if (!identityBinding || hasTargetBindingConflict(target, identityBinding)) return new Map();
  const candidates = new Map();
  visitOwnScope(target.body, (node) => {
    if (!ts.isVariableDeclaration(node)
      || !ts.isIdentifier(node.name)
      || !ts.isVariableDeclarationList(node.parent)
      || !(node.parent.flags & ts.NodeFlags.Const)
      || !node.initializer
      || !ts.isCallExpression(node.initializer)
      || !ts.isIdentifier(node.initializer.expression)
      || node.initializer.expression.text !== identityBinding
      || node.initializer.arguments.length !== 1
      || node.initializer.arguments[0].getText(sourceFile) !== 'c.env.DB') {
      return;
    }
    candidates.set(node.name.text, node);
  });
  for (const [name, declaration] of candidates) {
    let declarations = 0;
    let reassigned = false;
    visitOwnScope(target.body, (node) => {
      if (ts.isVariableDeclaration(node) && bindsName(node.name, name)) declarations += 1;
      if (ts.isBinaryExpression(node)
        && ts.isIdentifier(node.left)
        && node.left.text === name
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        reassigned = true;
      }
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
        && node.name?.text === name) {
        declarations += 1;
      }
    });
    if (declarations !== 1 || reassigned
      || target.parameters.some((parameter) => bindsName(parameter.name, name))) {
      candidates.delete(name);
      continue;
    }
    candidates.set(name, declaration);
  }
  return candidates;
}
function staticTruthiness(node, sourceFile) {
  if (node?.kind === ts.SyntaxKind.NullKeyword) return false;
  const value = staticValue(node, sourceFile);
  return value === null ? null : Boolean(value);
}
function isStaticallyDead(node, scope, sourceFile = scope.getSourceFile()) {
  let current = node;
  while (current && current !== scope.body) {
    const parent = current.parent;
    if (!parent) break;
    if (ts.isIfStatement(parent)) {
      const condition = staticTruthiness(parent.expression, sourceFile);
      if (parent.thenStatement === current && condition === false) {
        return true;
      }
      if (parent.elseStatement === current && condition === true) {
        return true;
      }
    }
    if (ts.isConditionalExpression(parent)) {
      const condition = staticTruthiness(parent.condition, sourceFile);
      if (parent.whenTrue === current && condition === false) return true;
      if (parent.whenFalse === current && condition === true) return true;
    }
    if (ts.isBinaryExpression(parent) && parent.right === current) {
      if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        && staticTruthiness(parent.left, sourceFile) === false) return true;
      if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken
        && staticTruthiness(parent.left, sourceFile) === true) return true;
    }
    if (ts.isWhileStatement(parent)
      && parent.statement === current
      && staticTruthiness(parent.expression, sourceFile) === false) return true;
    if (ts.isForStatement(parent)
      && parent.statement === current
      && staticTruthiness(parent.condition, sourceFile) === false) return true;
    if (ts.isBlock(parent)) {
      const currentIndex = parent.statements.findIndex((statement) => statement === current);
      if (currentIndex >= 0 && parent.statements.slice(0, currentIndex).some((statement) =>
        ts.isReturnStatement(statement) || ts.isThrowStatement(statement))) {
        return true;
      }
    }
    current = parent;
  }
  return false;
}
function workerRuntimeCalls(sourceFile, target, member) {
  const bindings = runtimeLocalBindings(sourceFile, target);
  const calls = [];
  visitOwnScope(target.body, (node) => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && bindings.has(node.expression.expression.text)
      && node.expression.name.text === member
      && node.pos > bindings.get(node.expression.expression.text).end
      && !isStaticallyDead(node, target)) {
      calls.push(node);
    }
  });
  return calls;
}
function uniqueTopLevelFunction(sourceFile, name) {
  const matches = sourceFile.statements.filter((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.equal(matches.length, 1, `${name} must be one unique top-level function`);
  return matches[0];
}
function isAwaitedThroughTransparentWrappers(node) {
  let current = node;
  while (current.parent
    && ((ts.isParenthesizedExpression(current.parent)
      || ts.isAsExpression(current.parent)
      || ts.isTypeAssertionExpression(current.parent)
      || ts.isNonNullExpression(current.parent)
      || ts.isSatisfiesExpression(current.parent))
      && current.parent.expression === current)) {
    current = current.parent;
  }
  return ts.isAwaitExpression(current.parent);
}
function caughtCleanupPassedToWaitUntil(sourceFile, cleanup) {
  const cleanupCalls = workerRuntimeCalls(sourceFile, cleanup, 'cleanupExpiredSessions');
  if (cleanupCalls.length !== 1) return false;
  const cleanupCall = cleanupCalls[0];
  if (!ts.isPropertyAccessExpression(cleanupCall.parent)
    || cleanupCall.parent.name.text !== 'catch'
    || !ts.isCallExpression(cleanupCall.parent.parent)) {
    return false;
  }
  const caught = cleanupCall.parent.parent;
  if (caught.arguments.length !== 1) return false;
  const callback = caught.arguments[0];
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return false;
  let fixedLogCalls = 0;
  const fixedLogNodes = [];
  let otherCalls = 0;
  let rethrows = 0;
  visitOwnScope(callback.body, (node) => {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'logApiErrorEvent'
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === 'expired_session_cleanup_failed') {
      fixedLogCalls += 1;
      fixedLogNodes.push(node);
    } else if (ts.isCallExpression(node)) {
      otherCalls += 1;
    }
    if (ts.isThrowStatement(node)) rethrows += 1;
  });
  if (fixedLogCalls !== 1 || otherCalls !== 0 || rethrows !== 0
    || isStaticallyDead(fixedLogNodes[0], callback, sourceFile)
    || isStaticallyDead(cleanupCall, cleanup)) return false;

  const waitUntilCalls = [];
  visitOwnScope(cleanup.body, (node) => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'waitUntil'
      && ts.isPropertyAccessExpression(node.expression.expression)
      && ts.isIdentifier(node.expression.expression.expression)
      && node.expression.expression.expression.text === 'c'
      && node.expression.expression.name.text === 'executionCtx'
      && !isStaticallyDead(node, cleanup)) {
      waitUntilCalls.push(node);
    }
  });
  return waitUntilCalls.length === 1
    && waitUntilCalls[0].arguments.length === 1
    && waitUntilCalls[0].arguments[0] === caught
    && !isAwaitedThroughTransparentWrappers(waitUntilCalls[0]);
}
function directHelperCalls(target, helperName) {
  if (hasTargetBindingConflict(target, helperName)) return [];
  const calls = [];
  visitOwnScope(target.body, (node) => {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === helperName
      && !isStaticallyDead(node, target)) {
      calls.push(node);
    }
  });
  return calls;
}
function staticPropertyName(expression, sourceFile) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) {
    const value = staticValue(expression.argumentExpression, sourceFile);
    return typeof value === 'string' ? value : null;
  }
  return null;
}
function appVariablesMembers(node) {
  if (ts.isTypeAliasDeclaration(node)
    && node.name.text === 'AppVariables'
    && ts.isTypeLiteralNode(node.type)) {
    return node.type.members;
  }
  if (ts.isInterfaceDeclaration(node) && node.name.text === 'AppVariables') {
    return node.members;
  }
  return [];
}
function declaredPropertyName(name, sourceFile) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const value = staticValue(name.expression, sourceFile);
    return typeof value === 'string' ? value : null;
  }
  return null;
}
function recordIdentityOwnershipViolations(
  root,
  sourceFile,
  credentialNames,
  violations,
) {
  visit(root, (node) => {
    if (ts.isCallExpression(node)
      && ['prepare', 'batch'].includes(staticPropertyName(node.expression, sourceFile))) {
      violations.push(`direct .${staticPropertyName(node.expression, sourceFile)}()`);
    }
    if (ts.isIdentifier(node) && credentialNames.has(node.text)) {
      violations.push(`credential primitive ${node.text}`);
    }
    if (ts.isIdentifier(node) && node.text === 'password_hash') {
      violations.push('password_hash ownership');
    }
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (/password_hash/i.test(node.text)) violations.push('password_hash SQL ownership');
      if (/\b(?:select|insert|update|delete)\b[\s\S]*\b(?:sessions|users|audit_logs)\b/i.test(node.text)) {
        violations.push('Identity table SQL ownership');
      }
    }
  });
}
function workerStructureViolations(sourceFile) {
  const violations = [];
  const credentialNames = new Set([
    'PASSWORD_HASH_SCHEME',
    'PASSWORD_HASH_ITERATIONS',
    'PASSWORD_SALT_BYTES',
    'PASSWORD_HASH_BITS',
    'sha256Hex',
    'bytesToHex',
    'hexToBytes',
    'constantTimeEqual',
    'derivePasswordHash',
    'hashPassword',
    'verifyPassword',
  ]);
  for (const statement of workerIdentitySlice(sourceFile)) {
    recordIdentityOwnershipViolations(statement, sourceFile, credentialNames, violations);
  }
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)
      && statement.body
      && ['requireAuth', 'scheduleExpiredSessionCleanup'].includes(statement.name?.text)) {
      recordIdentityOwnershipViolations(statement.body, sourceFile, credentialNames, violations);
    }
  }

  const forbiddenDeclarations = new Set([
    'SessionUser',
    ...credentialNames,
    'parseCookie',
    'getSessionUser',
    'authSetCookie',
    'authClearCookie',
  ]);
  visit(sourceFile, (node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node)
      || ts.isInterfaceDeclaration(node))
      && node.name && forbiddenDeclarations.has(node.name.text)) {
      violations.push(`legacy declaration ${node.name.text}`);
    }
    if (ts.isVariableDeclaration(node)) {
      for (const name of forbiddenDeclarations) {
        if (bindsName(node.name, name)) violations.push(`legacy declaration ${name}`);
      }
    }
    if (appVariablesMembers(node).some((member) => ts.isPropertySignature(member)
      && declaredPropertyName(member.name, sourceFile) === 'user')) {
      violations.push('AppVariables.user');
    }
    if (ts.isCallExpression(node)
      && ['get', 'set'].includes(staticPropertyName(node.expression, sourceFile))
      && staticValue(node.arguments[0], sourceFile) === 'user') {
      violations.push(`context.${staticPropertyName(node.expression, sourceFile)}('user')`);
    }
  });
  return [...new Set(violations)];
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
test('module ownership includes credential re-exports', () => {
  assert.equal(loadedModules(parseSource("export { pbkdf2 } from 'node:crypto';")).includes('node:crypto'), true);
});
test('target flow rejects a nested shadowed adapter-call decoy', () => {
  const source = `import { createPasswordHash } from './node-credential-crypto.mjs';
    export async function generateAdminSeed(legacyHash) {
      async function decoy(createPasswordHash) { return await createPasswordHash('pw'); }
      return await legacyHash('pw');
    }`;
  assert.equal(hasSharedCredentialFlow(source, { functionName: 'generateAdminSeed', mode: 'direct' }), false);
});
test('package export identifier used only as an object property key is unused', () => {
  const source = `import { CURRENT_PASSWORD_HASH_PREFIX } from '@here-is-order/identity-credential';
    export function buildRecoveryPostflightQuery() { return { params: [{ CURRENT_PASSWORD_HASH_PREFIX: true }] }; }`;
  assert.equal(hasPortableCoreOwnership(source, ['CURRENT_PASSWORD_HASH_PREFIX']), false);
});
test('local format ownership catches bounded array, arithmetic, and RegExp assembly', () => {
  const source = `import { CURRENT_PASSWORD_HASH_PREFIX } from '@here-is-order/identity-credential';
    const a = ['pbkdf2_', 'sha256'].join('');
    const b = 50_000 + 50_000;
    const c = new RegExp('^' + a + '\\$' + b + '\\$');
    export function buildRecoveryPostflightQuery() { return { params: [CURRENT_PASSWORD_HASH_PREFIX] }; }`;
  assert.equal(hasPortableCoreOwnership(source, ['CURRENT_PASSWORD_HASH_PREFIX']), false);
});
test('the versioned compatibility audit keeps its independent fixed-format literal', () => {
  const source = readFileSync(new URL('sql/identity-compatibility-v1.sql', import.meta.url), 'utf8');
  assert.match(source, /pbkdf2_sha256\$100000\$/);
});
test('the Worker keeps Identity SQL and credential ownership behind Runtime Identity', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const sourceFile = parseTypeScriptSource(source);
  assert.deepEqual(sourceFile.parseDiagnostics, []);
  assert.deepEqual(workerStructureViolations(sourceFile), []);

  for (const [method, path, member, mustAwait] of WORKER_IDENTITY_ROUTES) {
    const route = uniqueWorkerRoute(sourceFile, method, path);
    const calls = workerRuntimeCalls(sourceFile, route.callback, member);
    assert.equal(calls.length, 1, `${member} must be called exactly once in ${method} ${path}`);
    if (mustAwait) {
      assert.ok(ts.isAwaitExpression(calls[0].parent), `${member} must be awaited`);
    }
  }

  const requireAuth = uniqueTopLevelFunction(sourceFile, 'requireAuth');
  const resolutionCalls = workerRuntimeCalls(sourceFile, requireAuth, 'resolveSession');
  assert.equal(resolutionCalls.length, 1, 'resolveSession must be called exactly once');
  assert.ok(ts.isAwaitExpression(resolutionCalls[0].parent), 'resolveSession must be awaited');

  const cleanup = uniqueTopLevelFunction(sourceFile, 'scheduleExpiredSessionCleanup');
  assert.equal(
    caughtCleanupPassedToWaitUntil(sourceFile, cleanup),
    true,
    'cleanupExpiredSessions must be caught and passed as the sole waitUntil promise',
  );
  for (const [method, path] of [
    ['post', '/api/auth/login'],
    ['post', '/api/auth/logout'],
  ]) {
    const route = uniqueWorkerRoute(sourceFile, method, path);
    assert.equal(
      directHelperCalls(route.callback, 'scheduleExpiredSessionCleanup').length,
      1,
      `${method.toUpperCase()} ${path} must schedule cleanup exactly once`,
    );
  }
});
test('the Worker Runtime call validator rejects property, string, nested, and dead decoys', () => {
  const prefix = `import { identity } from './identity';
    const app = { post() {}, get() {} };
    app.get('/api/categories', async () => {});`;
  for (const body of [
    `const runtime = identity(c.env.DB); return { authenticate: runtime.authenticate };`,
    `const runtime = identity(c.env.DB); return 'runtime.authenticate()';`,
    `const runtime = identity(c.env.DB); async function decoy() { await runtime.authenticate({}); }`,
    `const runtime = identity(c.env.DB); if (false) { await runtime.authenticate({}); }`,
    `const runtime = identity(c.env.DB); false && await runtime.authenticate({});`,
    `const runtime = identity(c.env.DB); 0 && await runtime.authenticate({});`,
    `const runtime = identity(c.env.DB); true || await runtime.authenticate({});`,
    `const runtime = identity(c.env.DB); while (false) { await runtime.authenticate({}); }`,
    `const runtime = identity(c.env.DB); while (0) { await runtime.authenticate({}); }`,
    `const disabled = 0; const runtime = identity(c.env.DB); if (disabled) { await runtime.authenticate({}); }`,
    `const runtime = identity(c.env.DB); return; await runtime.authenticate({});`,
    `let runtime = identity(c.env.DB); await runtime.authenticate({});`,
    `let runtime = identity(c.env.DB); runtime = fake; await runtime.authenticate({});`,
    `return c.json({ ok: false });`,
  ]) {
    const source = `import { identity } from './identity';
      const app = { post() {}, get() {} };
      app.post('/api/auth/login', async (c) => { ${body} });
      app.get('/api/categories', async () => {});`;
    const sourceFile = parseTypeScriptSource(source, 'decoy.ts');
    const login = uniqueWorkerRoute(sourceFile, 'post', '/api/auth/login');
    assert.equal(workerRuntimeCalls(sourceFile, login.callback, 'authenticate').length, 0, body);
  }

  const sourceFile = parseTypeScriptSource(`${prefix}
    async function dead(c) {
      const runtime = identity(c.env.DB);
      await runtime.authenticate({});
    }
    app.post('/api/auth/login', async () => {});`, 'outside-decoy.ts');
  const login = uniqueWorkerRoute(sourceFile, 'post', '/api/auth/login');
  assert.equal(workerRuntimeCalls(sourceFile, login.callback, 'authenticate').length, 0);

  const shadowed = parseTypeScriptSource(`import { identity } from './identity';
    const app = { post() {}, get() {} };
    app.post('/api/auth/login', async (c, identity) => {
      const runtime = identity(c.env.DB);
      await runtime.authenticate({});
    });
    app.get('/api/categories', async () => {});`, 'shadowed-decoy.ts');
  assert.equal(workerRuntimeCalls(
    shadowed,
    uniqueWorkerRoute(shadowed, 'post', '/api/auth/login').callback,
    'authenticate',
  ).length, 0);
});
test('the Worker Identity slice rejects route movement beyond categories', () => {
  const source = `const app = { post() {}, get() {}, patch() {} };
    app.post('/api/auth/login', async () => {});
    app.post('/api/auth/logout', async () => {});
    app.get('/api/users', async () => {});
    app.post('/api/users', async () => {});
    app.get('/api/users/me', async () => {});
    app.patch('/api/users/me/password', async () => {});
    app.get('/api/categories', async () => {});
    app.patch('/api/users/:id/password', async () => {});`;
  assert.throws(
    () => workerIdentitySlice(parseTypeScriptSource(source, 'moved-route.ts')),
    /must remain inside the bounded Identity slice/,
  );
});
test('cleanup ownership rejects unused, arbitrary-receiver, and eager-log decoys', () => {
  for (const helper of [
    `function scheduleExpiredSessionCleanup(c) {
       const runtime = identity(c.env.DB);
       other.waitUntil(runtime.cleanupExpiredSessions().catch(() => {
         logApiErrorEvent('expired_session_cleanup_failed');
       }));
     }`,
    `function scheduleExpiredSessionCleanup(c) {
       const runtime = identity(c.env.DB);
       c.executionCtx.waitUntil(runtime.cleanupExpiredSessions().catch(
         logApiErrorEvent('expired_session_cleanup_failed')
       ));
     }`,
    `function scheduleExpiredSessionCleanup(c) {
       const runtime = identity(c.env.DB);
       c.executionCtx.waitUntil(runtime.cleanupExpiredSessions().catch(() => {
         if (false) logApiErrorEvent('expired_session_cleanup_failed');
       }));
     }`,
    `async function scheduleExpiredSessionCleanup(c) {
       const runtime = identity(c.env.DB);
       await c.executionCtx.waitUntil(runtime.cleanupExpiredSessions().catch(() => {
         logApiErrorEvent('expired_session_cleanup_failed');
       }));
     }`,
    `async function scheduleExpiredSessionCleanup(c) {
       const runtime = identity(c.env.DB);
       await (c.executionCtx.waitUntil(runtime.cleanupExpiredSessions().catch(() => {
         logApiErrorEvent('expired_session_cleanup_failed');
       })));
     }`,
  ]) {
    const sourceFile = parseTypeScriptSource(`import { identity } from './identity'; ${helper}`);
    assert.equal(caughtCleanupPassedToWaitUntil(
      sourceFile,
      uniqueTopLevelFunction(sourceFile, 'scheduleExpiredSessionCleanup'),
    ), false);
  }

  const unused = parseTypeScriptSource(`const app = { post() {} };
    app.post('/api/auth/login', async () => {});`);
  assert.equal(directHelperCalls(
    uniqueWorkerRoute(unused, 'post', '/api/auth/login').callback,
    'scheduleExpiredSessionCleanup',
  ).length, 0);

  for (const callback of [
    `async (c) => {
       const scheduleExpiredSessionCleanup = () => {};
       scheduleExpiredSessionCleanup(c);
     }`,
    `async (c, scheduleExpiredSessionCleanup) => {
       scheduleExpiredSessionCleanup(c);
     }`,
  ]) {
    const shadowed = parseTypeScriptSource(
      `const app = { post() {} }; app.post('/api/auth/login', ${callback});`,
    );
    assert.equal(directHelperCalls(
      uniqueWorkerRoute(shadowed, 'post', '/api/auth/login').callback,
      'scheduleExpiredSessionCleanup',
    ).length, 0);
  }
});
test('legacy context ownership catches interface, alias, element, and static-key forms', () => {
  const routes = `
    app.post('/api/auth/login', async () => {});
    app.post('/api/auth/logout', async () => {});
    app.get('/api/users', async () => {});
    app.post('/api/users', async () => {});
    app.get('/api/users/me', async () => {});
    app.patch('/api/users/me/password', async () => {});
    app.patch('/api/users/:id/password', async () => {});
    app.get('/api/categories', async () => {});`;
  for (const legacy of [
    `interface AppVariables { user?: unknown }`,
    `const ctx = c; ctx.get('user');`,
    `ctx['set']('user', value);`,
    `const legacyKey = 'user'; ctx.get(legacyKey);`,
    `const { hashPassword } = helpers;`,
  ]) {
    const sourceFile = parseTypeScriptSource(
      `const app = { post() {}, get() {}, patch() {} }; ${routes} ${legacy}`,
      'legacy-context-decoy.ts',
    );
    assert.notDeepEqual(workerStructureViolations(sourceFile), [], legacy);
  }
});
test('Identity D1 ownership catches element-access and static-key calls', () => {
  const routePrefix = `const app = { post() {}, get() {}, patch() {} };
    app.post('/api/auth/login', async (c) => {`;
  const routeSuffix = `});
    app.post('/api/auth/logout', async () => {});
    app.get('/api/users', async () => {});
    app.post('/api/users', async () => {});
    app.get('/api/users/me', async () => {});
    app.patch('/api/users/me/password', async () => {});
    app.patch('/api/users/:id/password', async () => {});
    app.get('/api/categories', async () => {});`;
  for (const directCall of [
    `await c.env.DB['prepare']('SELECT id FROM users');`,
    `await c.env.DB['batch']([]);`,
    `const method = 'prepare'; await c.env.DB[method]('SELECT id FROM users');`,
  ]) {
    const sourceFile = parseTypeScriptSource(
      `${routePrefix} ${directCall} ${routeSuffix}`,
      'element-d1-decoy.ts',
    );
    assert.match(workerStructureViolations(sourceFile).join('\n'), /direct \.(?:prepare|batch)\(\)/);
  }
});
test('Identity helper ownership rejects direct D1 alongside valid Runtime calls', () => {
  const routes = `
    app.post('/api/auth/login', async () => {});
    app.post('/api/auth/logout', async () => {});
    app.get('/api/users', async () => {});
    app.post('/api/users', async () => {});
    app.get('/api/users/me', async () => {});
    app.patch('/api/users/me/password', async () => {});
    app.patch('/api/users/:id/password', async () => {});
    app.get('/api/categories', async () => {});`;
  for (const helper of [
    `async function requireAuth(c) {
       const runtime = identity(c.env.DB);
       await runtime.resolveSession('token');
       await c.env.DB.prepare('SELECT id FROM users').first();
     }`,
    `function scheduleExpiredSessionCleanup(c) {
       const runtime = identity(c.env.DB);
       c.executionCtx.waitUntil(runtime.cleanupExpiredSessions().catch(() => {
         logApiErrorEvent('expired_session_cleanup_failed');
       }));
       c.env.DB['batch']([]);
     }`,
  ]) {
    const sourceFile = parseTypeScriptSource(
      `import { identity } from './identity';
       const app = { post() {}, get() {}, patch() {} }; ${helper} ${routes}`,
      'identity-helper-d1-decoy.ts',
    );
    assert.match(workerStructureViolations(sourceFile).join('\n'), /direct \.(?:prepare|batch)\(\)/);
  }
});
