import { describe, expect, it } from "vitest";
import { CURSOR_STREAM_TEARDOWN, dropCursorStreamTeardown } from "./cursor-stream-teardown.ts";

describe("dropCursorStreamTeardown", () => {
  it("drops a trailing teardown chunk and keeps the reply", () => {
    expect(dropCursorStreamTeardown(`Ricompila in Unity.\n\n${CURSOR_STREAM_TEARDOWN}`)).toEqual({
      text: "Ricompila in Unity.",
      tornDown: true,
    });
    expect(dropCursorStreamTeardown(`\n\n${CURSOR_STREAM_TEARDOWN}\n`)).toEqual({ text: "", tornDown: true });
  });

  it("leaves a quote that is not its own trailing line", () => {
    const quoted = `The log said ${CURSOR_STREAM_TEARDOWN} and then continued.`;
    expect(dropCursorStreamTeardown(quoted)).toEqual({ text: quoted, tornDown: false });
  });
});
