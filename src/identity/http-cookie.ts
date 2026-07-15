export const AUTH_COOKIE = 'isorder_sid';

const SESSION_SECONDS = 2_592_000;

export function parseAuthCookie(cookieHeader: string | undefined) {
  let authCookie: string | undefined;
  if (!cookieHeader) return authCookie;

  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = decodeURIComponent(pair.slice(idx + 1).trim());
    if (key === AUTH_COOKIE) authCookie = value;
  }

  return authCookie;
}

export function authSetCookie(token: string, secure: boolean) {
  return [
    'Set-Cookie',
    `${AUTH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_SECONDS}; SameSite=Strict${secure ? '; Secure' : ''}`,
  ] as const;
}

export function authClearCookie(secure: boolean) {
  return [
    'Set-Cookie',
    `${AUTH_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict${secure ? '; Secure' : ''}`,
  ] as const;
}
