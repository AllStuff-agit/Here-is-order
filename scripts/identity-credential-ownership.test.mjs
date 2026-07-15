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
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = staticValue(span.expression, sourceFile, seen);
      if (expression === null) return null;
      value += expression + span.literal.text;
    }
    return value;
  }
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
function hasValueBinding(sourceFile, identifier) {
  let found = false;
  visit(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node) && bindsName(node.name, identifier)) found = true;
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
      || ts.isEnumDeclaration(node)) && node.name?.text === identifier) {
      found = true;
    }
    if (ts.isParameter(node) && bindsName(node.name, identifier)) found = true;
    if (ts.isCatchClause(node) && node.variableDeclaration
      && bindsName(node.variableDeclaration.name, identifier)) found = true;
    if (ts.isImportClause(node) && node.name?.text === identifier) found = true;
    if ((ts.isImportSpecifier(node) || ts.isNamespaceImport(node))
      && node.name.text === identifier) found = true;
  });
  return found;
}
function hasValueWrite(sourceFile, identifier) {
  let found = false;
  const isTarget = (node) => ts.isIdentifier(node) && node.text === identifier
    || exactPropertyPath(node, ['globalThis', identifier]);
  visit(sourceFile, (node) => {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && isTarget(node.left)) {
      found = true;
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken]
        .includes(node.operator)
      && isTarget(node.operand)) {
      found = true;
    }
    if (ts.isDeleteExpression(node) && isTarget(node.expression)) found = true;
    if (ts.isCallExpression(node)) {
      const callPath = propertyPath(node.expression);
      const reflectivePropertyWrite = (
        exactPropertyPath(node.arguments[0], ['globalThis'])
        && staticValue(node.arguments[1], sourceFile) === identifier
        && (
          exactPropertyPath(node.expression, ['Reflect', 'set'])
          || exactPropertyPath(node.expression, ['Reflect', 'defineProperty'])
          || exactPropertyPath(node.expression, ['Reflect', 'deleteProperty'])
          || exactPropertyPath(node.expression, ['Object', 'defineProperty'])
        )
      );
      const objectAssignWrite = callPath?.[0] === 'Object'
        && callPath[1] === 'assign'
        && exactPropertyPath(node.arguments[0], ['globalThis'])
        && node.arguments.slice(1).some((argument) => {
          const object = unwrapTransparentExpression(argument);
          return ts.isObjectLiteralExpression(object)
            && object.properties.some((property) =>
              property.name
                && declaredPropertyName(property.name, sourceFile) === identifier);
        });
      if (reflectivePropertyWrite || objectAssignWrite) found = true;
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
function routeRegistration(sourceFile, call) {
  if (!ts.isCallExpression(call)) return null;
  let receiver = null;
  let method = null;
  if (ts.isPropertyAccessExpression(call.expression)) {
    receiver = call.expression.expression;
    method = call.expression.name.text;
  } else if (ts.isElementAccessExpression(call.expression)) {
    receiver = call.expression.expression;
    const value = staticValue(call.expression.argumentExpression, sourceFile);
    method = typeof value === 'string' ? value : null;
  }
  if (!receiver || !ts.isIdentifier(receiver) || receiver.text !== 'app' || method === null) {
    return null;
  }
  const [pathNode, callback] = call.arguments;
  const path = staticValue(pathNode, sourceFile);
  if (typeof path !== 'string'
    || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return null;
  }
  const statement = ts.isExpressionStatement(call.parent)
    && call.parent.expression === call
    && call.parent.parent === sourceFile
    ? call.parent
    : null;
  return { callback, call, method, path, statement };
}
function allRouteRegistrations(sourceFile) {
  const routes = [];
  visit(sourceFile, (node) => {
    const route = routeRegistration(sourceFile, node);
    if (route) routes.push(route);
  });
  return routes;
}
function topLevelRoutes(sourceFile) {
  return allRouteRegistrations(sourceFile).filter((route) => route.statement !== null);
}
function uniqueWorkerRoute(sourceFile, method, path) {
  const matches = topLevelRoutes(sourceFile).filter((route) =>
    route.method === method && route.path === path);
  assert.equal(matches.length, 1, `${method.toUpperCase()} ${path} must be one unique top-level route`);
  return matches[0];
}
function workerIdentitySlice(sourceFile) {
  const routes = topLevelRoutes(sourceFile);
  const requiredPaths = new Set(WORKER_IDENTITY_ROUTES.map(([, path]) => path));
  for (const route of allRouteRegistrations(sourceFile)) {
    if (requiredPaths.has(route.path) || route.path.startsWith('/api/categories')) {
      assert.ok(
        route.statement,
        `${route.method.toUpperCase()} ${route.path} must be a direct top-level route`,
      );
    }
  }
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
function directStatementWithin(node, target) {
  if (!ts.isBlock(target.body)) return null;
  let current = node;
  while (current.parent && current.parent !== target.body) current = current.parent;
  return current.parent === target.body && ts.isStatement(current) ? current : null;
}
function statementImmediatelyFollows(source, previous, next) {
  if (!previous || !next || previous.parent !== next.parent || !ts.isBlock(previous.parent)) {
    return false;
  }
  const statements = previous.parent.statements;
  return statements.indexOf(next) === statements.indexOf(previous) + 1
    && previous.getEnd() <= next.getStart(source);
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
      || !directStatementWithin(declaration, target)
      || isStaticallyDead(declaration, target, sourceFile)
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
  if (ts.isPrefixUnaryExpression(node)) {
    if (node.operator === ts.SyntaxKind.ExclamationToken) {
      const operand = staticTruthiness(node.operand, sourceFile);
      return operand === null ? null : !operand;
    }
    const operand = staticValue(node.operand, sourceFile);
    if (operand !== null
      && (node.operator === ts.SyntaxKind.PlusToken
        || node.operator === ts.SyntaxKind.MinusToken)) {
      const numeric = Number(operand);
      if (!Number.isNaN(numeric)) {
        return Boolean(node.operator === ts.SyntaxKind.MinusToken ? -numeric : numeric);
      }
    }
  }
  const value = staticValue(node, sourceFile);
  return value === null ? null : Boolean(value);
}
function statementAlwaysTerminates(statement, sourceFile) {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)
    || ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) {
    return true;
  }
  if (ts.isBlock(statement)) {
    return statement.statements.some((child) => statementAlwaysTerminates(child, sourceFile));
  }
  if (ts.isIfStatement(statement)) {
    const condition = staticTruthiness(statement.expression, sourceFile);
    if (condition === true) return statementAlwaysTerminates(statement.thenStatement, sourceFile);
    if (condition === false) {
      return statement.elseStatement
        ? statementAlwaysTerminates(statement.elseStatement, sourceFile)
        : false;
    }
    return Boolean(statement.elseStatement)
      && statementAlwaysTerminates(statement.thenStatement, sourceFile)
      && statementAlwaysTerminates(statement.elseStatement, sourceFile);
  }
  return false;
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
        statementAlwaysTerminates(statement, sourceFile))) {
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
      const bindingStatement = directStatementWithin(
        bindings.get(node.expression.expression.text),
        target,
      );
      const callStatement = directStatementWithin(node, target);
      if (!statementImmediatelyFollows(sourceFile, bindingStatement, callStatement)) return;

      if (member === 'cleanupExpiredSessions') {
        if (ts.isExpressionStatement(callStatement)) calls.push(node);
        return;
      }
      if (member === 'currentUser') {
        if (ts.isReturnStatement(callStatement)
          && ts.isCallExpression(callStatement.expression)
          && ts.isPropertyAccessExpression(callStatement.expression.expression)
          && ts.isIdentifier(callStatement.expression.expression.expression)
          && callStatement.expression.expression.expression.text === 'c'
          && callStatement.expression.expression.name.text === 'json'
          && callStatement.expression.arguments.length === 1
          && ts.isCallExpression(callStatement.expression.arguments[0])
          && ts.isIdentifier(callStatement.expression.arguments[0].expression)
          && callStatement.expression.arguments[0].expression.text === 'apiOk'
          && callStatement.expression.arguments[0].arguments.length === 1
          && callStatement.expression.arguments[0].arguments[0] === node) {
          calls.push(node);
        }
        return;
      }
      if (ts.isAwaitExpression(node.parent)
        && ts.isVariableDeclaration(node.parent.parent)
        && node.parent.parent.initializer === node.parent
        && ts.isVariableDeclarationList(node.parent.parent.parent)
        && (node.parent.parent.parent.flags & ts.NodeFlags.Const)
        && directStatementWithin(node.parent.parent, target) === callStatement) {
        calls.push(node);
      }
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
  if (!ts.isBlock(callback.body)) return false;
  const loggerBinding = namedImport(sourceFile, './observability', 'logApiErrorEvent');
  if (!loggerBinding
    || hasTargetBindingConflict(cleanup, loggerBinding)
    || hasTargetBindingConflict(callback, loggerBinding)) return false;
  let fixedLogCalls = 0;
  const fixedLogNodes = [];
  let otherCalls = 0;
  let rethrows = 0;
  visitOwnScope(callback.body, (node) => {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === loggerBinding
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
    || !directStatementWithin(fixedLogNodes[0], callback)
    || !ts.isExpressionStatement(directStatementWithin(fixedLogNodes[0], callback))
    || isStaticallyDead(fixedLogNodes[0], callback, sourceFile)
    || isStaticallyDead(cleanupCall, cleanup)) return false;

  const waitUntilCalls = [];
  let invalidWaitUntilOwnership = 0;
  const waitUntilAliases = boundMethodAliases(sourceFile, new Set(['waitUntil']));
  visitOwnScope(cleanup.body, (node) => {
    if (!ts.isCallExpression(node)) return;
    const method = staticPropertyName(node.expression, sourceFile);
    if (method === 'waitUntil') {
      const receiver = ts.isPropertyAccessExpression(node.expression)
        || ts.isElementAccessExpression(node.expression)
        ? node.expression.expression
        : null;
      const exactReceiver = receiver
        && (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver))
        && staticPropertyName(receiver, sourceFile) === 'executionCtx'
        && ts.isIdentifier(receiver.expression)
        && receiver.expression.text === 'c';
      if (exactReceiver && !isStaticallyDead(node, cleanup)) waitUntilCalls.push(node);
      else invalidWaitUntilOwnership += 1;
    }
    if (boundMethodName(node, sourceFile) === 'waitUntil'
      || (ts.isIdentifier(node.expression) && waitUntilAliases.has(node.expression.text))) {
      invalidWaitUntilOwnership += 1;
    }
  });
  if (invalidWaitUntilOwnership !== 0
    || waitUntilCalls.length !== 1
    || waitUntilCalls[0].arguments.length !== 1
    || waitUntilCalls[0].arguments[0] !== caught
    || isAwaitedThroughTransparentWrappers(waitUntilCalls[0])) {
    return false;
  }
  const waitUntilStatement = directStatementWithin(waitUntilCalls[0], cleanup);
  if (!waitUntilStatement
    || !ts.isExpressionStatement(waitUntilStatement)
    || waitUntilStatement.expression !== waitUntilCalls[0]) return false;
  const runtimeBinding = runtimeLocalBindings(sourceFile, cleanup).get(
    cleanupCall.expression.expression.text,
  );
  return statementImmediatelyFollows(
    sourceFile,
    runtimeBinding ? directStatementWithin(runtimeBinding, cleanup) : null,
    waitUntilStatement,
  );
}
function directHelperCalls(target, helperName) {
  if (hasTargetBindingConflict(target, helperName)) return [];
  const calls = [];
  visitOwnScope(target.body, (node) => {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === helperName
      && !isStaticallyDead(node, target)) {
      const statement = directStatementWithin(node, target);
      if (statement && ts.isExpressionStatement(statement) && statement.expression === node) {
        calls.push(node);
      }
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
function boundMethodName(initializer, sourceFile) {
  if (!initializer || !ts.isCallExpression(initializer)
    || staticPropertyName(initializer.expression, sourceFile) !== 'bind') {
    return null;
  }
  const boundTarget = ts.isPropertyAccessExpression(initializer.expression)
    || ts.isElementAccessExpression(initializer.expression)
    ? initializer.expression.expression
    : null;
  return boundTarget ? staticPropertyName(boundTarget, sourceFile) : null;
}
function boundMethodAliases(sourceFile, methodNames) {
  const aliases = new Set();
  visit(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return;
    if (ts.isIdentifier(node.name)
      && methodNames.has(boundMethodName(node.initializer, sourceFile))) {
      aliases.add(node.name.text);
      return;
    }
    if (ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        const sourceName = element.propertyName
          ? declaredPropertyName(element.propertyName, sourceFile)
          : declaredPropertyName(element.name, sourceFile);
        if (sourceName && methodNames.has(sourceName) && ts.isIdentifier(element.name)) {
          aliases.add(element.name.text);
        }
      }
    }
  });
  return aliases;
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
function namedTypeOwnsProperty(sourceFile, typeName, propertyName, seen = new Set()) {
  if (seen.has(typeName)) return false;
  const nextSeen = new Set([...seen, typeName]);
  const declarations = sourceFile.statements.filter((statement) =>
    (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement))
      && statement.name.text === typeName);
  return declarations.some((declaration) => {
    const members = ts.isTypeAliasDeclaration(declaration)
      && ts.isTypeLiteralNode(declaration.type)
      ? declaration.type.members
      : ts.isInterfaceDeclaration(declaration)
        ? declaration.members
        : [];
    if (members.some((member) => ts.isPropertySignature(member)
      && declaredPropertyName(member.name, sourceFile) === propertyName)) {
      return true;
    }
    if (ts.isTypeAliasDeclaration(declaration)) {
      return typeNodeOwnsProperty(
        sourceFile,
        declaration.type,
        propertyName,
        nextSeen,
      );
    }
    return declaration.heritageClauses?.some((clause) => clause.types.some((type) =>
      ts.isIdentifier(type.expression)
        && namedTypeOwnsProperty(
          sourceFile,
          type.expression.text,
          propertyName,
          nextSeen,
        ))) ?? false;
  });
}
function typeNodeOwnsProperty(sourceFile, typeNode, propertyName, seen = new Set()) {
  if (ts.isTypeLiteralNode(typeNode)) {
    return typeNode.members.some((member) => ts.isPropertySignature(member)
      && declaredPropertyName(member.name, sourceFile) === propertyName);
  }
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    return namedTypeOwnsProperty(sourceFile, typeNode.typeName.text, propertyName, seen);
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return typeNodeOwnsProperty(sourceFile, typeNode.type, propertyName, seen);
  }
  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.some((type) =>
      typeNodeOwnsProperty(sourceFile, type, propertyName, seen));
  }
  return false;
}
function recordIdentityOwnershipViolations(
  root,
  sourceFile,
  credentialNames,
  d1Aliases,
  violations,
) {
  visit(root, (node) => {
    if (ts.isCallExpression(node)) {
      const directMethod = staticPropertyName(node.expression, sourceFile);
      const boundMethod = boundMethodName(node, sourceFile);
      if (['prepare', 'batch'].includes(directMethod)) {
        violations.push(`direct .${directMethod}()`);
      }
      if (['prepare', 'batch'].includes(boundMethod)) {
        violations.push(`bound .${boundMethod}()`);
      }
      if (ts.isIdentifier(node.expression) && d1Aliases.has(node.expression.text)) {
        violations.push(`aliased D1 ${node.expression.text}()`);
      }
    }
    if (ts.isIdentifier(node) && credentialNames.has(node.text)) {
      violations.push(`credential primitive ${node.text}`);
    }
    if (ts.isIdentifier(node) && node.text === 'password_hash') {
      violations.push('password_hash ownership');
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)
      || ts.isBinaryExpression(node)
      || (ts.isIdentifier(node) && ts.isCallExpression(node.parent)
        && node.parent.arguments.includes(node))) {
      const value = staticValue(node, sourceFile);
      if (typeof value === 'string' && /password_hash/i.test(value)) {
        violations.push('password_hash SQL ownership');
      }
      if (typeof value === 'string'
        && /\b(?:select|insert|update|delete)\b[\s\S]*\b(?:sessions|users|audit_logs)\b/i.test(value)) {
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
  const d1Aliases = boundMethodAliases(sourceFile, new Set(['prepare', 'batch']));
  for (const statement of workerIdentitySlice(sourceFile)) {
    recordIdentityOwnershipViolations(
      statement,
      sourceFile,
      credentialNames,
      d1Aliases,
      violations,
    );
  }
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)
      && statement.body
      && ['requireAuth', 'scheduleExpiredSessionCleanup'].includes(statement.name?.text)) {
      recordIdentityOwnershipViolations(
        statement.body,
        sourceFile,
        credentialNames,
        d1Aliases,
        violations,
      );
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
  if (namedTypeOwnsProperty(sourceFile, 'AppVariables', 'user')) {
    violations.push('AppVariables.user');
  }
  const contextAliases = boundMethodAliases(sourceFile, new Set(['get', 'set']));
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
    if (ts.isCallExpression(node)
      && ['get', 'set'].includes(staticPropertyName(node.expression, sourceFile))
      && staticValue(node.arguments[0], sourceFile) === 'user') {
      violations.push(`context.${staticPropertyName(node.expression, sourceFile)}('user')`);
    }
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && contextAliases.has(node.expression.text)
      && staticValue(node.arguments[0], sourceFile) === 'user') {
      violations.push(`aliased context ${node.expression.text}('user')`);
    }
  });
  return [...new Set(violations)];
}
function unwrapTransparentExpression(node) {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current))) {
    current = current.expression;
  }
  return current;
}
function businessSessionFixtureViolations(sourceFile) {
  const violations = [];
  const fixtureBinding = namedImport(
    sourceFile,
    './helpers/identity-fixture',
    'createAuthenticatedIdentity',
  );
  if (!fixtureBinding) violations.push('missing createAuthenticatedIdentity named import');

  const wrappers = sourceFile.statements.filter((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'createSession');
  if (wrappers.length !== 1 || !wrappers[0].body) {
    violations.push('createSession must be one top-level function');
    return [...new Set(violations)];
  }
  const wrapper = wrappers[0];
  if (wrapper.body.statements.length !== 1
    || !ts.isReturnStatement(wrapper.body.statements[0])) {
    violations.push('createSession must contain only the direct fixture return');
  }
  if (fixtureBinding && hasTargetBindingConflict(wrapper, fixtureBinding)) {
    violations.push('createAuthenticatedIdentity binding is shadowed');
  }

  const calls = [];
  visitOwnScope(wrapper.body, (node) => {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === fixtureBinding) {
      calls.push(node);
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)
      || ts.isBinaryExpression(node)
      || (ts.isIdentifier(node) && ts.isCallExpression(node.parent)
        && node.parent.arguments.includes(node))) {
      const value = staticValue(node, sourceFile);
      if (typeof value === 'string' && /\binsert\s+into\s+sessions\b/i.test(value)) {
        violations.push('createSession owns session INSERT SQL');
      }
    }
  });
  if (calls.length !== 1) {
    violations.push('createSession must call createAuthenticatedIdentity exactly once');
    return [...new Set(violations)];
  }

  const call = calls[0];
  const awaited = ts.isAwaitExpression(call.parent) && call.parent.expression === call
    ? call.parent
    : null;
  let awaitedContainer = awaited;
  while (awaitedContainer?.parent
    && (ts.isParenthesizedExpression(awaitedContainer.parent)
      || ts.isAsExpression(awaitedContainer.parent)
      || ts.isTypeAssertionExpression(awaitedContainer.parent)
      || ts.isNonNullExpression(awaitedContainer.parent)
      || ts.isSatisfiesExpression(awaitedContainer.parent))
    && awaitedContainer.parent.expression === awaitedContainer) {
    awaitedContainer = awaitedContainer.parent;
  }
  const returnedProperty = awaitedContainer?.parent;
  const returnStatement = returnedProperty
    && ts.isPropertyAccessExpression(returnedProperty)
    && returnedProperty.name.text === 'rawToken'
    && returnedProperty.expression === awaitedContainer
    && ts.isReturnStatement(returnedProperty.parent)
    && returnedProperty.parent.expression === returnedProperty
    && returnedProperty.parent.parent === wrapper.body
    ? returnedProperty.parent
    : null;
  if (!returnStatement) {
    violations.push('createSession must return the awaited fixture rawToken directly');
  }
  return [...new Set(violations)];
}
function propertyPath(node) {
  const current = unwrapTransparentExpression(node);
  if (!current) return null;
  if (ts.isIdentifier(current)) return [current.text];
  if (ts.isPropertyAccessExpression(current)) {
    const prefix = propertyPath(current.expression);
    return prefix ? [...prefix, current.name.text] : null;
  }
  if (ts.isElementAccessExpression(current)) {
    const prefix = propertyPath(current.expression);
    const property = staticValue(current.argumentExpression, current.getSourceFile());
    return prefix && typeof property === 'string' ? [...prefix, property] : null;
  }
  return null;
}
function exactPropertyPath(node, expected) {
  const actual = propertyPath(node);
  return actual !== null
    && actual.length === expected.length
    && actual.every((part, index) => part === expected[index]);
}
function directConstDeclaration(node) {
  if (!ts.isVariableDeclaration(node)
    || !ts.isIdentifier(node.name)
    || !ts.isVariableDeclarationList(node.parent)
    || !(node.parent.flags & ts.NodeFlags.Const)
    || !ts.isVariableStatement(node.parent.parent)
    || !ts.isBlock(node.parent.parent.parent)) {
    return null;
  }
  return {
    declaration: node,
    name: node.name.text,
    statement: node.parent.parent,
  };
}
function enclosingDirectConstDeclaration(node, block) {
  let current = node;
  while (current && current !== block) {
    const direct = directConstDeclaration(current);
    if (direct && direct.statement.parent === block) return direct;
    current = current.parent;
  }
  return null;
}
function logicalOrTerms(expression) {
  const current = unwrapTransparentExpression(expression);
  if (ts.isBinaryExpression(current)
    && current.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return [...logicalOrTerms(current.left), ...logicalOrTerms(current.right)];
  }
  return [current];
}
function exactNegatedPath(expression, path) {
  const current = unwrapTransparentExpression(expression);
  return ts.isPrefixUnaryExpression(current)
    && current.operator === ts.SyntaxKind.ExclamationToken
    && exactPropertyPath(current.operand, path);
}
function exactInequality(expression, leftPath, rightPath) {
  const current = unwrapTransparentExpression(expression);
  return ts.isBinaryExpression(current)
    && current.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
    && ((exactPropertyPath(current.left, leftPath)
      && exactPropertyPath(current.right, rightPath))
      || (exactPropertyPath(current.left, rightPath)
        && exactPropertyPath(current.right, leftPath)));
}
function exactFailureDisjunction(expression, requirements) {
  const terms = logicalOrTerms(expression);
  if (terms.length !== requirements.length) return false;
  const remaining = [...requirements];
  for (const term of terms) {
    const index = remaining.findIndex((requirement) => requirement.kind === 'negated'
      ? exactNegatedPath(term, requirement.path)
      : exactInequality(term, requirement.leftPath, requirement.rightPath));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
}
function isDirectSetupSignalThrow(statement) {
  const candidate = ts.isBlock(statement) && statement.statements.length === 1
    ? statement.statements[0]
    : statement;
  return ts.isThrowStatement(candidate)
    && candidate.expression
    && ts.isNewExpression(candidate.expression)
    && ts.isIdentifier(candidate.expression.expression)
    && candidate.expression.expression.text === 'Error'
    && candidate.expression.arguments?.length === 0;
}
function objectPropertyValue(object, name, sourceFile) {
  if (!ts.isObjectLiteralExpression(object)) return null;
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property)
      && declaredPropertyName(property.name, sourceFile) === name) {
      return property.initializer;
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
      return property.name;
    }
  }
  return null;
}
function authenticatedIdentityFixtureViolations(sourceFile) {
  const violations = [];
  const identityBinding = namedImport(sourceFile, '../../src/identity', 'identity');
  const credentialBinding = namedImport(
    sourceFile,
    '../../scripts/identity-credential-conformance.mjs',
    'credentialKnownAnswer',
  );
  const envBinding = namedImport(sourceFile, 'cloudflare:workers', 'env');
  if (!identityBinding) violations.push('missing Runtime identity named import');
  if (!credentialBinding) violations.push('missing credentialKnownAnswer named import');
  if (!envBinding) violations.push('missing Cloudflare env named import');

  const functions = sourceFile.statements.filter((statement) =>
    ts.isFunctionDeclaration(statement)
      && statement.name?.text === 'createAuthenticatedIdentity');
  if (functions.length !== 1 || !functions[0].body) {
    violations.push('createAuthenticatedIdentity must be one top-level function');
    return [...new Set(violations)];
  }
  const target = functions[0];
  const setupErrorDeclarations = [];
  visit(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node) && bindsName(node.name, 'FIXTURE_SETUP_ERROR')) {
      setupErrorDeclarations.push(node);
    }
  });
  const setupError = setupErrorDeclarations.length === 1
    ? setupErrorDeclarations[0]
    : null;
  if (!setupError
    || !ts.isIdentifier(setupError.name)
    || !ts.isVariableDeclarationList(setupError.parent)
    || !(setupError.parent.flags & ts.NodeFlags.Const)
    || !ts.isVariableStatement(setupError.parent.parent)
    || setupError.parent.parent.parent !== sourceFile
    || staticValue(setupError.initializer, sourceFile)
      !== 'Failed to create authenticated Identity fixture.'
    || hasTargetBindingConflict(target, 'FIXTURE_SETUP_ERROR')) {
    violations.push('fixture setup error must be one immutable generic constant');
  }
  if (target.body.statements.length !== 1
    || !ts.isTryStatement(target.body.statements[0])) {
    violations.push('fixture flow must be enclosed by one top-level try statement');
    return [...new Set(violations)];
  }
  const tryStatement = target.body.statements[0];
  if (!tryStatement.catchClause || tryStatement.finallyBlock) {
    violations.push('fixture must replace every failure in one catch block');
  } else {
    const catchStatements = tryStatement.catchClause.block.statements;
    const thrown = catchStatements.length === 1
      && ts.isThrowStatement(catchStatements[0])
      ? catchStatements[0].expression
      : null;
    if (tryStatement.catchClause.variableDeclaration
      || !thrown
      || !ts.isNewExpression(thrown)
      || !ts.isIdentifier(thrown.expression)
      || thrown.expression.text !== 'Error'
      || thrown.arguments?.length !== 1
      || !ts.isIdentifier(thrown.arguments[0])
      || thrown.arguments[0].text !== 'FIXTURE_SETUP_ERROR') {
      violations.push('fixture catch must throw only the fixed generic setup error');
    }
  }
  if ((identityBinding && hasTargetBindingConflict(target, identityBinding))
    || (credentialBinding && hasTargetBindingConflict(target, credentialBinding))
    || (envBinding && hasTargetBindingConflict(target, envBinding))) {
    violations.push('fixture imports must not be shadowed or reassigned');
  }
  if (['Error', 'Object', 'Number', 'encodeURIComponent', 'crypto'].some((name) =>
    hasValueBinding(sourceFile, name) || hasValueWrite(sourceFile, name))) {
    violations.push('fixture security globals must not be shadowed');
  }
  let loggingOwnership = loadedModules(sourceFile).some((specifier) =>
    /(?:observability|log(?:ger|ging)?)/i.test(specifier));
  visit(sourceFile, (node) => {
    if (ts.isIdentifier(node) && node.text === 'console') loggingOwnership = true;
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && propertyPath(node)?.includes('console')) {
      loggingOwnership = true;
    }
    if (!ts.isCallExpression(node)) return;
    const path = propertyPath(node.expression);
    if (path?.[0] === 'console'
      || (ts.isIdentifier(node.expression)
        && /^(?:log|logger|debug|info|warn|error|trace)(?:[A-Z_].*)?$/i
          .test(node.expression.text))) {
      loggingOwnership = true;
    }
  });
  if (loggingOwnership) violations.push('fixture must not own logging');

  let nestedScopes = 0;
  visit(target.body, (node) => {
    if (node !== target.body && isNestedScope(node)) {
      nestedScopes += 1;
      return false;
    }
  });
  if (nestedScopes !== 0) violations.push('fixture must not contain nested decoy scopes');

  const envDbReferences = [];
  visitOwnScope(target.body, (node) => {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && exactPropertyPath(node, [envBinding, 'DB'])) {
      envDbReferences.push(node);
    }
  });
  if (envDbReferences.length !== 2) {
    violations.push('fixture must use env.DB only for bootstrap and Runtime creation');
  }
  const d1Calls = [];
  const d1Aliases = boundMethodAliases(sourceFile, new Set(['prepare', 'batch']));
  visitOwnScope(target.body, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return;
    const initializerPath = ts.isCallExpression(node.initializer)
      ? propertyPath(node.initializer.expression)
      : propertyPath(node.initializer);
    if (ts.isIdentifier(node.name)
      && initializerPath?.[0] === envBinding
      && initializerPath[1] === 'DB'
      && ['prepare', 'batch'].includes(initializerPath[2])) {
      d1Aliases.add(node.name.text);
    }
    if (ts.isObjectBindingPattern(node.name)
      && exactPropertyPath(node.initializer, [envBinding, 'DB'])) {
      for (const element of node.name.elements) {
        const method = element.propertyName
          ? declaredPropertyName(element.propertyName, sourceFile)
          : declaredPropertyName(element.name, sourceFile);
        if (['prepare', 'batch'].includes(method) && ts.isIdentifier(element.name)) {
          d1Aliases.add(element.name.text);
        }
      }
    }
  });
  let aliasedD1Calls = 0;
  const d1MemberReferences = [];
  visitOwnScope(target.body, (node) => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const memberPath = propertyPath(node);
      if (memberPath?.length === 3
        && memberPath[0] === envBinding
        && memberPath[1] === 'DB'
        && ['prepare', 'batch'].includes(memberPath[2])) {
        d1MemberReferences.push(node);
      }
    }
    if (!ts.isCallExpression(node)) return;
    const method = staticPropertyName(node.expression, sourceFile);
    const path = propertyPath(node.expression);
    const wrappedD1Method = path?.[0] === envBinding && path[1] === 'DB'
      ? path[2]
      : null;
    if (['prepare', 'batch'].includes(method)
      || ['prepare', 'batch'].includes(wrappedD1Method)) {
      d1Calls.push(node);
    }
    if (ts.isIdentifier(node.expression) && d1Aliases.has(node.expression.text)) {
      aliasedD1Calls += 1;
    }
  });
  if (aliasedD1Calls !== 0 || d1Calls.length !== 1
    || staticPropertyName(d1Calls[0]?.expression, sourceFile) !== 'prepare'
    || !exactPropertyPath(d1Calls[0]?.expression.expression, [envBinding, 'DB'])
    || typeof staticValue(d1Calls[0]?.arguments[0], sourceFile) !== 'string'
    || !/\binsert\s+into\s+users\b/i.test(
      staticValue(d1Calls[0]?.arguments[0], sourceFile) ?? '',
  )) {
    violations.push('fixture may own only one direct bootstrap user INSERT');
  }
  const bootstrapPrepare = d1Calls.length === 1 ? d1Calls[0] : null;
  if (d1MemberReferences.length !== 1
    || d1MemberReferences[0] !== bootstrapPrepare?.expression) {
    violations.push('fixture must not alias or indirectly invoke D1 methods');
  }
  const bindProperty = bootstrapPrepare?.parent;
  const bootstrapBind = bindProperty
    && ts.isPropertyAccessExpression(bindProperty)
    && bindProperty.expression === bootstrapPrepare
    && bindProperty.name.text === 'bind'
    && ts.isCallExpression(bindProperty.parent)
    && bindProperty.parent.expression === bindProperty
    ? bindProperty.parent
    : null;
  const inserted = bootstrapPrepare
    ? enclosingDirectConstDeclaration(bootstrapPrepare, tryStatement.tryBlock)
    : null;
  const bootstrapUsername = bootstrapBind?.arguments[0];
  const bootstrapName = bootstrapBind?.arguments[2];
  const bootstrapRole = bootstrapBind?.arguments[3];
  const bootstrapUsernameName = bootstrapUsername && ts.isIdentifier(bootstrapUsername)
    ? bootstrapUsername.text
    : null;
  const bootstrapNameName = bootstrapName && ts.isIdentifier(bootstrapName)
    ? bootstrapName.text
    : null;
  const bootstrapRoleName = bootstrapRole && ts.isIdentifier(bootstrapRole)
    ? bootstrapRole.text
    : null;
  const bootstrapSql = bootstrapPrepare
    ? staticValue(bootstrapPrepare.arguments[0], sourceFile)
    : null;
  if (!bootstrapBind
    || bootstrapBind.arguments.length !== 4
    || !inserted
    || !bootstrapUsernameName
    || !exactPropertyPath(
      bootstrapBind.arguments[1],
      [credentialBinding, 'currentHash'],
    )
    || !bootstrapNameName
    || !bootstrapRoleName
    || typeof bootstrapSql !== 'string'
    || !/\bis_active\s*,\s*is_deleted\b/i.test(bootstrapSql)
    || !/\bvalues\s*\(\s*\?\s*,\s*\?\s*,\s*\?\s*,\s*\?\s*,\s*1\s*,\s*0\s*\)/i
      .test(bootstrapSql)) {
    violations.push('fixture bootstrap must bind the canonical active user row');
  }

  let forbiddenSql = false;
  visit(sourceFile, (node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)
      || ts.isBinaryExpression(node)
      || ts.isCallExpression(node)
      || (ts.isIdentifier(node) && ts.isCallExpression(node.parent)
        && node.parent.arguments.includes(node))) {
      const value = staticValue(node, sourceFile);
      if (typeof value === 'string'
        && (/\b(?:select[\s\S]+?from|insert\s+into|update|delete\s+from)\s+sessions\b/i
          .test(value)
          || /\bdelete\s+from\s+audit_logs\b/i.test(value))) {
        forbiddenSql = true;
      }
    }
  });
  if (forbiddenSql) violations.push('fixture owns forbidden session or audit SQL');

  const identityCalls = [];
  visitOwnScope(target.body, (node) => {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === identityBinding) {
      identityCalls.push(node);
    }
  });
  if (identityCalls.length !== 1) {
    violations.push('fixture must invoke the imported identity factory exactly once');
  }
  const runtimeDeclarations = [];
  visitOwnScope(tryStatement.tryBlock, (node) => {
    const direct = directConstDeclaration(node);
    if (!direct || !node.initializer || !ts.isCallExpression(node.initializer)
      || !ts.isIdentifier(node.initializer.expression)
      || node.initializer.expression.text !== identityBinding
      || node.initializer.arguments.length !== 1
      || !exactPropertyPath(node.initializer.arguments[0], [envBinding, 'DB'])
      || direct.statement.parent !== tryStatement.tryBlock
      || isStaticallyDead(node, target, sourceFile)) return;
    runtimeDeclarations.push(direct);
  });
  if (runtimeDeclarations.length !== 1) {
    violations.push('fixture must create one direct Runtime identity binding');
    return [...new Set(violations)];
  }
  const runtime = runtimeDeclarations[0];
  let runtimeDeclarationsByName = 0;
  let runtimeReassigned = false;
  visitOwnScope(target.body, (node) => {
    if (ts.isVariableDeclaration(node) && bindsName(node.name, runtime.name)) {
      runtimeDeclarationsByName += 1;
    }
    if (ts.isBinaryExpression(node)
      && ts.isIdentifier(node.left)
      && node.left.text === runtime.name
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      runtimeReassigned = true;
    }
  });
  if (runtimeDeclarationsByName !== 1 || runtimeReassigned) {
    violations.push('fixture Runtime binding must be unique and immutable');
  }
  const unexpectedRuntimeMembers = [];
  const runtimeAliases = new Map();
  const runtimeMemberReferences = new Map([
    ['authenticate', []],
    ['resolveSession', []],
  ]);
  visitOwnScope(target.body, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializerPath = ts.isCallExpression(node.initializer)
        ? propertyPath(node.initializer.expression)
        : propertyPath(node.initializer);
      if (ts.isIdentifier(node.name)
        && initializerPath?.[0] === runtime.name
        && typeof initializerPath[1] === 'string') {
        runtimeAliases.set(node.name.text, initializerPath[1]);
      }
      if (ts.isIdentifier(node.name)
        && exactPropertyPath(node.initializer, [runtime.name])) {
        runtimeAliases.set(node.name.text, 'runtime-alias');
        unexpectedRuntimeMembers.push('runtime-alias');
      }
      if (ts.isObjectBindingPattern(node.name)
        && exactPropertyPath(node.initializer, [runtime.name])) {
        for (const element of node.name.elements) {
          const member = element.propertyName
            ? declaredPropertyName(element.propertyName, sourceFile)
            : declaredPropertyName(element.name, sourceFile);
          if (member && ts.isIdentifier(element.name)) {
            runtimeAliases.set(element.name.text, member);
          }
        }
      }
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      const memberPath = propertyPath(node);
      if (memberPath?.[0] === runtime.name
        && typeof memberPath[1] === 'string'
        && !['authenticate', 'resolveSession'].includes(memberPath[1])) {
        unexpectedRuntimeMembers.push(memberPath[1]);
      }
      if (memberPath?.length === 2
        && memberPath[0] === runtime.name
        && runtimeMemberReferences.has(memberPath[1])) {
        runtimeMemberReferences.get(memberPath[1]).push(node);
      }
    }
    if (!ts.isCallExpression(node)) return;
    const path = propertyPath(node.expression);
    if (path?.[0] === runtime.name && typeof path[1] === 'string') {
      if (!['authenticate', 'resolveSession'].includes(path[1]) || path.length !== 2) {
        unexpectedRuntimeMembers.push(path[1]);
      }
    }
    if (ts.isIdentifier(node.expression) && runtimeAliases.has(node.expression.text)) {
      unexpectedRuntimeMembers.push(runtimeAliases.get(node.expression.text));
    }
  });
  if (unexpectedRuntimeMembers.length !== 0) {
    violations.push('fixture may call only authenticate and resolveSession Runtime intents');
  }
  if ([...runtimeMemberReferences.values()].some((references) =>
    references.length !== 1
      || !ts.isCallExpression(references[0].parent)
      || references[0].parent.expression !== references[0])) {
    violations.push('fixture Runtime intents must each have one direct call site');
  }

  function directAwaitedRuntimeCall(method) {
    const calls = [];
    visitOwnScope(target.body, (node) => {
      if (ts.isCallExpression(node)
        && exactPropertyPath(node.expression, [runtime.name, method])) {
        calls.push(node);
      }
    });
    if (calls.length !== 1) return null;
    const call = calls[0];
    if (!ts.isAwaitExpression(call.parent) || call.parent.expression !== call
      || !ts.isVariableDeclaration(call.parent.parent)
      || call.parent.parent.initializer !== call.parent
      || isStaticallyDead(call, target, sourceFile)) return null;
    const direct = directConstDeclaration(call.parent.parent);
    return direct && direct.statement.parent === tryStatement.tryBlock
      ? { ...direct, call }
      : null;
  }

  const authentication = directAwaitedRuntimeCall('authenticate');
  if (!authentication) {
    violations.push('fixture must directly await one Runtime authenticate call');
    return [...new Set(violations)];
  }
  const authenticationInput = unwrapTransparentExpression(authentication.call.arguments[0]);
  if (authentication.call.arguments.length !== 1
    || !bootstrapUsernameName
    || !exactPropertyPath(
      objectPropertyValue(authenticationInput, 'username', sourceFile),
      [bootstrapUsernameName ?? '__missing__'],
    )
    || !exactPropertyPath(
      objectPropertyValue(authenticationInput, 'password', sourceFile),
      [credentialBinding, 'password'],
    )) {
    violations.push('fixture authenticate must use the canonical known password');
  }

  const directDeclarations = [];
  visitOwnScope(tryStatement.tryBlock, (node) => {
    const direct = directConstDeclaration(node);
    if (direct?.statement.parent === tryStatement.tryBlock) {
      directDeclarations.push(direct);
    }
  });
  const matchingDeclaration = (path) => directDeclarations.filter(({ declaration }) =>
    exactPropertyPath(declaration.initializer, path));
  const users = matchingDeclaration([authentication.name, 'value', 'user']);
  const rawTokens = matchingDeclaration([authentication.name, 'value', 'token']);
  const userIds = directDeclarations.filter(({ declaration }) =>
    ts.isCallExpression(declaration.initializer)
      && ts.isIdentifier(declaration.initializer.expression)
      && declaration.initializer.expression.text === 'Number'
      && declaration.initializer.arguments.length === 1
      && inserted
      && exactPropertyPath(
        declaration.initializer.arguments[0],
        [inserted.name, 'meta', 'last_row_id'],
      ));
  if (users.length !== 1) violations.push('fixture user must come from authenticate');
  if (rawTokens.length !== 1) violations.push('fixture rawToken must come from authenticate');
  if (userIds.length !== 1) violations.push('fixture must bind the inserted user ID');

  const authenticationRequirements = userIds.length === 1
    && bootstrapUsernameName && bootstrapNameName && bootstrapRoleName
    ? [
        { kind: 'negated', path: [authentication.name, 'ok'] },
        {
          kind: 'inequality',
          leftPath: [authentication.name, 'value', 'user', 'id'],
          rightPath: [userIds[0].name],
        },
        {
          kind: 'inequality',
          leftPath: [authentication.name, 'value', 'user', 'username'],
          rightPath: [bootstrapUsernameName],
        },
        {
          kind: 'inequality',
          leftPath: [authentication.name, 'value', 'user', 'name'],
          rightPath: [bootstrapNameName],
        },
        {
          kind: 'inequality',
          leftPath: [authentication.name, 'value', 'user', 'role'],
          rightPath: [bootstrapRoleName],
        },
      ]
    : [];
  const authenticationValidation = authenticationRequirements.length === 5
    && users.length === 1
    && tryStatement.tryBlock.statements.some((statement) =>
      ts.isIfStatement(statement)
        && statement.pos > authentication.statement.pos
        && statement.pos < users[0].statement.pos
        && !isStaticallyDead(statement, target, sourceFile)
        && isDirectSetupSignalThrow(statement.thenStatement)
        && exactFailureDisjunction(statement.expression, authenticationRequirements));
  if (!authenticationValidation) {
    violations.push('fixture must verify the authenticated user matches bootstrap input');
  }

  const resolution = directAwaitedRuntimeCall('resolveSession');
  if (!resolution
    || rawTokens.length !== 1
    || resolution.call.arguments.length !== 1
    || !ts.isIdentifier(resolution.call.arguments[0])
    || resolution.call.arguments[0].text !== rawTokens[0].name) {
    violations.push('fixture must resolve the authenticated raw token');
  }
  const principalRequirements = resolution && users.length === 1
    ? [
        { kind: 'negated', path: [resolution.name] },
        {
          kind: 'inequality',
          leftPath: [resolution.name, 'userId'],
          rightPath: [users[0].name, 'id'],
        },
        {
          kind: 'inequality',
          leftPath: [resolution.name, 'username'],
          rightPath: [users[0].name, 'username'],
        },
        {
          kind: 'inequality',
          leftPath: [resolution.name, 'name'],
          rightPath: [users[0].name, 'name'],
        },
        {
          kind: 'inequality',
          leftPath: [resolution.name, 'role'],
          rightPath: [users[0].name, 'role'],
        },
      ]
    : [];
  const principalValidation = resolution && principalRequirements.length === 5
    && tryStatement.tryBlock.statements.some((statement) =>
      ts.isIfStatement(statement)
        && statement.pos > resolution.statement.pos
        && !isStaticallyDead(statement, target, sourceFile)
        && isDirectSetupSignalThrow(statement.thenStatement)
        && exactFailureDisjunction(statement.expression, principalRequirements));
  if (!principalValidation) {
    violations.push('fixture must verify principal and user agreement');
  }

  const returns = [];
  visitOwnScope(tryStatement.tryBlock, (node) => {
    if (ts.isReturnStatement(node) && node.parent === tryStatement.tryBlock) {
      returns.push(node);
    }
  });
  const returned = returns.length === 1 ? returns[0].expression : null;
  const freezeCall = returned && ts.isCallExpression(returned)
    && exactPropertyPath(returned.expression, ['Object', 'freeze'])
    && returned.arguments.length === 1
    ? returned
    : null;
  const aggregate = freezeCall
    ? unwrapTransparentExpression(freezeCall.arguments[0])
    : null;
  const aggregateKeys = ts.isObjectLiteralExpression(aggregate)
    ? aggregate.properties.map((property) => declaredPropertyName(property.name, sourceFile))
    : [];
  if (!ts.isObjectLiteralExpression(aggregate)
    || aggregateKeys.join(',') !== 'user,principal,rawToken,cookie'
    || users.length !== 1
    || !exactPropertyPath(objectPropertyValue(aggregate, 'user', sourceFile), [users[0].name])
    || !resolution
    || !exactPropertyPath(
      objectPropertyValue(aggregate, 'principal', sourceFile),
      [resolution.name],
    )
    || rawTokens.length !== 1
    || !exactPropertyPath(
      objectPropertyValue(aggregate, 'rawToken', sourceFile),
      [rawTokens[0].name],
    )) {
    violations.push('fixture must return the exact frozen authenticated aggregate');
  }
  const cookie = ts.isObjectLiteralExpression(aggregate)
    ? objectPropertyValue(aggregate, 'cookie', sourceFile)
    : null;
  if (!cookie
    || !cookie.getText(sourceFile).includes('isorder_sid=')
    || !cookie.getText(sourceFile).includes(rawTokens[0]?.name ?? '__missing__')) {
    violations.push('fixture cookie must encode the authenticated raw token');
  }
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
test('general business sessions authenticate through the shared Identity fixture', () => {
  const source = readFileSync(new URL('../test/api.integration.test.ts', import.meta.url), 'utf8');
  const sourceFile = parseTypeScriptSource(source, 'test/api.integration.test.ts');
  assert.deepEqual(sourceFile.parseDiagnostics, []);
  assert.deepEqual(businessSessionFixtureViolations(sourceFile), []);
});
test('the shared Identity fixture owns only bootstrap user setup', () => {
  const source = readFileSync(new URL('../test/helpers/identity-fixture.ts', import.meta.url), 'utf8');
  const sourceFile = parseTypeScriptSource(source, 'test/helpers/identity-fixture.ts');
  assert.deepEqual(sourceFile.parseDiagnostics, []);
  assert.deepEqual(authenticatedIdentityFixtureViolations(sourceFile), []);
});
test('business fixture ownership rejects direct SQL, shadowing, and detached returns', () => {
  const source = readFileSync(new URL('../test/api.integration.test.ts', import.meta.url), 'utf8');
  const mutations = [
    source.replace(
      "from './helpers/identity-fixture';",
      "from './helpers/not-identity-fixture';",
    ),
    source.replace(
      '  return (await createAuthenticatedIdentity({ role })).rawToken;',
      "  await env.DB.prepare('INSERT INTO ' + 'sessions (token) VALUES (?)');\n"
        + '  return (await createAuthenticatedIdentity({ role })).rawToken;',
    ),
    source.replace(
      '  return (await createAuthenticatedIdentity({ role })).rawToken;',
      "  await createAuthenticatedIdentity({ role });\n  return 'manual-token';",
    ),
    source.replace(
      '  return (await createAuthenticatedIdentity({ role })).rawToken;',
      "  return 'manual-token';\n"
        + '  return (await createAuthenticatedIdentity({ role })).rawToken;',
    ),
    source.replace(
      'async function createSession(role:',
      'async function createSession(createAuthenticatedIdentity: unknown, role:',
    ),
  ];
  for (const [index, mutation] of mutations.entries()) {
    assert.notEqual(mutation, source);
    const sourceFile = parseTypeScriptSource(mutation, 'mutated-api.integration.test.ts');
    assert.notDeepEqual(
      businessSessionFixtureViolations(sourceFile),
      [],
      `business fixture mutation ${index + 1}`,
    );
  }
});
test('Identity fixture ownership rejects SQL, decoys, detached tokens, and extra intents', () => {
  const source = readFileSync(new URL('../test/helpers/identity-fixture.ts', import.meta.url), 'utf8');
  const mutations = [
    source.replace("from '../../src/identity';", "from '../../src/not-identity';"),
    source.replace(
      'const authenticated = await runtime.authenticate',
      'const authenticated = runtime.authenticate',
    ),
    source.replace(
      'const principal = await runtime.resolveSession(rawToken);',
      "const principal = await runtime.resolveSession('manual-token');",
    ),
    source.replace(
      '    const runtime = identity(env.DB);',
      "    await env.DB.prepare('INSERT INTO ' + 'sessions (token) VALUES (?)').run();\n"
        + '    const runtime = identity(env.DB);',
    ),
    source.replace('      rawToken,\n      cookie:', "      rawToken: 'manual-token',\n      cookie:"),
    source.replace(
      '    const runtime = identity(env.DB);',
      '    async function decoy() { return await identity(env.DB); }\n'
        + '    const runtime = identity(env.DB);',
    ),
    source.replace(
      '    const principal = await runtime.resolveSession(rawToken);',
      '    await runtime.cleanupExpiredSessions();\n'
        + '    const principal = await runtime.resolveSession(rawToken);',
    ),
    source.replace(
      '    const principal = await runtime.resolveSession(rawToken);',
      '    const cleanup = runtime.cleanupExpiredSessions.bind(runtime);\n'
        + '    await cleanup();\n'
        + '    const principal = await runtime.resolveSession(rawToken);',
    ),
    source.replace(
      '    const principal = await runtime.resolveSession(rawToken);',
      '    const { cleanupExpiredSessions } = runtime;\n'
        + '    await cleanupExpiredSessions();\n'
        + '    const principal = await runtime.resolveSession(rawToken);',
    ),
    source.replace(
      '    const principal = await runtime.resolveSession(rawToken);',
      '    const runtimeAlias = runtime;\n'
        + '    await runtimeAlias.cleanupExpiredSessions();\n'
        + '    const principal = await runtime.resolveSession(rawToken);',
    ),
    source.replace(
      '    const principal = await runtime.resolveSession(rawToken);',
      '    await Reflect.apply(runtime.authenticate, runtime, [{\n'
        + '      username,\n'
        + '      password: credentialKnownAnswer.password,\n'
        + '    }]);\n'
        + '    const principal = await runtime.resolveSession(rawToken);',
    ),
    source.replace(
      '    const runtime = identity(env.DB);',
      "    env.DB.prepare.call(env.DB, 'DELETE FROM sessions');\n"
        + '    const runtime = identity(env.DB);',
    ),
    source.replace(
      '    const runtime = identity(env.DB);',
      '    const prepareSession = env.DB.prepare.bind(env.DB);\n'
        + "    await prepareSession('DELETE FROM ' + 'sessions');\n"
        + '    const runtime = identity(env.DB);',
    ),
    source.replace(
      '    const runtime = identity(env.DB);',
      '    Reflect.apply(env.DB.prepare, env.DB, [username]);\n'
        + '    const runtime = identity(env.DB);',
    ),
    source.replace(
      '    const runtime = identity(env.DB);',
      '    const database = env.DB;\n'
        + '    Reflect.apply(database.prepare, database, [\n'
        + "      ['DELETE FROM ', 'sessions'].join(''),\n"
        + '    ]);\n'
        + '    const runtime = identity(env.DB);',
    ),
    source.replace(
      '    const principal = await runtime.resolveSession(rawToken);',
      '    console.error(credentialKnownAnswer.password);\n'
        + '    const principal = await runtime.resolveSession(rawToken);',
    ),
    source.replace(
      'const FIXTURE_SETUP_ERROR =',
      'const Error = class extends globalThis.Error {\n'
        + '  constructor(message: string) {\n'
        + '    super(message + credentialKnownAnswer.password);\n'
        + '  }\n'
        + '};\n\nconst FIXTURE_SETUP_ERROR =',
    ),
    source.replace(
      'const FIXTURE_SETUP_ERROR =',
      'Error = new Proxy(globalThis.Error, {\n'
        + '  construct(target, args) {\n'
        + '    return Reflect.construct(target, [\n'
        + '      String(args[0]) + credentialKnownAnswer.password,\n'
        + '    ]);\n'
        + '  },\n'
        + '});\n\nconst FIXTURE_SETUP_ERROR =',
    ),
    source.replace(
      'const FIXTURE_SETUP_ERROR =',
      'Reflect.set(globalThis, \'Error\', new Proxy(globalThis.Error, {\n'
        + '  construct(target, args) {\n'
        + '    return Reflect.construct(target, [\n'
        + '      String(args[0]) + credentialKnownAnswer.password,\n'
        + '    ]);\n'
        + '  },\n'
        + '}));\n\nconst FIXTURE_SETUP_ERROR =',
    ),
    source.replace(
      `    if (!authenticated.ok
      || authenticated.value.user.id !== userId
      || authenticated.value.user.username !== username
      || authenticated.value.user.name !== name
      || authenticated.value.user.role !== role) {
      throw new Error();
    }
`,
      '',
    ).replace(
      '    if (!principal || !matchesUser(principal, user)) throw new Error();',
      '    if (!principal) throw new Error();',
    ),
    source.replace(
      `    if (!authenticated.ok
      || authenticated.value.user.id !== userId
      || authenticated.value.user.username !== username
      || authenticated.value.user.name !== name
      || authenticated.value.user.role !== role) {
      throw new Error();
    }
`,
      `    if (false && (
      !authenticated.ok
      || authenticated.value.user.id !== userId
      || authenticated.value.user.username !== username
      || authenticated.value.user.name !== name
      || authenticated.value.user.role !== role
    )) {
      throw new Error();
    }
`,
    ),
    source.replace(
      `    if (!principal
      || principal.userId !== user.id
      || principal.username !== user.username
      || principal.name !== user.name
      || principal.role !== user.role) {
      throw new Error();
    }
`,
      '    if (!principal) throw new Error();\n',
    ),
    source.replace(
      `    if (!principal
      || principal.userId !== user.id
      || principal.username !== user.username
      || principal.name !== user.name
      || principal.role !== user.role) {
      throw new Error();
    }
`,
      `    if (false && (
      !principal
      || principal.userId !== user.id
      || principal.username !== user.username
      || principal.name !== user.name
      || principal.role !== user.role
    )) {
      throw new Error();
    }
`,
    ),
    source.replace(
      '    throw new Error(FIXTURE_SETUP_ERROR);',
      '    throw new Error(credentialKnownAnswer.password);',
    ),
  ];
  for (const [index, mutation] of mutations.entries()) {
    assert.notEqual(mutation, source);
    const sourceFile = parseTypeScriptSource(mutation, 'mutated-identity-fixture.ts');
    assert.notDeepEqual(
      authenticatedIdentityFixtureViolations(sourceFile),
      [],
      `Identity fixture mutation ${index + 1}`,
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
    `const runtime = identity(c.env.DB); if (!true) { await runtime.authenticate({}); }`,
    `const runtime = identity(c.env.DB); if (true) return; const result = await runtime.authenticate({});`,
    `if (true) return; const runtime = identity(c.env.DB); const result = await runtime.authenticate({});`,
    `const runtime = identity(c.env.DB); for (;;) { break; await runtime.authenticate({}); }`,
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
test('Identity ownership rejects bound D1 aliases and statically assembled SQL', () => {
  const sourceFile = parseTypeScriptSource(`
    const app = { post() {}, get() {}, patch() {} };
    app.post('/api/auth/login', async (c) => {
      const prepare = c.env.DB.prepare.bind(c.env.DB);
      await prepare('SELECT id FROM ' + 'users');
    });
    app.post('/api/auth/logout', async () => {});
    app.get('/api/users', async () => {});
    app.post('/api/users', async () => {});
    app.get('/api/users/me', async () => {});
    app.patch('/api/users/me/password', async () => {});
    app.patch('/api/users/:id/password', async () => {});
    app.get('/api/categories', async () => {});
  `, 'bound-d1-decoy.ts');
  const violations = workerStructureViolations(sourceFile).join('\n');
  assert.match(violations, /(?:bound \.prepare|aliased D1 prepare)/);
  assert.match(violations, /Identity table SQL ownership/);
});
test('Identity boundary rejects wrapped route registrations before a direct decoy', () => {
  const sourceFile = parseTypeScriptSource(`
    const app = { post() {}, get() {}, patch() {} };
    if (true) app.get('/api/categories', async () => {});
    app.post('/api/auth/login', async () => {});
    app.post('/api/auth/logout', async () => {});
    app.get('/api/users', async () => {});
    app.post('/api/users', async () => {});
    app.get('/api/users/me', async () => {});
    app.patch('/api/users/me/password', async () => {});
    app.patch('/api/users/:id/password', async () => {});
    app.get('/api/categories', async () => {});
  `, 'wrapped-boundary-decoy.ts');
  assert.throws(
    () => workerIdentitySlice(sourceFile),
    /must be a direct top-level route/,
  );
});
test('legacy context ownership follows AppVariables and bound getter aliases', () => {
  const sourceFile = parseTypeScriptSource(`
    type LegacyVariables = { user?: unknown };
    type AppVariables = LegacyVariables;
    const app = { post() {}, get() {}, patch() {} };
    app.post('/api/auth/login', async () => {});
    app.post('/api/auth/logout', async () => {});
    app.get('/api/users', async () => {});
    app.post('/api/users', async () => {});
    app.get('/api/users/me', async () => {});
    app.patch('/api/users/me/password', async () => {});
    app.patch('/api/users/:id/password', async () => {});
    app.get('/api/categories', async () => {});
    const getUser = c.get.bind(c);
    getUser('user');
  `, 'aliased-context-decoy.ts');
  const violations = workerStructureViolations(sourceFile).join('\n');
  assert.match(violations, /AppVariables\.user/);
  assert.match(violations, /aliased context getUser\('user'\)/);
});
test('cleanup ownership rejects shadowed logging and aliased extra waitUntil calls', () => {
  for (const extra of [
    `const logApiErrorEvent = () => {};
     logApiErrorEvent('expired_session_cleanup_failed');`,
    `logApiErrorEvent('expired_session_cleanup_failed');`,
  ]) {
    const additionalWait = extra.startsWith('const logApiErrorEvent')
      ? ''
      : `const waitLater = c.executionCtx.waitUntil.bind(c.executionCtx);
         waitLater(Promise.resolve());`;
    const sourceFile = parseTypeScriptSource(`
      import { identity } from './identity';
      import { logApiErrorEvent } from './observability';
      function scheduleExpiredSessionCleanup(c) {
        const runtime = identity(c.env.DB);
        c.executionCtx.waitUntil(runtime.cleanupExpiredSessions().catch(() => {
          ${extra}
        }));
        ${additionalWait}
      }
    `, 'cleanup-alias-decoy.ts');
    assert.equal(caughtCleanupPassedToWaitUntil(
      sourceFile,
      uniqueTopLevelFunction(sourceFile, 'scheduleExpiredSessionCleanup'),
    ), false);
  }
});
