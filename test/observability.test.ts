import { afterEach, describe, expect, it, vi } from 'vitest';

import { logApiErrorEvent, type ApiErrorEvent } from '../src/observability';

const API_ERROR_EVENTS: readonly ApiErrorEvent[] = [
  'unhandled_request_error',
  'expired_session_cleanup_failed',
  'd1_readiness_failed',
];

describe('API error observability', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(API_ERROR_EVENTS)('logs %s as one exact structured record', (event) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logApiErrorEvent(event);

    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(JSON.stringify({ event }));
  });

  it('has no caller payload parameter and never serializes an extra exception', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sensitiveMessage = 'password=do-not-log';

    Reflect.apply(logApiErrorEvent, undefined, [
      'unhandled_request_error',
      new Error(sensitiveMessage),
    ]);

    expect(logApiErrorEvent).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({ event: 'unhandled_request_error' }),
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(sensitiveMessage);
  });

  it('emits nothing for a non-allowlisted runtime value', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    Reflect.apply(logApiErrorEvent, undefined, ['password=do-not-log']);

    expect(consoleError).not.toHaveBeenCalled();
  });
});
