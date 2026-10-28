/** Bot/runtime protocol line start; server matching stays on this English prefix in stored text. */
const NEEDS_INPUT_LINE = /^(\s*)needs input:/i;

export function replaceNeedsInputLabel(text: string, localizedPrefix: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(NEEDS_INPUT_LINE, (_, indent: string) => `${indent}${localizedPrefix}`))
    .join("\n");
}
