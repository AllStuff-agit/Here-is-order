export type ApiErrorEvent =
  | 'unhandled_request_error'
  | 'expired_session_cleanup_failed'
  | 'd1_readiness_failed';

const SERIALIZED_ERROR_EVENT_RECORDS: Readonly<Record<ApiErrorEvent, string>> = Object.freeze({
  unhandled_request_error: '{"event":"unhandled_request_error"}',
  expired_session_cleanup_failed: '{"event":"expired_session_cleanup_failed"}',
  d1_readiness_failed: '{"event":"d1_readiness_failed"}',
});

const isApiErrorEvent = (event: unknown): event is ApiErrorEvent =>
  typeof event === 'string' && Object.hasOwn(SERIALIZED_ERROR_EVENT_RECORDS, event);

export function logApiErrorEvent(event: ApiErrorEvent): void {
  if (!isApiErrorEvent(event)) {
    return;
  }

  console.error(SERIALIZED_ERROR_EVENT_RECORDS[event]);
}
