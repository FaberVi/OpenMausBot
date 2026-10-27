const LCS_CELL_CAP = 4_000_000;
const CONTEXT = 2;

type Op = { tag: " " | "-" | "+"; line: string };

function editScript(fullA: string[], fullB: string[]): Op[] {
  if (fullA.length * fullB.length > LCS_CELL_CAP) {
    return [...fullA.map((line) => ({ tag: "-" as const, line })), ...fullB.map((line) => ({ tag: "+" as const, line }))];
  }
  let shared = 0;
  while (shared < fullA.length && shared < fullB.length && fullA[shared] === fullB[shared]) shared++;
  const ops: Op[] = fullA.slice(0, shared).map((line) => ({ tag: " ", line }));
  const a = fullA.slice(shared);
  const b = fullB.slice(shared);
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] = a[i] === b[j]
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ tag: " ", line: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      ops.push({ tag: "-", line: a[i++] });
    } else {
      ops.push({ tag: "+", line: b[j++] });
    }
  }
  while (i < a.length) ops.push({ tag: "-", line: a[i++] });
  while (j < b.length) ops.push({ tag: "+", line: b[j++] });
  return ops;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export interface UnifiedDiff {
  text: string;
  added: number;
  removed: number;
  truncated: boolean;
}

export function unifiedDiff(before: string, after: string, path: string, cap = 8_000): UnifiedDiff {
  if (before === after) return { text: "", added: 0, removed: 0, truncated: false };
  const ops = editScript(splitLines(before), splitLines(after));
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.tag === "+") added++;
    else if (op.tag === "-") removed++;
  }
  const changes: number[] = [];
  ops.forEach((op, k) => {
    if (op.tag !== " ") changes.push(k);
  });
  const hunks: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < changes.length) {
    let lastChange = changes[index];
    let next = index + 1;
    while (next < changes.length && changes[next] - lastChange <= CONTEXT * 2 + 1) lastChange = changes[next++];
    hunks.push({ start: Math.max(0, changes[index] - CONTEXT), end: Math.min(ops.length - 1, lastChange + CONTEXT) });
    index = next;
  }
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  for (const hunk of hunks) {
    for (; cursor < hunk.start; cursor++) {
      if (ops[cursor].tag !== "+") oldLine++;
      if (ops[cursor].tag !== "-") newLine++;
    }
    const slice = ops.slice(hunk.start, hunk.end + 1);
    const oldCount = slice.filter((op) => op.tag !== "+").length;
    const newCount = slice.filter((op) => op.tag !== "-").length;
    lines.push(`@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`);
    for (const op of slice) lines.push(`${op.tag}${op.line}`);
    for (; cursor <= hunk.end; cursor++) {
      if (ops[cursor].tag !== "+") oldLine++;
      if (ops[cursor].tag !== "-") newLine++;
    }
  }
  let text = lines.join("\n");
  let truncated = false;
  if (text.length > cap) {
    text = `${text.slice(0, cap)}\n… (diff cut here)`;
    truncated = true;
  }
  return { text, added, removed, truncated };
}
