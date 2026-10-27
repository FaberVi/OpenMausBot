// Cursor Agent (`cursor-agent acp`) on the Cursor subscription (`cursor-agent login`, CURSOR_API_KEY or
// CURSOR_AUTH_TOKEN). Per cursor.com/docs/cli/acp it advertises `cursor_login` and takes `--force` /
// `--model` as global flags before `acp`.
import { execCli } from "../../procs.ts";
import {
  classifyCursorError,
  fetchCursorModels,
  matchCursorAcpModel,
  probeCursorAuth,
  STATIC_CURSOR_MODELS,
} from "./cursor-acp-models.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import type { AcpQuestionRequest } from "./question-requests.ts";
import {
  capAnswerEcho, formatQuestionAnswers, MAX_QUESTIONS, parseChoices, parseProtocolAskQuestions, pickedOptionLabels, questionAnswersById,
  repeatsQuestionText,
} from "../../../shared/ask-question.ts";

export {
  classifyCursorError,
  decodeCursorAuthStatus,
  decodeCursorAuthText,
  decodeCursorModelCatalog,
  decodeCursorModelText,
  fetchCursorModels,
  matchCursorAcpModel,
  probeCursorAuth,
  resolveCursorAcpModelId,
  STATIC_CURSOR_MODELS,
} from "./cursor-acp-models.ts";

/** Cursor's AskQuestion blocks on `cursor/ask_question` (cursor.com/docs/cli/acp; cursor-agent 2026.10.01, no sessionId).
 * Cursor answers by option id only, so a reply with any own words goes back whole as `skipped` with the answers as the
 * reason, which Cursor hands the model verbatim: a typed answer is never forced onto an option. */
export const CURSOR_ASK_QUESTION: AcpQuestionRequest = {
  cancelled: { outcome: { outcome: "cancelled" } },
  parse(params) {
    const raw = (params as { questions?: unknown } | null)?.questions;
    if (!Array.isArray(raw) || raw.length > MAX_QUESTIONS) return null;
    const parsed = parseProtocolAskQuestions(raw.map((entry) =>
      entry && typeof entry === "object"
        ? { id: entry.id, question: entry.prompt, options: entry.options, multiSelect: entry.allowMultiple === true }
        : entry));
    if (!parsed || repeatsQuestionText(parsed)) return null;
    const rawOptions = new Map<string, unknown[]>(raw.flatMap((entry) =>
      entry && typeof entry.id === "string" && Array.isArray(entry.options) ? [[entry.id, entry.options]] : []));
    // Card labels are trimmed and capped: never guess when two options normalize alike.
    const optionId = (questionId: string, label: string): string | null => {
      const matches = (rawOptions.get(questionId) ?? []).filter((option) => parseChoices([option], 1)?.[0] === label);
      const id = matches.length === 1 ? (matches[0] as { id?: unknown }).id : null;
      return typeof id === "string" ? id : null;
    };
    const questions = parsed.map(({ question }) => question);
    return {
      questions,
      answered(message) {
        const byId = questionAnswersById(message, parsed);
        const answers: Array<{ questionId: string; selectedOptionIds: string[] }> = [];
        let ownWords = false;
        for (const { id, question } of parsed) {
          const reply = byId[id];
          if (reply === undefined) continue;
          const { labels, other } = pickedOptionLabels(reply, question);
          const selectedOptionIds = labels.map((label) => optionId(id, label));
          if (other !== undefined || selectedOptionIds.some((selected) => selected === null)) ownWords = true;
          else answers.push({ questionId: id, selectedOptionIds: selectedOptionIds as string[] });
        }
        if (ownWords) {
          const reason = formatQuestionAnswers(questions, parsed.map(({ id }) => byId[id] ? [byId[id]] : []));
          return { outcome: { outcome: "skipped", reason: capAnswerEcho(reason) } };
        }
        return answers.length ? { outcome: { outcome: "answered", answers } } : null;
      },
    };
  },
};

async function setCursorFast(
  request: (method: string, params: unknown) => Promise<unknown>,
  sessionId: string,
  fast: boolean,
): Promise<void> {
  let reply: { configOptions?: Array<{ id?: unknown; currentValue?: unknown }> } | undefined;
  try {
    reply = (await request("session/set_config_option", { sessionId, configId: "fast", value: String(fast) })) as typeof reply;
  } catch (e) {
    // -32602: the chosen model has no Fast variant, so there is nothing to switch.
    if ((e as { code?: unknown }).code !== -32602) throw e;
    return;
  }
  // Cursor can acknowledge the switch yet keep its default Fast variant, so only the echoed value counts.
  const confirmed = reply?.configOptions?.find((option) => option?.id === "fast")?.currentValue;
  if (confirmed !== String(fast)) {
    throw new Error(
      `Cursor did not confirm Fast ${fast ? "on" : "off"} (fast is ${confirmed === undefined ? "unreported" : JSON.stringify(confirmed)}), ` +
        "so the turn was not sent. Check that `cursor-agent` is current.",
    );
  }
}

const support = (run: typeof execCli): AcpSupport => ({
  driverKind: "cursorAgent",
  questionRequests: { "cursor/ask_question": CURSOR_ASK_QUESTION },
  displayName: "Cursor",
  models: STATIC_CURSOR_MODELS,
  // Other coding agents can install a generic `agent` shim; `cursor-agent` is unambiguous.
  defaultCli: "cursor-agent",
  nativeSource: "cursor.acp",
  loginNote: "Cursor CLI is not signed in — run `cursor-agent login` in a terminal, or set CURSOR_API_KEY",

  install: {
    command: {
      darwin: "curl https://cursor.com/install -fsS | bash",
      linux: "curl https://cursor.com/install -fsS | bash",
      win32: "irm 'https://cursor.com/install?win32=true' | iex",
    },
    docsUrl: "https://cursor.com/docs/cli/installation",
    signInCommand: "cursor-agent login",
  },

  // Global flags precede `acp`; `--force` is the documented auto-approve switch.
  spawnArgs: (config, turn) => [
    ...(config.fullAuto ? ["--force"] : turn.approvalMode === "auto" ? ["--auto-review"] : []),
    ...(turn.model ? ["--model", turn.model] : []),
    "acp",
  ],
  credentialEnv: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],

  resolveModels: (environment, config) => fetchCursorModels(config.cli || "cursor-agent", environment, run),

  // A key in the env already authenticates the session, and Cursor's cursor_login handler would then
  // delete the saved login and open a browser once the token expired, so it is not sent.
  pickAuthMethod: (methods, env) =>
    (env.CURSOR_API_KEY?.trim() || env.CURSOR_AUTH_TOKEN?.trim()) ? null
      : methods.some((m) => m.id === "cursor_login") ? "cursor_login" : null,
  authFailure: "continue",
  isAuthenticated: (env, config) => probeCursorAuth(config.cli || "cursor-agent", env, run),
  classifyError: classifyCursorError,

  // Without parameterizedModelPicker Cursor (CLI 2026.10.19) offers only `composer-2.5[fast=true]`, so a
  // `composer-2.5` bot bills as Fast; with it, Fast is a separate `fast` config option.
  clientCapabilitiesMeta: { parameterizedModelPicker: true },

  async configureSession({ request, sessionId, turn, sessionModels, currentModelId, configOptions, notice }) {
    if (!turn.model) return;
    const fastOption = configOptions.some((option) => option?.id === "fast");
    const wantsFast = /-fast$/i.test(turn.model);
    const wanted = fastOption && wantsFast ? turn.model.slice(0, -"-fast".length) : turn.model;
    const match = matchCursorAcpModel(sessionModels ?? [], wanted);
    const modelId = match?.modelId ?? wanted;
    try {
      await request("session/set_model", { sessionId, modelId });
      if (match && !match.exact) {
        notice(`Cursor offers ${modelId} rather than ${turn.model} in this session, so this conversation uses ${modelId}.`);
      }
    } catch (e) {
      const err = e as Error & { code?: unknown };
        // -32601: no set_model, so the argv pin holds. -32602: not in this namespace; current CLIs
        // ignore argv `--model` in ACP, so the session keeps its starting model.
      if (err.code === -32601) return;
      if (err.code === -32602) {
        const current = sessionModels?.find((m) => m.modelId === currentModelId);
        const running = current?.name ?? currentModelId;
        notice(
          `Cursor did not accept ${turn.model} in this session, so it runs ${running ?? "its default model"}. ` +
            "Choose another model for this bot to stop seeing this.",
        );
        return;
      }
      throw new Error(
        `Cursor rejected model "${turn.model}" (sent as "${modelId}") via session/set_model: ${err.message}. ` +
          `Check that \`cursor-agent\` is current and that this account can use that model.`,
      );
    }
    if (fastOption) await setCursorFast(request, sessionId, wantsFast);
  },

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
});

export function createCursorAgentDriver(run: typeof execCli = execCli) {
  return createAcpDriver(support(run));
}

export const CursorAgentDriver = createCursorAgentDriver();
