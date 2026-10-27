export function quoteToml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function quoteTomlKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  return quoteToml(key);
}

function stripTomlLineComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (quote === '"' && c === "\\") {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "#") return line.slice(0, i);
    if (c === '"' || c === "'") quote = c;
  }
  return line;
}

/** Invalid, unknown, surrogate or out-of-range escapes return ok:false, so a heading is never
 *  canonicalized to a colliding alias. */
function takeTomlBasicEscape(
  text: string,
  i: number,
): { ok: true; value: string; next: number } | { ok: false } {
  const code = text[i + 1];
  if (code === undefined) return { ok: false };
  if (code === "u") {
    const hex = text.slice(i + 2, i + 6);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { ok: false };
    const point = parseInt(hex, 16);
    if (point >= 0xd800 && point <= 0xdfff) return { ok: false };
    return { ok: true, value: String.fromCharCode(point), next: i + 6 };
  }
  if (code === "U") {
    const hex = text.slice(i + 2, i + 10);
    if (!/^[0-9a-fA-F]{8}$/.test(hex)) return { ok: false };
    const point = parseInt(hex, 16);
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return { ok: false };
    return { ok: true, value: String.fromCodePoint(point), next: i + 10 };
  }
  const named: Record<string, string> = {
    b: "\b",
    t: "\t",
    n: "\n",
    f: "\f",
    r: "\r",
    '"': '"',
    "\\": "\\",
  };
  if (!(code in named)) return { ok: false };
  return { ok: true, value: named[code]!, next: i + 2 };
}

function canonicalizeTomlHeading(heading: string): string | null {
  const trimmed = stripTomlLineComment(heading).trim();
  const match = trimmed.match(/^\[([^[\]]+)\]$/);
  if (!match) return null;
  const parts: string[] = [];
  const inner = match[1]!;
  let i = 0;
  const skipSep = () => {
    while (i < inner.length && (inner[i] === "." || inner[i] === " " || inner[i] === "\t")) i += 1;
  };
  skipSep();
  while (i < inner.length) {
    const q = inner[i];
    if (q === '"' || q === "'") {
      i += 1;
      let value = "";
      while (i < inner.length && inner[i] !== q) {
        if (q === '"' && inner[i] === "\\") {
          const taken = takeTomlBasicEscape(inner, i);
          if (!taken.ok) return null;
          value += taken.value;
          i = taken.next;
          continue;
        }
        value += inner[i];
        i += 1;
      }
      if (inner[i] === q) i += 1;
      parts.push(value);
      skipSep();
      continue;
    }
    let value = "";
    while (i < inner.length && inner[i] !== ".") {
      value += inner[i];
      i += 1;
    }
    const part = value.trim();
    if (part) parts.push(part);
    skipSep();
  }
  return parts.length ? parts.join(".") : null;
}

function unquoteTomlKey(raw: string): string {
  const key = raw.trim();
  if (key.length >= 2 && ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))) {
    return key.slice(1, -1);
  }
  return key;
}

function tomlRowKey(row: string): string {
  const eq = row.indexOf("=");
  return unquoteTomlKey(eq < 0 ? row : row.slice(0, eq));
}

/** `[[array]]` headings bound a table but are not patchable; skipping `#` comments keeps an
 *  apostrophe from opening a phantom string. */
function tomlTables(text: string): Array<{ name: string; headingStart: number; bodyStart: number; end: number }> {
  type Mode = "out" | "basic" | "literal" | "mlbasic" | "mllit";
  const headings: Array<{ name: string | null; patchable: boolean; lineStart: number; lineEnd: number }> = [];
  let mode: Mode = "out";
  let i = 0;
  const atLineStart = (idx: number) => idx === 0 || text[idx - 1] === "\n";
  while (i < text.length) {
    if (mode === "mlbasic") {
      if (text.startsWith('"""', i)) {
        mode = "out";
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === "mllit") {
      if (text.startsWith("'''", i)) {
        mode = "out";
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === "basic") {
      if (text[i] === "\n") {
        mode = "out";
        i += 1;
        continue;
      }
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i] === '"') mode = "out";
      i += 1;
      continue;
    }
    if (mode === "literal") {
      if (text[i] === "\n") {
        mode = "out";
        i += 1;
        continue;
      }
      if (text[i] === "'") mode = "out";
      i += 1;
      continue;
    }
    if (text.startsWith('"""', i)) {
      mode = "mlbasic";
      i += 3;
      continue;
    }
    if (text.startsWith("'''", i)) {
      mode = "mllit";
      i += 3;
      continue;
    }
    if (text[i] === '"') {
      mode = "basic";
      i += 1;
      continue;
    }
    if (text[i] === "'") {
      mode = "literal";
      i += 1;
      continue;
    }
    if (text[i] === "#") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (atLineStart(i)) {
      let j = i;
      while (j < text.length && (text[j] === " " || text[j] === "\t")) j += 1;
      if (text[j] === "[") {
        const nl = text.indexOf("\n", j);
        const lineEnd = nl < 0 ? text.length : nl;
        const raw = text.slice(j, lineEnd).replace(/\r$/, "");
        const stripped = stripTomlLineComment(raw).trim();
        const array = stripped.startsWith("[[");
        const name = array
          ? canonicalizeTomlHeading(`[${stripped.replace(/^\s*\[\[/, "").replace(/\]\]\s*$/, "")}]`)
          : canonicalizeTomlHeading(raw);
        headings.push({ name, patchable: !array && name !== null, lineStart: i, lineEnd });
        i = lineEnd + (nl < 0 ? 0 : 1);
        continue;
      }
    }
    i += 1;
  }
  return headings
    .map((heading, index) => ({
      heading,
      end: index + 1 < headings.length ? headings[index + 1]!.lineStart : text.length,
    }))
    .filter((entry) => entry.heading.patchable && entry.heading.name)
    .map((entry) => ({
      name: entry.heading.name!,
      headingStart: entry.heading.lineStart,
      bodyStart: entry.heading.lineEnd + (text[entry.heading.lineEnd] === "\n" ? 1 : 0),
      end: entry.end,
    }));
}

function tomlKeys(block: string): Set<string> {
  const keys = new Set<string>();
  type Mode = "out" | "basic" | "literal" | "mlbasic" | "mllit";
  let mode: Mode = "out";
  let lineStart = 0;
  let lineStartMode: Mode = "out";
  const take = (end: number) => {
    if (lineStartMode !== "out") return;
    const line = stripTomlLineComment(block.slice(lineStart, end));
    const eq = line.indexOf("=");
    if (eq > 0) keys.add(unquoteTomlKey(line.slice(0, eq)));
  };
  for (let i = 0; i < block.length; i++) {
    if (mode === "mlbasic") {
      if (block.startsWith('"""', i)) {
        mode = "out";
        i += 2;
      }
    } else if (mode === "mllit") {
      if (block.startsWith("'''", i)) {
        mode = "out";
        i += 2;
      }
    } else if (mode === "basic") {
      if (block[i] === "\\") i += 1;
      else if (block[i] === '"') mode = "out";
    } else if (mode === "literal") {
      if (block[i] === "'") mode = "out";
    } else if (block[i] === "#") {
      const nl = block.indexOf("\n", i);
      i = nl < 0 ? block.length : nl;
      if (nl < 0) break;
    } else if (block.startsWith('"""', i)) {
      mode = "mlbasic";
      i += 2;
    } else if (block.startsWith("'''", i)) {
      mode = "mllit";
      i += 2;
    } else if (block[i] === '"') {
      mode = "basic";
    } else if (block[i] === "'") {
      mode = "literal";
    }
    if (i < block.length && block[i] === "\n") {
      take(i);
      lineStart = i + 1;
      if (mode === "basic" || mode === "literal") mode = "out";
      lineStartMode = mode;
    }
  }
  take(block.length);
  return keys;
}

export function hasTomlTable(text: string, heading: string): boolean {
  const name = canonicalizeTomlHeading(heading);
  return name !== null && tomlTables(text).some((table) => table.name === name);
}

/** Insert missing keys into an existing table, never overwriting set values. */
export function patchTomlTable(text: string, heading: string, rows: string[]): string {
  const name = canonicalizeTomlHeading(heading);
  if (!name) return text;
  const table = tomlTables(text).find((entry) => entry.name === name);
  if (!table) return text;
  const keys = tomlKeys(text.slice(table.bodyStart, table.end));
  const missing = rows.filter((row) => !keys.has(tomlRowKey(row)));
  if (!missing.length) return text;
  let insertAt = table.end;
  while (insertAt > table.bodyStart && (text[insertAt - 1] === "\n" || text[insertAt - 1] === "\r")) insertAt -= 1;
  const before = text.slice(0, insertAt);
  const after = text.slice(insertAt);
  const pad = before.endsWith("\n") || before.length === 0 ? "" : "\n";
  return `${before}${pad}${missing.join("\n")}${after.startsWith("\n") ? "" : "\n"}${after}`;
}
