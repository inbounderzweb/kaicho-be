export type MediaLogEvent =
  | "MEDIA_UPLOAD_SUCCESS"
  | "MEDIA_UPLOAD_FAILED"
  | "MEDIA_PROCESSING_FAILED"
  | "MEDIA_DELETED"
  | "MEDIA_CLEANUP"
  | "STORAGE_UPLOAD_FAILED"
  | "STORAGE_DELETE_FAILED";

// Structured, single-line logging — no file contents, tokens, or other
// sensitive request data, only identifiers and the reason for the event.
export function logMediaEvent(
  event: MediaLogEvent,
  details: Record<string, string | number | undefined>
): void {
  console.log(
    JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      ...details,
    })
  );
}
