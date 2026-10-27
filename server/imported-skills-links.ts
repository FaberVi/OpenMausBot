import { randomUUID } from "node:crypto";
import {
  lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { isSkillName } from "../shared/skill-md.ts";
import { DATA_DIR } from "./config.ts";
import { directoryEntryState, entryExistsWithoutFollowing } from "./skill-storage.ts";

const IMPORTED_SKILLS_DIR = join(DATA_DIR, "imported-skills");

export type ImportedSkillLinkTarget = { name: string; folder: string };

const NATIVE_SKILL_DIRS = [".claude/skills", ".agents/skills", ".grok/skills"];

const comparable = (path: string) => {
  const resolved = resolve(path).replace(/^\\\\\?\\/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

function linkDirectory(root: string, relative: string, create: boolean): string | null {
  let at = root;
  for (const part of relative.split("/")) {
    at = join(at, part);
    if (create && directoryEntryState(at) === "missing") {
      try {
        mkdirSync(at, { mode: 0o700 });
      } catch {
        return null;
      }
    }
    if (directoryEntryState(at) !== "directory") return null;
  }
  return at;
}

function linksToImported(link: string, name: string, base = dirname(link)): boolean {
  try {
    if (!lstatSync(link).isSymbolicLink()) return false;
    return comparable(resolve(base, readlinkSync(link).replace(/^\\\\\?\\/, ""))) === comparable(join(IMPORTED_SKILLS_DIR, name));
  } catch {
    return false;
  }
}

function removeLink(botId: string, link: string, name: string): void {
  const aside = join(DATA_DIR, "skill-state", botId, "link-removal");
  try {
    mkdirSync(aside, { recursive: true, mode: 0o700 });
  } catch {
    return;
  }
  const moved = join(aside, randomUUID());
  try {
    renameSync(link, moved);
  } catch {
    return;
  }
  if (linksToImported(moved, name, dirname(link))) {
    try {
      unlinkSync(moved);
      return;
    } catch {}
  }
  try {
    if (!entryExistsWithoutFollowing(link)) renameSync(moved, link);
  } catch {}
}

export function syncImportedSkillLinks(botId: string, folder: string, skills: readonly ImportedSkillLinkTarget[]): void {
  for (const relative of NATIVE_SKILL_DIRS) {
    const dir = linkDirectory(folder, relative, skills.length > 0);
    if (!dir) continue;
    const wanted = new Map(skills.map((skill) => [skill.name, skill.folder]));
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter(isSkillName);
    } catch {}
    for (const name of names) {
      const link = join(dir, name);
      if (!linksToImported(link, name)) continue;
      if (wanted.has(name)) wanted.delete(name);
      else removeLink(botId, link, name);
    }
    for (const [name, target] of wanted) {
      const link = join(dir, name);
      if (entryExistsWithoutFollowing(link)) continue;
      try {
        symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
      } catch {}
    }
  }
}
