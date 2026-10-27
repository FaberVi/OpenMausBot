import { createHash } from "node:crypto";
import { basename } from "node:path";

import { assertToolScopeSupported } from "../../shared/tool-scope-support.ts";
import { mask } from "../../shared/redact.ts";
import { EXIT, HeadlessError } from "./args.ts";
import type { HeadlessClient } from "./client.ts";
import { applyEngine, ENGINE_KINDS, readSecret } from "./engine.ts";
import type { DesiredBot, TeamFile } from "./team-file.ts";
import {
  botPatch,
  changedLines,
  describeNew,
  enc,
  key,
  lines,
  sameSet,
  waitIdle,
  type ApplyOptions,
  type Rec,
  type Tally,
} from "./team-apply.ts";

export async function reconcile(client: HeadlessClient, file: TeamFile, options: ApplyOptions): Promise<Tally> {
  const tally: Tally = { lines: [], created: 0, changed: 0, unchanged: 0, deleted: 0, writes: 0 };
  const note = (line: string, kind: "created" | "changed" | "unchanged" | "deleted" | "kept") => {
    if (kind !== "unchanged") tally.lines.push(line);
    if (kind !== "kept") tally[kind] += 1;
  };
  const write = async (path: string, init: RequestInit): Promise<any> => { tally.writes += 1; return client.json(path, init); };
  const tool = async (name: string, args: Rec): Promise<any> => { tally.writes += 1; return client.tool(name, args); };
  const fleet = async () => client.json<Rec>("/api/bots?messages=0");
  const findBot = (bots: Rec[], name: string, team?: string) => {
    const inTeam = (bot: Rec) => Number(team !== undefined && key(bot.section) === key(team));
    return bots.filter((bot) => key(bot.name) === key(name)).sort((a, b) => inTeam(b) - inTeam(a) || Number(Boolean(a.hidden)) - Number(Boolean(b.hidden)))[0];
  };

  if (file.engines.length) {
    const config = await client.json<Rec>("/api/config");
    const instances: Rec[] = (await client.json<Rec>("/api/instances")).instances ?? [];
    for (const engine of file.engines) {
      const spec = ENGINE_KINDS[engine.kind]!;
      const status: Rec = config[spec.config] ?? {};
      const onlyClaudeApi = engine.kind === "claude" && engine.everyClaudeBot === false;
      const needsKey = status.configured !== true || options.rotateSecrets;
      const instanceId = onlyClaudeApi ? spec.apiInstance! : spec.instance;
      const install = engine.install === true && instances.find((instance) => instance.instanceId === instanceId)?.snapshot?.state !== "available";
      const keyValue = needsKey ? readSecret(engine.key, options.env, `engine ${engine.kind} key`) : "";
      // A secret base URL is read only when it is written or compared, and never shown.
      const secretUrl = engine.baseUrl !== undefined && typeof engine.baseUrl !== "string";
      const baseUrl = engine.baseUrl === undefined ? undefined : typeof engine.baseUrl === "string" ? engine.baseUrl
        : needsKey || typeof status.url === "string" ? readSecret(engine.baseUrl, options.env, `engine ${engine.kind} base URL`) : undefined;
      const request = { kind: engine.kind, key: keyValue, ...(baseUrl ? { baseUrl } : {}), onlyClaudeApi, rotate: options.rotateSecrets, install, dryRun: !options.apply,
        ...(options.progress ? { progress: options.progress } : {}) };
      const result = await applyEngine(client, request);
      if (options.apply && (result.changed.length || install)) tally.writes += (result.changed.length ? 1 : 0) + (install ? 1 : 0);
      if (!needsKey && engine.baseUrl !== undefined && typeof status.url !== "string") {
        note(`engine ${engine.kind}: its key is already set and the server does not show its base URL, so the file's was not compared (--rotate-secrets writes both)`, "kept");
      }
      if (!result.changed.length && !install) { note(`engine ${engine.kind}: already set`, "unchanged"); continue; }
      note(`engine ${engine.kind}: ${[...result.changed.map((field: string) => field === "key" ? `key ${mask(keyValue)}` : field === "everyClaudeBot" ? (onlyClaudeApi ? "only Claude (API key) bots use the key" : "every Claude bot uses the key") : secretUrl ? "base URL set" : `base URL ${baseUrl}`),
        ...(install ? ["install"] : [])].join(" · ")}`, status.configured === true ? "changed" : "created");
    }
  }

  const sections: string[] = [...((await client.json<Rec>("/api/sidebar-sections")).sections ?? [])];
  const sectionNamed = (name: string) => sections.find((section) => key(section) === key(name));
  const teamNames: string[] = [];
  for (const name of [...file.teams.map((team) => team.name), ...file.bots.flatMap((bot) => [bot.team, ...bot.manages]), ...file.rooms.map((room) => room.team)]) {
    if (name && !teamNames.some((known) => key(known) === key(name))) teamNames.push(name);
  }
  for (const name of teamNames) {
    const existing = sectionNamed(name);
    const brief = file.teams.find((team) => key(team.name) === key(name))?.brief;
    const parts: string[] = [];
    if (!existing) {
      parts.push("create");
      if (options.apply) await write("/api/sidebar-sections", { method: "POST", body: JSON.stringify({ name, botIds: [] }) });
      sections.push(name);
    }
    if (brief !== undefined) {
      const current = existing ? String((await client.json<Rec>(`/api/section-context?section=${enc(existing)}`)).text ?? "") : "";
      if (current.trimEnd() !== brief.trimEnd()) {
        parts.push(current.trim() ? `brief ${lines(changedLines(current, brief))} changed` : `brief set (${lines(brief.trimEnd().split("\n").length)})`);
        if (options.apply) await write(`/api/section-context?section=${enc(existing ?? name)}`, { method: "PUT", body: JSON.stringify({ text: brief.trimEnd() }) });
      }
    }
    note(`team "${name}": ${parts.join(" · ")}`, !parts.length ? "unchanged" : existing ? "changed" : "created");
  }
  const teamOf = (bot: DesiredBot) => bot.team ? sectionNamed(bot.team) ?? bot.team : undefined;

  const instances: Rec[] = (await client.json<Rec>("/api/instances")).instances ?? [];
  for (const desired of file.bots.filter((bot) => bot.model)) {
    const { instanceId, model } = desired.model!;
    const instance = instances.find((candidate) => candidate.instanceId === instanceId);
    if (!instance) throw new HeadlessError(`bot "${desired.name}": no engine "${instanceId}" here`, EXIT.failed, "openmausbot models lists the engines and their models");
    const offered = [instance.models?.default, ...(instance.models?.options ?? []).map((option: Rec) => option.id)];
    if (instance.snapshot?.state === "available" && !offered.includes(model)) {
      throw new HeadlessError(`bot "${desired.name}": ${instanceId} offers no model "${model}"`, EXIT.failed, "openmausbot models lists them");
    }
  }
  let current = await fleet();
  const existingFor = (desired: DesiredBot): Rec | undefined =>
    (desired.was ? findBot(current.bots ?? [], desired.was, teamOf(desired)) : undefined) ?? findBot(current.bots ?? [], desired.name, teamOf(desired));
  for (const desired of file.bots.filter((bot) => bot.was)) {
    const old = findBot(current.bots ?? [], desired.was!, teamOf(desired));
    const taken = findBot(current.bots ?? [], desired.name, teamOf(desired));
    if (old && taken && old.id !== taken.id) {
      throw new HeadlessError(`bot "${desired.name}": both "${old.name}" (its was:) and "${taken.name}" exist, so the rename would make two bots of one name`, EXIT.failed,
        "delete or rename one of them, or take was: out of the file");
    }
  }
  let workspaceDefault: string | undefined;
  for (const desired of file.bots) {
    if (!desired.tools) continue;
    const existing = existingFor(desired);
    if (!desired.model && !existing) workspaceDefault ??= (await client.json<Rec>("/api/bot-defaults")).modelSelection?.instanceId;
    const instanceId = desired.model?.instanceId ?? existing?.modelSelection?.instanceId ?? workspaceDefault;
    const driverKind = instances.find((instance) => instance.instanceId === instanceId)?.driverKind;
    if (typeof driverKind !== "string") continue;
    try {
      assertToolScopeSupported(driverKind, desired.tools);
    } catch (error) {
      throw new HeadlessError(`bot "${desired.name}": ${error instanceof Error ? error.message : String(error)}`, EXIT.failed,
        "this engine limits only MCP tools (mcp:SERVER:TOOL): leave native tools out of its selection, or give the bot an engine that can limit them (docs/tool-selection.md)");
    }
  }
  const created = new Set<string>();
  for (const desired of file.bots) {
    const existing = existingFor(desired);
    if (!existing) {
      note(`bot "${desired.name}": create${describeNew(desired) ? ` (${describeNew(desired)})` : ""}`, "created");
      created.add(key(desired.name));
      if (!options.apply) continue;
      const made = await write("/api/bots", { method: "POST", body: JSON.stringify({
        useDefaults: false, name: desired.name, ...(desired.title !== undefined ? { title: desired.title } : {}),
        ...(desired.description !== undefined ? { description: desired.description } : {}), ...(teamOf(desired) ? { section: teamOf(desired) } : {}),
        ...(desired.model ? { modelSelection: { ...desired.model, ...(desired.effort ? { effort: desired.effort } : {}) }, requireAvailableModel: true } : {}),
      }) });
      const { patch } = botPatch(desired, made.bot, teamOf(desired));
      if (Object.keys(patch).length) await write(`/api/bots/${enc(made.bot.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      continue;
    }
    const { patch, changes } = botPatch(desired, existing, teamOf(desired));
    if (!changes.length) { note("", "unchanged"); continue; }
    note(`bot "${desired.name}": update ${changes.join("; ")}`, "changed");
    if (!options.apply) continue;
    if (existing.busy) await waitIdle(client, existing, options.waitIdleMs);
    await write(`/api/bots/${enc(existing.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
  }
  if (options.apply) current = await fleet();
  const named = (name: string) => file.bots.find((bot) => key(bot.name) === key(name));
  const botId = (name: string) => {
    const desired = named(name);
    const team = desired ? teamOf(desired) : undefined;
    return (findBot(current.bots ?? [], name, team) ?? (desired?.was ? findBot(current.bots ?? [], desired.was, team) : undefined))?.id as string | undefined;
  };

  for (const desired of file.bots.filter((bot) => bot.skills.length)) {
    const id = botId(desired.name);
    const listing: Rec[] = id ? (await client.json<Rec>(`/api/bots/${enc(id)}/skills`)).skills ?? [] : [];
    for (const skill of desired.skills) {
      const installed = listing.find((entry) => entry.name === skill.name);
      const sha = createHash("sha256").update(skill.text).digest("hex");
      const same = installed && (installed.sha256 === sha || (await client.json<Rec>(`/api/bots/${enc(id!)}/skills/${enc(skill.name)}`)).text === skill.text);
      const template = { name: skill.name, description: skill.description, warnings: [], source: `team file ${basename(file.path)}: ${skill.file}`, text: skill.text, enabled: skill.enabled };
      if (!installed) {
        if (!created.has(key(desired.name))) note(`skill "${skill.name}" for "${desired.name}": add`, "created");
        if (options.apply) await write(`/api/bots/${enc(id!)}/skill-template`, { method: "POST", body: JSON.stringify(template) });
      } else if (!same) {
        note(`skill "${skill.name}" for "${desired.name}": replace with ${skill.file}`, "changed");
        if (options.apply) {
          await write(`/api/bots/${enc(id!)}/skills/${enc(skill.name)}`, { method: "DELETE" });
          await write(`/api/bots/${enc(id!)}/skill-template`, { method: "POST", body: JSON.stringify(template) });
        }
      } else if (installed.enabled !== skill.enabled) {
        note(`skill "${skill.name}" for "${desired.name}": ${skill.enabled ? "turn on" : "turn off"}`, "changed");
        if (options.apply) await write(`/api/bots/${enc(id!)}/skills/${enc(skill.name)}`, { method: "PATCH", body: JSON.stringify({ enabled: skill.enabled }) });
      } else note("", "unchanged");
    }
  }

  for (const desired of file.bots.filter((bot) => bot.chief !== undefined)) {
    const bot = (current.bots ?? []).find((candidate: Rec) => candidate.id === botId(desired.name));
    const managed = desired.manages.map((name) => sectionNamed(name) ?? name);
    if (desired.chief === false) {
      if (!bot?.chiefOfStaff) continue;
      note(`bot "${desired.name}": no longer Chief of Staff`, "changed");
      if (options.apply) await write(`/api/bots/${enc(bot.id)}`, { method: "PATCH", body: JSON.stringify({ chiefOfStaff: false }) });
      continue;
    }
    if (bot?.chiefOfStaff === true && sameSet(bot.managedSections ?? [], managed)) continue;
    if (!created.has(key(desired.name))) note(`bot "${desired.name}": Chief of Staff of ${desired.team ?? "General"}${managed.length ? `, also in charge of ${managed.join(", ")}` : ""}`, "changed");
    if (options.apply) await write(`/api/bots/${enc(bot!.id)}`, { method: "PATCH", body: JSON.stringify({ chiefOfStaff: true, managedSections: managed, acknowledgePeerScope: true }) });
  }

  const rooms: Rec[] = (current.groups ?? []).filter((group: Rec) => !group.dm);
  for (const room of file.rooms) {
    const memberIds = room.members.map((name) => botId(name) ?? (!options.apply && created.has(key(name)) ? `new:${name}` : undefined));
    const missing = room.members.filter((_name, index) => !memberIds[index]);
    if (missing.length) throw new HeadlessError(`room "${room.name}": no bot named ${missing.map((name) => `"${name}"`).join(", ")}`, EXIT.failed);
    const ids = memberIds as string[];
    const responder = room.responder === undefined ? undefined : room.responder === "everyone" || room.responder === "mentions" ? { kind: room.responder }
      : { kind: "member", bot_id: ids[room.members.findIndex((member) => key(member) === key(room.responder))]! };
    const team = room.team ? sectionNamed(room.team) ?? room.team : undefined;
    const existing = rooms.find((group) => key(group.name) === key(room.name));
    if (!existing) {
      note(`room "${room.name}": create (${room.members.length} member${room.members.length === 1 ? "" : "s"}${team ? `, team ${team}` : ""})`, "created");
      if (options.apply) await tool("create_channel", { name: room.name, member_ids: ids, ...(team ? { section: team } : {}),
        ...(room.brief !== undefined ? { bulletin: room.brief.trimEnd() } : {}), ...(responder ? { default_responder: responder } : {}) });
      continue;
    }
    const change: Rec = {};
    const words: string[] = [];
    if (!sameSet(existing.memberIds ?? [], ids)) { change.member_ids = ids; words.push(`members → ${room.members.join(", ")}`); }
    if (team !== undefined && key(existing.section) !== key(team)) { change.section = team; words.push(`team → ${team}`); }
    if (room.brief !== undefined && String(existing.bulletin ?? "").trimEnd() !== room.brief.trimEnd()) { change.bulletin = room.brief.trimEnd(); words.push("brief changed"); }
    const echo: Rec = existing.defaultResponder ?? {};
    if (responder && (echo.kind !== responder.kind || (responder.kind === "member" && echo.botId !== (responder as Rec).bot_id))) {
      change.default_responder = responder;
      words.push(`answered by ${room.responder}`);
    }
    if (!words.length) { note("", "unchanged"); continue; }
    note(`room "${room.name}": update ${words.join("; ")}`, "changed");
    if (options.apply) await tool("update_channel", { channel_id: existing.id, ...change });
  }

  for (const team of file.teams) {
    const section = sectionNamed(team.name);
    if (!section) continue;
    const listed = new Set(file.bots.flatMap((bot) => [key(bot.name), ...(bot.was ? [key(bot.was)] : [])]));
    for (const bot of (current.bots ?? []).filter((candidate: Rec) => !candidate.hidden && key(candidate.section) === key(section) && !listed.has(key(candidate.name)))) {
      if (!options.prune || !team.prune) { note(`bot "${bot.name}": not in file (kept${team.prune ? "; --prune deletes it" : ""})`, "kept"); continue; }
      note(`bot "${bot.name}": delete (not in file)`, "deleted");
      if (options.apply) await write(`/api/bots/${enc(bot.id)}`, { method: "DELETE" });
    }
    const roomNames = new Set(file.rooms.map((room) => key(room.name)));
    for (const group of rooms.filter((candidate) => key(candidate.section) === key(section) && !roomNames.has(key(candidate.name)))) {
      if (!options.prune || !team.prune) { note(`room "${group.name}": not in file (kept${team.prune ? "; --prune deletes it" : ""})`, "kept"); continue; }
      note(`room "${group.name}": delete (not in file)`, "deleted");
      if (options.apply) await write(`/api/groups/${enc(group.id)}`, { method: "DELETE" });
    }
  }
  return tally;
}

