export const SMOKE_IDENTITY = Object.freeze({
  username: 'deployment-smoke',
  name: 'Deployment Smoke',
  role: 'staff',
  databaseBinding: 'DB',
  databaseName: 'hereisorder',
});

export const SMOKE_IDENTITY_ACTIONS = Object.freeze([
  'provision',
  'rotate',
  'disable',
]);

export function parseSmokeIdentityArgs(argv) {
  if (!Array.isArray(argv)
    || argv.length !== 2
    || argv[1] !== '--remote'
    || !SMOKE_IDENTITY_ACTIONS.includes(argv[0])) {
    throw new Error('Smoke identity command was invalid.');
  }
  return Object.freeze({ action: argv[0], remote: true });
}

export function expectedSmokeIdentityConfirmation(action) {
  if (!SMOKE_IDENTITY_ACTIONS.includes(action)) {
    throw new Error('Smoke identity action was invalid.');
  }
  return `MANAGE ${SMOKE_IDENTITY.databaseName} ${SMOKE_IDENTITY.username} ${action}`;
}

export function validateSmokeIdentityPassword(value) {
  if (typeof value !== 'string'
    || Array.from(value).length < 32
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Smoke identity password was invalid.');
  }
  return value;
}
