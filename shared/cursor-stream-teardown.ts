// cursor-agent ACP appends this internal stream teardown as an assistant chunk
// and still returns end_turn (Cursor forum, 2026).
export const CURSOR_STREAM_TEARDOWN = "Error: RetriableError: WritableIterable is closed";

/** The reply without a trailing cursor-agent stream teardown, and whether one was there. */
export function dropCursorStreamTeardown(text: string): { text: string; tornDown: boolean } {
  const bodyEnd = text.search(/\s+$/);
  const body = bodyEnd === -1 ? text : text.slice(0, bodyEnd);
  if (!body.endsWith(CURSOR_STREAM_TEARDOWN)) return { text, tornDown: false };
  const before = body.slice(0, body.length - CURSOR_STREAM_TEARDOWN.length);
  if (before !== "" && !before.endsWith("\n")) return { text, tornDown: false };
  return { text: before.replace(/(?:\r?\n)+$/, ""), tornDown: true };
}
