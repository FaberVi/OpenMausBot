import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import type { ModelCatalog } from "../../contracts.ts";
import { harnessHome, splitCliString } from "../../env-path.ts";
import type { DeviceSignIn } from "../device-auth.ts";
import { decodeInjectId, hostApiKey, localHost } from "../local-inject.ts";
import { allowsTool, parseToolScope } from "../../../shared/tool-scope.ts";
import { STATIC_GROK_MODELS } from "./grok.ts";

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

/** `$GROK_HOME`, else `~/.grok`: Grok's sign-in, config and catalog. */
export function grokHome(env: Record<string, string | undefined> = process.env): string {
  return env.GROK_HOME || harnessHome("grok", env);
}

export function grokSignedIn(env: Record<string, string | undefined>): boolean {
  return existsSync(join(grokHome(env), "auth.json"));
}

function grokLoginFailure(output: string): string {
  if (/(unexpected argument|unrecognized (argument|option)|unknown option).*device-(auth|code)/i.test(output)) {
    return "This server's Grok is too old to sign in with a code. Update Grok on the server, then try again.";
  }
  if (/device-code login is not available/i.test(output)) {
    return "This Grok account can't sign in with a code. Use an xAI API key instead.";
  }
  if (/expired/i.test(output)) return "The Grok sign-in code expired. Start sign-in again for a new code.";
  if (/denied|rejected/i.test(output)) return "Grok sign-in was declined in the browser. Start sign-in again to try once more.";
  return "Grok sign-in did not finish. Check the server's connection, then try again.";
}

/** `grok login --device-auth` on the grok.com subscription (grok 1.0.25 and 1.0.41). Grok has no
 * status command, so nothing is checked first. */
export const GROK_DEVICE_SIGN_IN: DeviceSignIn = {
  provider: "grok",
  product: "Grok",
  account: "Grok",
  homeEnv: "GROK_HOME",
  homeDir: ".grok",
  loginArgs: ["login", "--device-auth"],
  install: "Install it with xAI's installer (https://x.ai/cli), then try again.",
  failure: grokLoginFailure,
  signedIn: grokSignedIn,
};

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

/** Local slugs from ~/.grok/config.toml, which `grok -m <slug>` accepts, plus the cloud defaults. */
export function readGrokModelCatalog(env: Record<string, string | undefined> = process.env): ModelCatalog {
  const path = join(grokHome(env), "config.toml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return STATIC_GROK_MODELS;
  }

  const options = STATIC_GROK_MODELS.options.map((o) => ({ ...o }));
  const seen = new Set(options.map((o) => o.id));
  let configuredDefault: string | null = null;
  let current: { slug: string; name?: string } | null = null;
  let inModels = false;

  const flush = () => {
    if (!current || !SLUG.test(current.slug) || seen.has(current.slug)) {
      current = null;
      return;
    }
    seen.add(current.slug);
    options.push({ id: current.slug, label: current.name || current.slug, custom: true });
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped === "[models]") {
      flush();
      inModels = true;
      continue;
    }
    if (stripped.startsWith("[model.") && stripped.endsWith("]")) {
      flush();
      inModels = false;
      let inner = stripped.slice("[model.".length, -1);
      if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
      current = { slug: inner };
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      inModels = false;
      continue;
    }
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (current && key === "name" && value) current.name = value;
    if (!current && inModels && key === "default") configuredDefault = value;
  }
  flush();

  return {
    default: configuredDefault && seen.has(configuredDefault) ? configuredDefault : STATIC_GROK_MODELS.default,
    options,
  };
}

function suggestGrokSlug(host: string, model: string, taken: Set<string>): string {
  let base = `${host}-${model}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!base || !/^[a-z]/.test(base)) base = `m-${base || "model"}`;
  let slug = base;
  let n = 2;
  while (taken.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function quoteToml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Write a [model.slug] block so `grok -m` can reach the injected host. */
export function ensureGrokInjectSlug(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const path = join(grokHome(env), "config.toml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }

  const taken = new Set<string>(STATIC_GROK_MODELS.options.map((option) => option.id));
  let current: { slug: string; model?: string; baseUrl?: string } | null = null;
  const flush = () => {
    if (!current) return;
    taken.add(current.slug);
    if (current.model === inject.model && current.baseUrl === host.baseUrl) {
      found = current.slug;
    }
    current = null;
  };
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith("[model.") && stripped.endsWith("]")) {
      flush();
      let inner = stripped.slice("[model.".length, -1);
      if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
      current = { slug: inner };
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      continue;
    }
    if (!current || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (key === "model") current.model = value;
    if (key === "base_url") current.baseUrl = value;
  }
  flush();
  if (found) return found;

  const slug = suggestGrokSlug(inject.host, inject.model, taken);
  const heading = /[^a-z0-9_-]/i.test(slug) ? `[model."${slug}"]` : `[model.${slug}]`;
  const block = [
    heading,
    `model = ${quoteToml(inject.model)}`,
    `base_url = ${quoteToml(host.baseUrl)}`,
    `name = ${quoteToml(`${inject.model} (${host.label})`)}`,
    `api_backend = "chat_completions"`,
    `api_key = ${quoteToml(hostApiKey(host, env))}`,
    "",
  ].join("\n");
  const next = text && !text.endsWith("\n") ? `${text}\n\n${block}` : `${text}${text ? "\n" : ""}${block}`;
  writeFileSync(path, next);
  return slug;
}

/** Grok 1.0.25 consumes native image blocks but advertises image:false; other versions negotiate. */
export function grokAcceptsUnadvertisedImages(init: unknown): boolean {
  const meta = (init as { _meta?: { grokShell?: unknown; agentVersion?: unknown } } | null)?._meta;
  if (meta?.grokShell !== true || typeof meta.agentVersion !== "string") return false;
  const version = /^1\.0\.(\d+)$/.exec(meta.agentVersion);
  return Boolean(version && Number(version[1]) >= 25);
}

interface GrokToolConfig { id: string; name_override?: string; [key: string]: unknown }
interface GrokScopeProfile {
  name: string;
  description: string;
  toolConfig: { tools: GrokToolConfig[]; [key: string]: unknown };
  injectDefaultTools?: boolean;
  tools?: string[];
  disallowedTools?: string[];
  [key: string]: unknown;
}

// Original names in the official 1.0.41 default registry, never owner strings.
const GROK_NATIVE_TOOLS = [
  ["read_file", "GrokBuild:read_file"], ["search_replace", "GrokBuild:search_replace"], ["write", "OpenCode:write"],
  ["run_terminal_command", "GrokBuild:run_terminal_cmd"], ["list_dir", "GrokBuild:list_dir"], ["grep", "GrokBuild:grep"],
  ["kill_command_or_subagent", "GrokBuild:kill_task"], ["todo_write", "GrokBuild:todo_write"],
  ["get_command_or_subagent_output", "GrokBuild:get_task_output"], ["spawn_subagent", "GrokBuild:task"],
  ["scheduler_create", "GrokBuild:scheduler_create"], ["scheduler_delete", "GrokBuild:scheduler_delete"], ["scheduler_list", "GrokBuild:scheduler_list"],
  ["monitor", "GrokBuild:monitor"], ["search_tool", "GrokBuild:search_tool"], ["use_tool", "GrokBuild:use_tool"],
  ["workflow", "GrokBuild:workflow"], ["enter_plan_mode", "GrokBuild:enter_plan_mode"], ["exit_plan_mode", "GrokBuild:exit_plan_mode"],
  ["ask_user_question", "GrokBuild:ask_user_question"], ["send_feedback", "GrokBuild:send_feedback"],
  ["image_gen", "GrokBuild:image_gen"], ["image_edit", "GrokBuild:image_edit"],
  ["image_to_video", "GrokBuild:image_to_video"], ["reference_to_video", "GrokBuild:reference_to_video"],
] as const;

export function grokInheritedProfile(cli: string, env: Record<string, string | undefined>, cwd: string): GrokScopeProfile | undefined {
  const unsupported = () => { throw new Error("Grok's existing agent profile cannot be safely intersected with tool selection. Use a profile file with explicit tools or a separate default Grok account."); };
  if ((env.GROK_AGENT && env.GROK_AGENT !== "grok-build") || env.GROK_CONFIG || env.GROK_CONFIG_PATH) return unsupported();
  const args = splitCliString(cli);
  // The CLI applies operator filters after ACP's profile, so unverified overrides refuse.
  if (args.some(arg => /^(--tools|--disallowed-tools|--disallowedTools|--agent)(=|$)/.test(arg))) return unsupported();
  const flags = args.flatMap((arg, index) => arg === "--agent-profile" || arg.startsWith("--agent-profile=") ? [index] : []);
  if (flags.length > 1) return unsupported();
  const flag = flags[0] ?? -1;
  let path = flag >= 0 ? (args[flag]!.includes("=") ? args[flag]!.slice(args[flag]!.indexOf("=") + 1) : args[flag + 1]) : undefined;
  if (flag >= 0 && (!path || path.startsWith("-"))) return unsupported();
  const files = [join(grokHome(env), "config.toml")];
  for (let directory = resolve(cwd);;) {
    const file = join(directory, ".grok", "config.toml"); if (!files.includes(file)) files.push(file);
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8"); if (text.length > 262_144) return unsupported();
    // A small TOML subset over the whole file; unsupported syntax refuses the scoped turn.
    let section = "";
    for (const line of text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"))) {
      const header = /^\[([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\]\s*(?:#.*)?$/.exec(line);
      if (header) { section = header[1]!; if (section.startsWith("agent.")) return unsupported(); continue; }
      const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
      if (!assignment || /'''|"""/.test(assignment[2]!) || (!section && assignment[1] === "agent")) return unsupported();
      if (section !== "agent") continue;
      const match = /^(name|definition)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(line);
      if (!match) return unsupported();
      let value: string;
      try { value = match[2]!.startsWith('"') ? JSON.parse(match[2]!) as string : match[2]!.slice(1, -1); }
      catch { return unsupported(); }
      // Grok expands environment variables in paths.
      if (value.includes("$") || !value) return unsupported();
      if (match[1] === "name" && value !== "grok-build") return unsupported();
      if (match[1] === "definition" && flag < 0) {
        if (path !== undefined && path !== value) return unsupported();
        path = value;
      }
    }
  }
  if (!path) return;
  const text = readFileSync(resolve(cwd, path), "utf8"); if (text.length > 262_144) return unsupported();
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!match) return unsupported();
  const profile = parseYaml(match[1]!) as Partial<GrokScopeProfile> | null;
  if (!profile || typeof profile.name !== "string" || typeof profile.description !== "string"
    || (profile.tools !== undefined && (!Array.isArray(profile.tools) || !profile.tools.every((tool) => typeof tool === "string")))
    || (profile.disallowedTools !== undefined && (!Array.isArray(profile.disallowedTools) || !profile.disallowedTools.every((tool) => typeof tool === "string")))) return unsupported();
  const toolConfig = profile.toolConfig ?? { tools: GROK_NATIVE_TOOLS.map(([name, id]) => ({ id, name_override: name })) };
  if (!Array.isArray(toolConfig.tools) || !toolConfig.tools.every((tool) => typeof tool?.id === "string" && (tool.name_override === undefined || typeof tool.name_override === "string"))) return unsupported();
  return { ...profile, name: profile.name, description: profile.description, toolConfig, ...(match[2]?.trim() ? { promptBody: match[2].trim() } : {}) };
}

/** A curated registry: empty/unknown selections never inherit Grok's defaults. */
export function grokToolScopeProfile(scope: unknown, init: unknown, inherited?: GrokScopeProfile, hasMcp = false): GrokScopeProfile {
  const parsed = parseToolScope(scope);
  if (!parsed.ok) throw new Error(parsed.error);
  const meta = (init as { _meta?: { grokShell?: unknown; agentVersion?: unknown } } | null)?._meta;
  if (meta?.grokShell !== true || meta.agentVersion !== "1.0.41") {
    throw new Error("This Grok runtime does not have verified native tool selection. Use Grok 1.0.41 or Pi; update Grok support before using another version.");
  }
  if (hasMcp && (!allowsTool(scope, { kind: "native", name: "search_tool" }) || !allowsTool(scope, { kind: "native", name: "use_tool" }))) {
    throw new Error("Grok requires native:search_tool and native:use_tool to find and call selected MCP tools. Allow both explicitly or use Pi.");
  }
  const candidates = inherited?.toolConfig.tools ?? GROK_NATIVE_TOOLS.map(([name, id]) => ({ id, name_override: name }));
  const selected = candidates.filter((tool) => {
    const name = tool.name_override ?? GROK_NATIVE_TOOLS.find(([, id]) => id === tool.id)?.[0];
    return name !== undefined && allowsTool(scope, { kind: "native", name })
      && (!inherited?.tools?.length || inherited.tools.includes(name) || inherited.tools.includes(tool.id))
      && !inherited?.disallowedTools?.some((denied) => denied === name || denied === tool.id);
  });
  // Grok rejects an empty curated construction.
  return {
    ...inherited, name: inherited?.name ?? "openmausbot-tools", description: inherited?.description ?? "Owner-selected tools",
    injectDefaultTools: false, discoverSkills: false,
    toolConfig: { ...inherited?.toolConfig, tools: selected.length ? selected : [{ id: "GrokBuild:read_file", name_override: "read_file" }] },
    tools: [], disallowedTools: [...new Set([...(inherited?.disallowedTools ?? []), ...(selected.length ? [] : ["read_file"])])],
  };
}

