// Not atomic: a refused step stops the run, says what was already done, and exits 1; running it again carries on.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";

import { stringify as stringifyYaml } from "yaml";

import { approvalModeFor } from "../../shared/approval-mode.ts";
import { lineDiff } from "../../shared/line-diff.ts";
import { redactSecretsInText } from "../../shared/redact.ts";
import { describeMs, EXIT, flag, HeadlessError, parseDuration, usageError } from "./args.ts";
import { explain, type HeadlessClient } from "./client.ts";
import type { VerbContext, VerbOutcome } from "./context.ts";
import { ENGINE_KINDS } from "./engine.ts";
import { everyTool, loadTeamFile, type DesiredBot } from "./team-file.ts";

export type Rec = Record<string, any>;
export const enc = encodeURIComponent;
export const key = (name: string | undefined) => (name ?? "").trim().toLowerCase();
export const APPROVAL_LABEL: Record<string, string> = { ask: "Ask", edits: "Accept edits", auto: "Auto", full: "Full access", custom: "Custom" };

export interface ApplyOptions {
  apply: boolean;
  prune: boolean;
  rotateSecrets: boolean;
  waitIdleMs: number;
  env: NodeJS.ProcessEnv;
  progress?(event: Rec): void;
}

export interface Tally {
  lines: string[];
  created: number;
  changed: number;
  unchanged: number;
  deleted: number;
  writes: number;
}

export const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item) => b.includes(item));
const canonicalScope = (scope: Rec | null | undefined) => everyTool(scope) ? "every tool"
  : JSON.stringify(Object.fromEntries(["allow", "deny"].filter((field) => Array.isArray(scope![field])).map((field) => [field, [...new Set(scope![field] as string[])].sort()])));

export const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;

export function changedLines(before: string, after: string): number {
  const diff = lineDiff(before.trimEnd(), after.trimEnd());
  return Math.max(diff.filter((line) => line.startsWith("+")).length, diff.filter((line) => line.startsWith("-")).length);
}

export function botPatch(desired: DesiredBot, echo: Rec, team: string | undefined): { patch: Rec; changes: string[] } {
  const patch: Rec = {};
  const changes: string[] = [];
  if (echo.name !== desired.name) { patch.name = desired.name; changes.push(`renamed from "${echo.name}"`); }
  if (team !== undefined && key(echo.section) !== key(team)) { patch.section = team; changes.push(`team "${echo.section ?? "none"}" → "${team}"`); }
  if (desired.title !== undefined && (echo.title ?? "") !== desired.title) { patch.title = desired.title; changes.push(`title "${echo.title ?? ""}" → "${desired.title}"`); }
  if (desired.description !== undefined && (echo.description ?? "") !== desired.description) { patch.description = desired.description; changes.push("description changed"); }
  if (desired.soul !== undefined && (echo.soul ?? "").trimEnd() !== desired.soul.trimEnd()) {
    patch.soul = desired.soul.trimEnd();
    changes.push(echo.soul ? `soul ${lines(changedLines(echo.soul ?? "", desired.soul))} changed` : `soul set (${lines(desired.soul.trimEnd().split("\n").length)})`);
  }
  if (desired.model || desired.effort) {
    const current: Rec = echo.modelSelection ?? {};
    const instanceId = desired.model?.instanceId ?? current.instanceId;
    const model = desired.model?.model ?? current.model;
    if (current.instanceId !== instanceId || current.model !== model || (desired.effort !== undefined && current.effort !== desired.effort)) {
      const effort = desired.effort ?? (instanceId === current.instanceId ? current.effort : undefined);
      patch.modelSelection = { instanceId, model, ...(effort ? { effort } : {}) };
      patch.requireAvailableModel = true;
      changes.push(`model ${current.instanceId}/${current.model}${current.effort ? ` (${current.effort})` : ""} → ${instanceId}/${model}${effort ? ` (${effort})` : ""}`);
    }
  }
  const approval = approvalModeFor(echo);
  if (desired.approval && approval !== desired.approval) {
    patch.approvalMode = desired.approval;
    patch.applyToAllThreads = true;
    changes.push(`approval ${APPROVAL_LABEL[approval]} → ${APPROVAL_LABEL[desired.approval]}`);
  }
  const computer = echo.computer ?? "auto";
  if (desired.computer && computer !== desired.computer) {
    patch.computer = desired.computer === "auto" ? null : desired.computer;
    changes.push(`computer ${computer} → ${desired.computer}`);
  }
  // The file is the confirmation the server asks for to leave a bot on Auto on this computer.
  if ((patch.computer !== undefined || patch.approvalMode !== undefined) && (desired.computer ?? computer) === "local" && (desired.approval ?? approval) === "auto") {
    patch.acknowledgeLocalAuto = true;
  }
  if (desired.cwd && echo.cwd !== desired.cwd) { patch.cwd = desired.cwd; changes.push(`folder ${echo.cwd ?? "default"} → ${desired.cwd}`); }
  if (desired.browser) {
    if ((echo.browser !== false) !== desired.browser.enabled) { patch.browser = desired.browser.enabled; changes.push(`browser ${desired.browser.enabled ? "on" : "off"}`); }
    if (desired.browser.profile !== undefined && echo.browserProfile !== desired.browser.profile) {
      patch.browserProfile = desired.browser.profile;
      changes.push(`browser profile ${echo.browserProfile ?? "its own"} → ${desired.browser.profile}`);
    }
  }
  if (desired.tools !== undefined && canonicalScope(echo.toolScope) !== canonicalScope(desired.tools)) {
    // null clears the selection on the server: every tool
    patch.toolScope = desired.tools;
    changes.push(desired.tools === null ? "tools: every tool" : "tools changed");
  }
  return { patch, changes };
}

export const describeNew = (bot: DesiredBot) => [
  bot.chief === true ? `Chief of ${bot.team ?? "General"}` : bot.team ? `team ${bot.team}` : "",
  bot.model ? `${bot.model.instanceId}/${bot.model.model}` : "",
  bot.approval ? APPROVAL_LABEL[bot.approval] : "",
  bot.computer && bot.computer !== "auto" ? `computer ${bot.computer}` : "",
].filter(Boolean).join(" · ");

import { reconcile } from "./team-reconcile.ts";
export { reconcile };
export async function waitIdle(client: HeadlessClient, bot: Rec, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const now = ((await client.json<Rec>("/api/bots?messages=0")).bots ?? []).find((candidate: Rec) => candidate.id === bot.id);
    if (!now?.busy) return;
  }
  throw new HeadlessError(`"${bot.name}" is still working after ${describeMs(waitMs)}, so it was not changed`, EXIT.failed,
    "apply again once it is idle, or wait longer with --wait-idle 10m");
}

const summary = (tally: Tally) => `${tally.created} to create, ${tally.changed} to change, ${tally.unchanged} unchanged, ${tally.deleted} to delete`;

export async function teamApplyVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const path = ctx.positionals[0];
  if (!path) throw usageError("name the team file: openmausbot team apply FILE");
  const check = ctx.flags.check === true;
  const dryRun = ctx.flags["dry-run"] === true;
  if (check && dryRun) throw usageError("choose one of --dry-run and --check");
  const file = loadTeamFile(path);
  const options = {
    prune: ctx.flags.prune === true, rotateSecrets: ctx.flags["rotate-secrets"] === true, env: ctx.env, progress: (event: Rec) => ctx.output.progress(event),
    waitIdleMs: flag(ctx.flags, "wait-idle") ? parseDuration(flag(ctx.flags, "wait-idle")!, "--wait-idle", { min: 0 }) : 120_000,
  };
  for (const warning of file.warnings) ctx.output.progress({ event: "warning", warning });
  const client = await ctx.client();
  const plan = await reconcile(client, file, { ...options, apply: false });
  const changes = plan.created + plan.changed + plan.deleted;
  const planText = [...plan.lines, changes ? `Plan: ${summary(plan)}.` : "No changes."];
  if (!changes || dryRun || check) {
    return {
      result: { ok: !check || !changes, file: file.path, plan: plan.lines, ...countsOf(plan), applied: false, writes: 0, warnings: file.warnings },
      exitCode: check && changes ? EXIT.changes : EXIT.done, human: planText,
    };
  }
  let applied: Tally | undefined;
  try {
    applied = await reconcile(client, file, { ...options, apply: true });
  } catch (error) {
    const reported = await explain(error, client.baseUrl);
    throw new HeadlessError(`${reported.message} (stopped part way: apply the file again to carry on)`, reported.exitCode, reported.hint);
  }
  return {
    result: { ok: true, file: file.path, plan: plan.lines, ...countsOf(plan), applied: true, writes: applied.writes, warnings: file.warnings },
    exitCode: EXIT.done,
    human: [...planText, `Applied: ${applied.created} created, ${applied.changed} changed, ${applied.deleted} deleted.`],
  };
}

const countsOf = (tally: Tally) => ({ created: tally.created, changed: tally.changed, unchanged: tally.unchanged, deleted: tally.deleted });

export const skillFilePath = (botDir: string, skillName: string): string => posix.join("skills", botDir, skillName, "SKILL.md");

export function botSkillDirs(botNames: string[]): string[] {
  const taken = new Set<string>();
  return botNames.map((name) => {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bot";
    let dir = base;
    for (let n = 2; taken.has(dir); n += 1) dir = `${base}-${n}`;
    taken.add(dir);
    return dir;
  });
}

/** Keys never leave the server. */
export async function teamExportVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const out = flag(ctx.flags, "out")?.trim();
  if (!out) throw usageError("--out FILE is required (the team file to write)");
  const wanted = ((ctx.flags.team as string[] | undefined) ?? []).map(key);
  const client = await ctx.client();
  const fleet = await client.json<Rec>("/api/bots?messages=0");
  const sections: string[] = (await client.json<Rec>("/api/sidebar-sections")).sections ?? [];
  for (const name of wanted) if (!sections.some((section) => key(section) === name)) throw usageError(`no team named "${name}"`);
  const inScope = (section: string | undefined) => !wanted.length || wanted.includes(key(section));
  const bots: Rec[] = (fleet.bots ?? []).filter((bot: Rec) => !bot.hidden && inScope(bot.section));
  const names = new Set<string>();
  for (const bot of bots) {
    if (names.has(key(bot.name))) throw new HeadlessError(`two bots are named "${bot.name}"; rename one before exporting`, EXIT.failed);
    names.add(key(bot.name));
  }
  const dir = dirname(resolve(out));
  // A team file travels: a key written into a soul, a brief or a skill is taken out.
  const redacted: string[] = [];
  const clean = (text: string, where: string): string => {
    const cleaned = redactSecretsInText(text);
    if (cleaned !== text) redacted.push(where);
    return cleaned;
  };
  const teams = sections.filter((section) => inScope(section) && (wanted.length || bots.some((bot) => key(bot.section) === key(section))));
  const teamEntries = await Promise.all(teams.map(async (name) => {
    const brief = String((await client.json<Rec>(`/api/section-context?section=${enc(name)}`)).text ?? "");
    return { name, ...(brief.trim() ? { brief: clean(brief, `team "${name}" brief`) } : {}) };
  }));
  const skipped: string[] = [];
  let skills = 0;
  const botEntries = [];
  const skillDirs = botSkillDirs(bots.map((bot) => bot.name));
  for (const [index, bot] of bots.entries()) {
    const entry: Rec = { name: bot.name, ...(bot.section ? { team: bot.section } : {}), ...(bot.title ? { title: bot.title } : {}),
      ...(bot.description ? { description: clean(bot.description, `bot "${bot.name}" description`) } : {}) };
    if (bot.chiefOfStaff) Object.assign(entry, { chief: true, ...(bot.managedSections?.length ? { manages: bot.managedSections } : {}) });
    if (bot.soul?.trim()) entry.soul = clean(bot.soul, `bot "${bot.name}" soul`);
    if (bot.modelSelection?.instanceId) {
      entry.model = `${bot.modelSelection.instanceId}/${bot.modelSelection.model}`;
      if (bot.modelSelection.effort) entry.effort = bot.modelSelection.effort;
    }
    const approval = approvalModeFor(bot);
    if (approval === "custom") skipped.push(`${bot.name}: its Custom approval level is set in the desktop app, not in a team file`);
    else entry.approval = approval;
    if (bot.computer) entry.computer = bot.computer;
    if (bot.cwd) entry.cwd = bot.cwd;
    if (bot.browser === false || bot.browserProfile) entry.browser = { enabled: bot.browser !== false, ...(bot.browserProfile ? { profile: bot.browserProfile } : {}) };
    if (!everyTool(bot.toolScope)) entry.tools = bot.toolScope;
    const listing: Rec[] = (await client.json<Rec>(`/api/bots/${enc(bot.id)}/skills`)).skills ?? [];
    if (listing.length) entry.skills = [];
    for (const skill of listing) {
      const text = clean(String((await client.json<Rec>(`/api/bots/${enc(bot.id)}/skills/${enc(skill.name)}`)).text ?? ""), `bot "${bot.name}" skill ${skill.name}`);
      const relativePath = skillFilePath(skillDirs[index]!, skill.name);
      mkdirSync(dirname(join(dir, relativePath)), { recursive: true });
      writeFileSync(join(dir, relativePath), text);
      entry.skills.push({ file: relativePath, ...(skill.enabled ? {} : { enabled: false }) });
      skills += 1;
    }
    botEntries.push(entry);
  }
  const byId = new Map((fleet.bots ?? []).map((bot: Rec) => [bot.id, bot.name]));
  const roomEntries = (fleet.groups ?? []).filter((group: Rec) => !group.dm && inScope(group.section)).map((group: Rec) => {
    const responder: Rec = group.defaultResponder ?? {};
    return {
      name: group.name, ...(group.section ? { team: group.section } : {}), members: (group.memberIds ?? []).map((id: string) => byId.get(id) ?? id),
      ...(String(group.bulletin ?? "").trim() ? { brief: clean(String(group.bulletin), `room "${group.name}" brief`) } : {}),
      ...(responder.kind === "everyone" || responder.kind === "mentions" ? { responder: responder.kind }
        : responder.kind === "member" && byId.has(responder.botId) ? { responder: byId.get(responder.botId) } : {}),
    };
  });
  const config = await client.json<Rec>("/api/config");
  const engines: Rec = {};
  for (const [kind, spec] of Object.entries(ENGINE_KINDS)) {
    if (config[spec.config]?.configured !== true) continue;
    const name = kind === "openai-compatible" ? "openaiCompatible" : kind;
    engines[name] = { key: { env: "SET_ME" }, ...(kind === "openai-compatible" && config.openaiCompat?.url ? { baseUrl: config.openaiCompat.url } : {}),
      ...(kind === "claude" && config.anthropic?.everyClaudeBot === false ? { everyClaudeBot: false } : {}) };
  }
  const document = { version: 1, ...(Object.keys(engines).length ? { engines } : {}), ...(teamEntries.length ? { teams: teamEntries } : {}),
    bots: botEntries, ...(roomEntries.length ? { rooms: roomEntries } : {}) };
  if (!botEntries.length) throw new HeadlessError("no bots to export", EXIT.failed);
  writeFileSync(resolve(out), `# Written by openmausbot team export on ${new Date().toISOString().slice(0, 10)}.\n# Engine keys are placeholders (SET_ME): set them before applying this elsewhere.\n${stringifyYaml(document, { lineWidth: 0 })}`);
  return {
    result: { ok: true, file: resolve(out), teams: teamEntries.length, bots: botEntries.length, rooms: roomEntries.length, skills, engines: Object.keys(engines), skipped, redacted },
    exitCode: EXIT.done,
    human: [`Wrote ${out}: ${teamEntries.length} teams, ${botEntries.length} bots, ${roomEntries.length} rooms, ${skills} skills.`,
      ...(Object.keys(engines).length ? ["Engine keys are placeholders (SET_ME): set them before applying it elsewhere."] : []),
      ...(redacted.length ? [`A secret was taken out of: ${redacted.join(", ")} (apply leaves those as they are).`] : []),
      ...skipped.map((line) => `not exported: ${line}`)],
  };
}
