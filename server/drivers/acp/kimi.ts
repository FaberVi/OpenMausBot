// Kimi Code: Moonshot's `kimi acp` on the Kimi Code subscription login
// (~/.kimi-code/credentials/kimi-code.json), not a Moonshot API key. Verified on kimi-code 0.29.1.
import type { ModelCatalog } from "../../contracts.ts";
import { mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import {
  applyKimiLocalModelEnv,
  ensureKimiInjectAlias,
  kimiIsAuthenticated,
  readKimiModelCatalog,
  stripKimiModelEnv,
} from "./kimi-home.ts";

export const STATIC_KIMI_MODELS: ModelCatalog = {
  default: "kimi-code/k3",
  options: [
    { id: "kimi-code/k3", label: "Kimi K3" },
    { id: "kimi-code/k3-256k", label: "Kimi K3 256K" },
    { id: "kimi-code/kimi-for-coding", label: "Kimi for Coding" },
    { id: "kimi-code/kimi-for-coding-highspeed", label: "Kimi for Coding Highspeed" },
  ],
};

export {
  applyKimiLocalModelEnv,
  ensureKimiInjectAlias,
} from "./kimi-home.ts";

const support: AcpSupport = {
  driverKind: "kimiAgent",
  displayName: "Kimi",
  // The CLI's own catalog aliases (~/.kimi-code/config.toml; `kimi provider list` reports the same four).
  models: STATIC_KIMI_MODELS,
  resolveModels: (env) => mergeLocalInject(readKimiModelCatalog(env), env),
  defaultCli: "kimi",
  nativeSource: "kimi.acp",
  loginNote: "Kimi Code CLI is not signed in — run `kimi login` in a terminal",

  install: {
    command: {
      darwin: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
      linux: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
      win32: "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
    },
    docsUrl: "https://moonshotai.github.io/kimi-code/en/guides/getting-started.html",
    signInCommand: "kimi login",
  },

  // -m is a global commander option and must precede `acp` (0.29.1).
  resolveTurnModel: (model, env) => (model ? ensureKimiInjectAlias(model, env) : model),
  spawnArgs: (_config, turn) => {
    const model = turn.model;
    return [...(model ? ["-m", model] : []), "acp"];
  },

  // A leaked Moonshot/Kimi API key must not flip billing to pay-as-you-go.
  transformEnv: (env) => {
    delete env.MOONSHOT_API_KEY;
    delete env.KIMI_API_KEY;
    stripKimiModelEnv(env);
  },
  applyTurnEnv: (env, { requestedModel }) => {
    applyKimiLocalModelEnv(env, requestedModel);
  },

  // The only authMethod is {id:"login", type:"terminal"}, a device-code flow ACP cannot drive.
  pickAuthMethod: () => null,
  authFailure: "continue",
  // The child's own data root: a custom HOME or KIMI_CODE_HOME, never the server user's.
  isAuthenticated: kimiIsAuthenticated,

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const KimiAgentDriver = createAcpDriver(support);
