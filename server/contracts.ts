// Ported from upstream's provider contracts with Promises for Effect and listeners for Stream; shapes and names are kept.

import type { EffortLevel } from "../shared/wire.ts";
import type {
  DriverKind, InstanceId, ModelVariantOption, RuntimeEventListener, ThreadId, TurnId,
} from "../shared/runtime-events.ts";
import type {
  EngineAccess,
  RequestOutcome,
  SendTurnInput,
  TurnImageInput,
} from "./contracts-send-turn.ts";

export type { CloudBackend, EffortLevel, ModelSelection } from "../shared/wire.ts";
export type {
  DriverKind, InstanceId, ModelVariantOption, ModelVariantState, RuntimeEvent,
  RuntimeEventBase, RuntimeEventListener, ThreadId, TurnId,
} from "../shared/runtime-events.ts";


export type ProviderErrorCode =
  | "missing_cli"
  | "invalid_credentials"
  | "inactive_subscription"
  /** The account has no credit left for a pay-as-you-go model. */
  | "insufficient_funds"
  | "quota_or_region_restriction"
  | "upstream_outage"
  | "model_catalog_outage";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
    this.code = code;
  }
}

/** The attempt never reached a prompt or client-side action and its process stopped, so the harness may recover it. */
export class TurnNotStartedError extends Error {
  readonly turnId: TurnId;

  constructor(turnId: TurnId, message: string) {
    super(message);
    this.name = "TurnNotStartedError";
    this.turnId = turnId;
  }
}

/** The CLI refused sign-in before any model or tool activity, and its process stopped. */
export class TurnAuthenticationRefusedError extends TurnNotStartedError {
  override readonly name = "TurnAuthenticationRefusedError";
}

/** The engine's usage limit refused the turn before any model or tool activity (or is known to be refusing until
 * `resetsAt`), and no process of it is running the turn. */
export class TurnUsageLimitRefusedError extends TurnNotStartedError {
  override readonly name = "TurnUsageLimitRefusedError";
  readonly resetsAt: number | undefined;

  constructor(turnId: TurnId, message: string, resetsAt?: number) {
    super(turnId, message);
    this.resetsAt = resetsAt;
  }
}

/** Variants are opaque provider IDs, not the cross-engine effort enum. */
export function isModelVariant(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !/\p{Cc}/u.test(value);
}

export type {
  EngineAccess,
  InstanceConfig,
  InstanceConfigMap,
  McpServerSpec,
  RemoteMcpSpec,
  RequestOutcome,
  SendTurnInput,
  StdioMcpSpec,
  TurnImageInput,
} from "./contracts-send-turn.ts";

export interface TurnStartResult {
  turnId: TurnId;
}

export interface ProviderAdapter {
  readonly provider: DriverKind;
  readonly capabilities: {
    sessionModelSwitch: "in-session" | "unsupported";
    /** The driver mounts integrations.agents. Every *Mcp flag guards one rule: never tell a bot about tools its driver cannot mount. */
    agentsMcp?: boolean;
    /** The driver mounts isolated computer MCP descriptors. */
    computerMcp?: boolean;
    /** The driver mounts integrations.composio. */
    composioMcp?: boolean;
    /** True when the driver can mount the first-party physical-phone MCP. */
    phoneMcp?: boolean;
    /** The driver can mount the built-in browser MCP. */
    browserMcp?: boolean;
    /** The driver can mount the Data tools MCP. */
    dataMcp?: boolean;
    /** The driver can mount the HighLevel CRM tools MCP. */
    highlevelMcp?: boolean;
    /** The driver can mount the phone apps MCP. */
    deviceMcp?: boolean;
    /** The engine accepts images in the prompt (gates composer paste). */
    images?: boolean;
    /** sendTurn consumes `images` as structured input, so dispatch strips the attachment path from `text`. */
    nativeImageInput?: boolean;
    /** Effort levels the driver can pass to its CLI, ascending; absent hides the control. */
    effortLevels?: readonly EffortLevel[];
    /** The driver validates and applies model-specific variant IDs per session. */
    modelVariants?: boolean;
    /** The driver keeps a live session and can take a user message mid-turn (steer). */
    queueing?: boolean;
    /** steer() delivers `images` as structured input; requires queueing and nativeImageInput. */
    steerImages?: boolean;
    /** True only when local MCP calls can reach the human approval channel; full-auto/bypass instances must leave this false. */
    localComputerMcp?: boolean;
    /** The driver mounts integrations.custom. */
    customMcp?: boolean;
    /** A resumeCursor turn runs in that exact native session, or fails, or starts a new one from recoveryText (session.started says
     * `rebuilt`), never a blank one. */
    strictResume?: boolean;
    /** sendTurn can register the harness's hook helper with the engine (integrations.hooks). */
    hooks?: boolean;
    /** "confined": sendTurn honours `guestConfined`; absent, a guest turn is refused. */
    guestTurns?: "confined";
    /** "meter": `contextTokens` / `contextWindow` are the engine's own report, shown on the context meter but never used to time compaction. */
    contextReading?: "meter";
    /** sendTurn calls `engineAdmission` itself before it starts an engine process or joins one. */
    engineAdmission?: boolean;
  };
  sendTurn(input: SendTurnInput): Promise<TurnStartResult>;
  interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void>;
  /** Never throws for a vanished ask: `unavailable` means nobody could take the answer, and the caller treats it as a deny. */
  respondToRequest(
    threadId: ThreadId,
    requestId: string,
    decision: {
      behavior: "allow" | "deny" | "answer";
      message?: string;
      /** "Always allow this session": the provider's own remembered approval; the app keeps no grant of its own. */
      always?: boolean;
    },
  ): Promise<RequestOutcome>;
  /** Deliver a user message into the running turn (drivers with `capabilities.queueing`).
   * - "steered": accepted into the live turn.
   * - "refused": provably not delivered; the caller may queue it.
   * - "indeterminate": maybe delivered; the caller must NOT re-queue, or it could run twice.
   * A driver that cannot read an attached image refuses the whole steer. */
  steer?(threadId: ThreadId, text: string, images?: readonly TurnImageInput[]): Promise<SteerOutcome>;
  hasSession(threadId: ThreadId): boolean;
  stopAll(): Promise<void>;
  onEvent(listener: RuntimeEventListener): () => void;
  /** `ping` sends one tool-less forked request without touching the thread's session; `hold` keeps the live session open until
   * `until` (epoch ms; null releases) and says whether one exists. */
  cacheKeepWarm?: {
    ping(threadId: ThreadId, options?: { signal?: AbortSignal }): Promise<CacheWarmPingResult>;
    hold(threadId: ThreadId, until: number | null): boolean;
  };
}

/** Tokens are the ping's own; `costUsd` is notional on a subscription. `busy`: a turn was running and nothing was sent;
 * `limit`: the account's usage limit refused it. */
export type CacheWarmPingResult =
  | { ok: true; input: number; cacheRead: number; cacheWrite: number; output: number; costUsd: number | null; model: string | null }
  | { ok: false; reason: string; busy?: boolean; limit?: boolean };

export type SteerOutcome = "steered" | "refused" | "indeterminate";

export interface ProviderSnapshot {
  /** Separate, explicitly authorized ChatGPT-plan billing (not Codex login). */
  chatgptPlan?: boolean;
  authenticationUnavailableReason?: string;
  state: "available" | "unavailable";
  reason?: string;
  authenticated?: boolean;
  /** Display identity from the provider CLI, never credentials; `method` is a personal login or the workspace API key. */
  account?: { email?: string; organization?: string; method?: "login" | "api-key" };
  version?: string | null;
  /** A non-blocking provider update; the renderer shows the exact terminal command. */
  update?: {
    title: string;
    message: string;
    command: string;
  };
  /** On a subscription a reported cost is notional. */
  billing?: "metered" | "subscription";
  /** A setup condition costing the person without their asking, with nothing to run. */
  warning?: {
    title: string;
    message: string;
  };
}

// How a user installs this engine; onboarding, the picker and settings render from it.
export interface EngineInstall {
  /** Added by the registry: commands run on this server, not its web client. */
  platform?: "darwin" | "win32" | "linux";
  /** One-liner per platform; omit a platform with no such command and the UI falls back to docsUrl. */
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  /** Docs or download page. The only route for GUI-installed engines. */
  docsUrl?: string;
  /** Interactive sign-in run after installing, when install isn't enough. */
  signInCommand?: string;
  /** `command` needs npm on PATH, so the UI can say so when Node is absent. */
  needsNode?: boolean;
  /** The app downloads and verifies a pinned provider runtime itself. */
  managed?: {
    label: string;
    downloadBytes: number;
  };
  /** The engine needs a key saved in the app rather than a terminal step. */
  settings?: "connections";
  /** Settings can npm-install this package as the server's own user into an app-owned dir; set by the registry, never by a client. */
  server?: { package: string };
}

export interface ProviderAuthenticationStart {
  phase: "waiting" | "succeeded";
  flowId: string | null;
  authorizationUrl: string | null;
  expiresAt: string | null;
  /** A short-lived code to enter only at the provider's authorization URL. */
  userCode?: string;
}

export interface ProviderAuthenticationStatus extends Omit<ProviderAuthenticationStart, "phase"> {
  phase: "waiting" | "succeeded" | "failed" | "expired" | "cancelled";
  /** Safe, actionable copy; never unfiltered CLI output or credentials. */
  message?: string;
}

export interface ModelCatalog {
  default: string;
  options: Array<{
    id: string;
    label: string;
    custom?: boolean;
    loaded?: boolean;
    /** Upstream provider id (e.g. "zai"), shown as a badge so BYOK duplicates stay distinguishable. */
    provider?: string;
    /** Context window in tokens, when known; sizes the model-facing rebuild. */
    contextWindow?: number;
    /** Discovery hints; the native session revalidates these before each turn. */
    variants?: ModelVariantOption[];
  }>;
}

/** "gpt-5.4-mini" → "Gpt 5.4 Mini", splitting on the caller's word breaks. */
export function titleCaseModelId(id: string, wordBreaks: RegExp): string {
  return id
    .split(wordBreaks)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** A picker label with a second facet (display name, provider host) unless the id already says it. */
export function qualifiedModelLabel(
  id: string,
  qualifier: string | null | undefined,
  options: {
    redundantWhen?: (id: string, qualifier: string) => boolean;
    decorate?: (qualifier: string) => string;
  } = {},
): string {
  const { redundantWhen = () => false, decorate = (facet) => ` — ${facet}` } = options;
  if (!qualifier || redundantWhen(id, qualifier)) return id;
  return `${id}${decorate(qualifier)}`;
}

export interface DriverCreateInput<Config> {
  instanceId: InstanceId;
  displayName: string | undefined;
  environment: Record<string, string>;
  enabled: boolean;
  config: Config;
}

export interface TextGenerationUsage {
  model: string;
  input?: number;
  output?: number;
  cachedInput?: number;
  costUsd?: number;
}

export interface TextGenerationOptions {
  signal?: AbortSignal;
  onUsage?: (usage: TextGenerationUsage) => void;
  /** Only the helper model setting passes it: one of this instance's models instead of the driver's quick-call choice. */
  model?: string;
  /** How long the caller will wait; drivers with their own process timer use it instead of their default. */
  timeoutMs?: number;
  /** For a bot's own engine whose driver picks a small model of its own. */
  fallback?: SmallModelFallback;
}

export interface SmallModelFallback {
  /** The bot's own model on this instance: used instead of a small model the sign-in cannot use, and once more when the provider refuses the small one. */
  model?: string;
  /** Small models this instance refused before: never picked. */
  refused: ReadonlySet<string>;
  onRefused: (model: string) => void;
}

export interface ProviderInstance {
  readonly instanceId: InstanceId;
  readonly driverKind: DriverKind;
  readonly displayName: string | undefined;
  readonly enabled: boolean;
  readonly models: ModelCatalog;
  /** False while the sign-in can refuse a model its catalog lists (Codex on a ChatGPT account): a short message and background text then stay on the bot's own model. */
  readonly quickModelsUsable?: () => boolean;
  /** Refresh a live catalog without recreating the provider instance. */
  readonly refreshModels?: () => Promise<void>;
  /** Set while the last run's catalog is still refreshing; a turn awaits it, listen does not. */
  readonly startupModelRefresh?: Promise<void>;
  /** Optional first-party runtime installation and account setup. */
  readonly installRuntime?: () => Promise<void>;
  readonly startAuthentication?: () => Promise<ProviderAuthenticationStart>;
  readonly authenticationMethod?: "browser-pkce";
  readonly getAuthentication?: (flowId: string) => Promise<ProviderAuthenticationStatus>;
  readonly completeAuthentication?: (flowId: string, callbackUrl: string) => Promise<void>;
  readonly cancelAuthentication?: () => Promise<void>;
  /** Remove the provider CLI's stored sign-in on this server; never touches another instance's home. */
  readonly signOut?: () => Promise<void>;
  readonly adapter: ProviderAdapter;
  snapshot(): Promise<ProviderSnapshot>;
  /** Cheap one-shot text call (titles, summaries); the signal is a best-effort cap. */
  generateText?(prompt: string, options?: TextGenerationOptions): Promise<string>;
  /** One-shot text for background steps only, on engines whose turns are whole agent processes; never for titles or compaction. */
  generateMemoryText?(prompt: string, options?: TextGenerationOptions): Promise<string>;
  /** Isolated, tool-free permission review; separate from generateText so no security capability is inferred from a generic helper. */
  reviewPermission?(prompt: string, signal?: AbortSignal): Promise<string>;
  dispose(): Promise<void>;
}

export interface ProviderDriver<Config = unknown> {
  readonly driverKind: DriverKind;
  readonly metadata: {
    displayName: string;
    supportsMultipleInstances?: boolean;
    access?: EngineAccess;
  };
  /** Omit for engines that need no local binary (API-key drivers). */
  readonly install?: EngineInstall;
  /** Decode the opaque config envelope; throw on invalid (→ shadow). */
  decodeConfig(raw: unknown): Config;
  defaultConfig(): Config;
  readonly models: ModelCatalog;
  /** Owns all per-instance state; must reject, never throw synchronously (a rejection becomes an unavailable shadow snapshot). */
  create(input: DriverCreateInput<Config>): Promise<ProviderInstance>;
}

export type AnyProviderDriver = ProviderDriver<any>;

let eventCounter = 0;
export const newEventId = () => `ev-${Date.now().toString(36)}-${(eventCounter++).toString(36)}`;
export const newId = () => crypto.randomUUID();
