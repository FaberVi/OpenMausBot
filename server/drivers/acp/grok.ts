// Grok Build: the official `grok` CLI over ACP stdio (`grok … agent stdio`) on the grok.com
// subscription login (~/.grok/auth.json), not the xAI API key. Verified against grok 1.0.0.
import { setTimeout as delay } from "node:timers/promises";

import type { ModelCatalog } from "../../contracts.ts";
import { mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import type { AcpQuestionRequest } from "./question-requests.ts";
import {
  GROK_DEVICE_SIGN_IN,
  ensureGrokInjectSlug,
  grokAcceptsUnadvertisedImages,
  grokInheritedProfile,
  grokSignedIn,
  grokToolScopeProfile,
  readGrokModelCatalog,
} from "./grok-home.ts";
import { allowsTool, canUseMcpServer, narrowsNativeTools } from "../../../shared/tool-scope.ts";
import { OWN_APPS_SERVER } from "../../../shared/own-apps.ts";
import { MAX_QUESTIONS, parseProtocolAskQuestions, pickedOptionLabels, questionAnswersById, repeatsQuestionText } from "../../../shared/ask-question.ts";

export const STATIC_GROK_MODELS: ModelCatalog = {
  default: "grok-4.7",
  options: [
    { id: "grok-4.7", label: "Grok 4.7", contextWindow: 500_000 },
    { id: "grok-4.6", label: "Grok 4.6" },
    { id: "grok-4.5", label: "Grok 4.5" },
  ],
};

export {
  GROK_DEVICE_SIGN_IN,
  ensureGrokInjectSlug,
  grokAcceptsUnadvertisedImages,
  grokHome,
  grokInheritedProfile,
  grokSignedIn,
  grokToolScopeProfile,
  readGrokModelCatalog,
} from "./grok-home.ts";

/** Grok's `ask_user_question` blocks its turn on this extension request (xai-org/grok-build ask_user_question/types.rs);
 * ACP's Rust SDK adds the `_` prefix on the wire. Answers are keyed by Grok's question text, one label per pick; own
 * words ride as "Other" with the text in annotations[].notes. */
export const GROK_ASK_USER_QUESTION: AcpQuestionRequest = {
  cancelled: { outcome: "cancelled" },
  parse(params) {
    const raw = (params as { questions?: unknown } | null)?.questions;
    // Refused whole: answering only the first ones would read the rest as accepted.
    if (!Array.isArray(raw) || raw.length > MAX_QUESTIONS) return null;
    // The index is the id, so each card question maps back to Grok's exact text; `multi_select` is its model-facing name.
    const parsed = parseProtocolAskQuestions(raw.map((entry, index) =>
      entry && typeof entry === "object"
        ? { ...entry, id: String(index), multiSelect: entry.multiSelect === true || entry.multi_select === true }
        : entry));
    if (!parsed || repeatsQuestionText(parsed)) return null;
    return {
      questions: parsed.map(({ question }) => question),
      answered(message) {
        const byId = questionAnswersById(message, parsed);
        // Null prototype: a question text such as __proto__ is a real key.
        const answers: Record<string, string[]> = Object.create(null);
        const annotations: Record<string, { notes: string }> = Object.create(null);
        for (const { id, question } of parsed) {
          const reply = byId[id];
          if (reply === undefined) continue;
          const text = (raw[Number(id)] as { question: string }).question;
          const { labels, other } = pickedOptionLabels(reply, question);
          answers[text] = other === undefined ? labels : [...labels, "Other"];
          if (other !== undefined) annotations[text] = { notes: other };
        }
        if (!Object.keys(answers).length) return null;
        return { outcome: "accepted", answers, ...(Object.keys(annotations).length ? { annotations } : {}) };
      },
    };
  },
};

const support: AcpSupport = {
  driverKind: "grokAgent",
  questionRequests: {
    "_x.ai/ask_user_question": GROK_ASK_USER_QUESTION,
    "x.ai/ask_user_question": GROK_ASK_USER_QUESTION,
  },
  displayName: "Grok",
  images: true,
  acceptsUnadvertisedImages: grokAcceptsUnadvertisedImages,
  models: STATIC_GROK_MODELS,
  resolveModels: (env) => mergeLocalInject(readGrokModelCatalog(env), env),
  // Grok's levels vary by model and the CLI validates lazily (a rejected level only logs); grok-4.5 rejects xhigh.
  effortLevels: ["low", "medium", "high"],
  defaultCli: "grok",
  nativeSource: "grok.acp",
  loginNote: "Grok is not signed in to your grok.com account — choose Sign in to Grok in engine setup",

  // No Windows one-liner: the installer is a POSIX shell script.
  install: {
    command: {
      darwin: "curl -fsSL https://x.ai/cli/install.sh | bash",
      linux: "curl -fsSL https://x.ai/cli/install.sh | bash",
    },
    docsUrl: "https://x.ai/cli",
    signInCommand: "grok login",
  },
  deviceSignIn: GROK_DEVICE_SIGN_IN,

  // With the instance HOME/GROK_HOME: ensureGrokInjectSlug defaults to process.env.
  resolveTurnModel: (model, env) => (model ? ensureGrokInjectSlug(model, env) : model),

  // --permission-mode is global; -m and --reasoning-effort only apply between `agent` and `stdio`
  // (Grok 1.0.6; -m first is taken as a TUI option and ignored). Auto selects Grok's native
  // classifier, never bypassPermissions. xai-org/grok-build@37949780 crates/codegen/xai-grok-pager-bin/src/main.rs:1259-1273.
  spawnArgs: (config, turn) => [
    "--permission-mode",
    config.fullAuto
      ? "bypassPermissions"
      : turn.approvalMode === "auto" ? "auto" : turn.approvalMode === "edits" ? "acceptEdits" : "default",
    "agent",
    ...(turn.toolScope !== undefined ? ["--no-leader"] : []),
    ...(turn.model ? ["-m", turn.model] : []),
    // Long form: `--effort` is only an alias.
    ...(turn.effort ? ["--reasoning-effort", turn.effort] : []),
    "stdio",
  ],

  toolScopeSessionParams: (turn, init, hasMcp, { config, env, cwd }) => {
    if (!narrowsNativeTools(turn.toolScope)) return {};
    const profile = grokToolScopeProfile(turn.toolScope, init, grokInheritedProfile(config.cli, env, cwd), hasMcp);
      // Changing harnesses after session/new can discard an ACP profile and restore default tools.
    if (turn.model) profile.model = ensureGrokInjectSlug(turn.model, env);
    return { _meta: { agentProfile: profile } };
  },
  toolScopeCacheKey: ({ config, env, cwd }) => JSON.stringify(grokInheritedProfile(config.cli, env, cwd) ?? null),

  // -m on argv is not enough: session/new still starts on [models].default.
  async configureSession({ request, sessionId, turn, currentModelId }) {
    if (turn.toolScope !== undefined) {
      const available = new Set([
        ...(turn.integrations?.agents ? ["agents"] : []), ...(turn.integrations?.composio ? ["composio"] : []), ...(turn.integrations?.composioOwn ? [OWN_APPS_SERVER] : []),
        ...(turn.integrations?.browser ? ["browser"] : []), ...(turn.integrations?.localComputer ? ["computer"] : []),
        ...(turn.integrations?.data ? ["data"] : []), ...(turn.integrations?.highlevel ? ["highlevel"] : []), ...(turn.integrations?.device ? ["device"] : []),
        ...Object.keys(turn.integrations?.custom ?? {}),
      ].filter((name) => canUseMcpServer(turn.toolScope, name)));
      const deadline = Date.now() + 10_000;
      for (;;) {
        const reply = await request("_x.ai/mcp/list", { sessionId, cache: true }, 10_000);
        const catalog = reply?.result;
        if (!Array.isArray(catalog?.servers)) throw new Error("Grok could not confirm its MCP catalog. No prompt was sent.");
        for (const server of catalog.servers) {
          if (server?.session?.enabled === false) continue;
          if (!available.has(server?.name)) throw new Error("Grok has an MCP connection outside the bot's selection. Disable native MCP connections before using tool selection. No prompt was sent.");
          if (Array.isArray(server?.session?.tools) && server.session.tools.some((tool: { name?: unknown }) => typeof tool.name !== "string" || !allowsTool(turn.toolScope, { kind: "mcp", server: server.name, name: tool.name }))) {
            throw new Error("Grok could not enforce the selected MCP catalog. No prompt was sent.");
          }
        }
        if (catalog.sessionMcpResolved === true) {
          if ([...available].some((name) => !catalog.servers.some((server: { name?: string; session?: { enabled?: boolean; status?: string } }) => server.name === name && server.session?.enabled === true && server.session.status === "ready"))) {
            throw new Error("Grok could not connect a selected MCP server. No prompt was sent.");
          }
          break;
        }
        if (Date.now() >= deadline) throw new Error("Grok did not confirm its selected MCP catalog in time. No prompt was sent.");
        await delay(50);
      }
    }
    if (!turn.model) return;
    if (narrowsNativeTools(turn.toolScope)) {
      if (currentModelId !== turn.model) {
        throw new Error("Grok could not confirm the selected model without replacing its tool profile. Start a new conversation or choose a model with a supported Grok profile. No prompt was sent.");
      }
        // Repeating set_model can rebuild the harness or reject a valid resumed profile.
      return;
    }
    try {
      await request("session/set_model", { sessionId, modelId: turn.model });
    } catch (e) {
      throw new Error(
        `Grok rejected model "${turn.model}" via session/set_model: ${(e as Error).message}. ` +
          `Check that grok is current (1.0.6+ supports it) and that this slug exists in ~/.grok/config.toml.`,
      );
    }
  },

  // A leaked API key silently flips the grok.com subscription to pay-as-you-go.
  transformEnv: (env) => {
    delete env.XAI_API_KEY;
  },
  applyTurnEnv: (env, { toolScope }) => {
    if (toolScope !== undefined) {
      // These env switches outrank account defaults in the verified runtime.
      env.GROK_MANAGED_MCPS_ENABLED = "false";
      env.GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED = "false";
      if (narrowsNativeTools(toolScope)) {
        if (env.GROK_AGENT && env.GROK_AGENT !== "grok-build") {
          throw new Error("Grok's existing agent profile cannot be safely intersected with tool selection. Use a separate default Grok account.");
        }
        // A model's agent_type otherwise takes priority over ACP profiles.
        env.GROK_AGENT = "grok-build";
      }
    }
  },

  pickAuthMethod: (methods) => (methods.some((m) => m.id === "cached_token") ? "cached_token" : null),
  authFailure: "fail",
  isAuthenticated: (env) => grokSignedIn(env),

  // `--append-system-prompt`/`--rules` do not reach the agent-stdio system prompt (1.0.0).
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const GrokAgentDriver = createAcpDriver(support);
