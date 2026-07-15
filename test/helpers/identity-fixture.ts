import type {
  SessionUserProjection,
  UserRole,
} from '@here-is-order/http-contract/identity';
import { env } from 'cloudflare:workers';

import { credentialKnownAnswer } from '../../scripts/identity-credential-conformance.mjs';
import {
  identity,
  type IdentityPrincipal,
} from '../../src/identity';

const FIXTURE_SETUP_ERROR = 'Failed to create authenticated Identity fixture.';

export async function createAuthenticatedIdentity(options: Readonly<{
  role?: UserRole;
  username?: string;
  name?: string;
}> = {}): Promise<Readonly<{
  user: SessionUserProjection;
  principal: IdentityPrincipal;
  rawToken: string;
  cookie: string;
}>> {
  try {
    const role = options.role ?? 'admin';
    const username = options.username ?? `${role}-${crypto.randomUUID()}`;
    const name = options.name ?? role;
    const inserted = await env.DB.prepare(
      `INSERT INTO users
         (username, password_hash, name, role, is_active, is_deleted)
       VALUES (?, ?, ?, ?, 1, 0)`,
    ).bind(
      username,
      credentialKnownAnswer.currentHash,
      name,
      role,
    ).run();
    const userId = Number(inserted.meta.last_row_id);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error();

    const runtime = identity(env.DB);
    const authenticated = await runtime.authenticate({
      username,
      password: credentialKnownAnswer.password,
    });
    if (!authenticated.ok
      || authenticated.value.user.id !== userId
      || authenticated.value.user.username !== username
      || authenticated.value.user.name !== name
      || authenticated.value.user.role !== role) {
      throw new Error();
    }

    const user = authenticated.value.user;
    const rawToken = authenticated.value.token;
    const principal = await runtime.resolveSession(rawToken);
    if (!principal
      || principal.userId !== user.id
      || principal.username !== user.username
      || principal.name !== user.name
      || principal.role !== user.role) {
      throw new Error();
    }

    return Object.freeze({
      user,
      principal,
      rawToken,
      cookie: `isorder_sid=${encodeURIComponent(rawToken)}`,
    });
  } catch {
    throw new Error(FIXTURE_SETUP_ERROR);
  }
}
