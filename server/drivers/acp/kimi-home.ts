import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { decodeInjectId, hostApiKey, LOCAL_HOSTS, localHost } from "../local-inject.ts";
import { STATIC_KIMI_MODELS } from "./kimi.ts";
import { hasTomlTable, patchTomlTable, quoteToml, quoteTomlKey } from "./kimi-toml.ts";

const SLUG = /^[a-z0-9][a-z0-9._:/-]*$/i;
const LOCAL_PROVIDER_PREFIXES = LOCAL_HOSTS.map((host) => `${host.id}/`);

function isLocalInjectAlias(slug: string): boolean {
  return LOCAL_PROVIDER_PREFIXES.some((prefix) => slug.startsWith(prefix));
}

function kimiDataRoot(env: Record<string, string | undefined>): string {
  return env.KIMI_CODE_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".kimi-code");
}

export function kimiIsAuthenticated(env: Record<string, string | undefined>) {
  return existsSync(credentialsPath(env));
}

function credentialsPath(env: Record<string, string | undefined>) {
  return join(kimiDataRoot(env), "credentials", "kimi-code.json");
}

/** Write [providers.host] + [models."host/alias"] so `kimi -m` hits the local host. */
export function ensureKimiInjectAlias(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const alias = `${inject.host}/${inject.model.replace(/\//g, "-")}`;
  const dataRoot = kimiDataRoot(env);
  mkdirSync(dataRoot, { recursive: true });
  const path = join(dataRoot, "config.toml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }
  const original = text;

  const providerHeading = `[providers.${inject.host}]`;
  const modelHeading = `[models.${quoteTomlKey(alias)}]`;
  const blocks: string[] = [];
  if (!hasTomlTable(text, providerHeading)) {
    blocks.push(
      [
        providerHeading,
        `type = "openai_legacy"`,
        `base_url = ${quoteToml(host.baseUrl)}`,
        `api_key = ${quoteToml(hostApiKey(host, env))}`,
        "",
      ].join("\n"),
    );
  }
  // Kimi 0.36+ refuses openai_legacy as a wire protocol (ACP then falls through to OAuth).
  if (hasTomlTable(text, modelHeading)) {
    text = patchTomlTable(text, modelHeading, [`protocol = "openai"`, `max_context_size = 262144`]);
  } else {
    blocks.push(
      [
        modelHeading,
        `provider = ${quoteToml(inject.host)}`,
        `model = ${quoteToml(inject.model)}`,
        `protocol = "openai"`,
        `max_context_size = 262144`,
        "",
      ].join("\n"),
    );
  }
  if (blocks.length) {
    const prefix = text && !text.endsWith("\n") ? `${text}\n\n` : text ? `${text}\n` : "";
    writeFileSync(path, `${prefix}${blocks.join("\n")}`);
  } else if (text !== original) {
    writeFileSync(path, text);
  }
  return alias;
}

/** Env keys Kimi 0.36+ reads to synthesize an in-memory default model. ACP `session/new` checks auth
 *  against `default_model`, not `-m`, so without one an expired login fails even a local host. */
const KIMI_MODEL_ENV = [
  "KIMI_MODEL_NAME",
  "KIMI_MODEL_API_KEY",
  "KIMI_MODEL_BASE_URL",
  "KIMI_MODEL_PROVIDER_TYPE",
  "KIMI_MODEL_DISPLAY_NAME",
] as const;

/** Kimi strips these reserved entries when it persists config.toml, so they ride the env only. */
export function applyKimiLocalModelEnv(
  env: Record<string, string | undefined>,
  modelId: string | undefined,
): void {
  const inject = decodeInjectId(modelId);
  if (!inject) return;
  const host = localHost(inject.host);
  if (!host) return;
  env.KIMI_MODEL_NAME = inject.model;
  env.KIMI_MODEL_API_KEY = hostApiKey(host, env);
  env.KIMI_MODEL_BASE_URL = host.baseUrl;
  // The env overlay accepts openai | anthropic | kimi, not the toml openai_legacy type.
  env.KIMI_MODEL_PROVIDER_TYPE = "openai";
  env.KIMI_MODEL_DISPLAY_NAME = `${inject.model} (${host.label})`;
}

/** Drop leftover shell `KIMI_MODEL_*` so they cannot steal a cloud turn. */
export function stripKimiModelEnv(env: Record<string, string | undefined>): void {
  for (const key of KIMI_MODEL_ENV) delete env[key];
}

export function readKimiModelCatalog(env: Record<string, string | undefined>): ModelCatalog {
  const dataRoot = kimiDataRoot(env);
  let text = "";
  try {
    text = readFileSync(join(dataRoot, "config.toml"), "utf8");
  } catch {
    return STATIC_KIMI_MODELS;
  }
  const options = STATIC_KIMI_MODELS.options.map((o) => ({ ...o }));
  const seen = new Set(options.map((o) => o.id));
  let current: { slug: string; name?: string } | null = null;
  const flush = () => {
    if (!current || !SLUG.test(current.slug) || seen.has(current.slug) || isLocalInjectAlias(current.slug)) {
      current = null;
      return;
    }
    seen.add(current.slug);
    options.push({ id: current.slug, label: current.name || current.slug, custom: true });
    current = null;
  };
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if ((stripped.startsWith("[model.") || stripped.startsWith("[models.")) && stripped.endsWith("]")) {
      flush();
      let inner = stripped.replace(/^\[models?\./, "").slice(0, -1);
      if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
      current = { slug: inner };
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      continue;
    }
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (current && (key === "name" || key === "label") && value) current.name = value;
  }
  flush();
  return { default: STATIC_KIMI_MODELS.default, options };
}

