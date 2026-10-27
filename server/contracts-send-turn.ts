import type { ApprovalMode } from "../shared/approval-mode.ts";
import type { ToolScope } from "../shared/tool-scope.ts";
import type { EffortLevel } from "../shared/wire.ts";
import type { DriverKind, InstanceId, ThreadId } from "../shared/runtime-events.ts";
import type { ProviderIcon } from "../shared/provider-icon.ts";

/** How an engine is presented in the picker rail.
 *  `subscription` — first-party cloud catalog; Custom is extra.
 *  `custom` — no subscription catalog; Custom is the product.
 *  `api` — a cloud model catalog billed through an API key. */
export type EngineAccess = "subscription" | "custom" | "api";

/** An image already admitted to the private attachment store; drivers get this, never a host path in the prompt. */
export interface TurnImageInput {
  path: string;
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  bytes: number;
}

// `driver` is any slug: an unknown driver round-trips as an unavailable shadow snapshot.
export interface InstanceConfig {
  driver: DriverKind;
  displayName?: string;
  accentColor?: string;
  /** Presentation override for this instance only. */
  icon?: ProviderIcon;
  environment?: Record<string, string>;
  enabled?: boolean;
  /** Picker group over the driver's default: an `openai-compat` instance on a provider's own key is "api". */
  access?: EngineAccess;
  config?: unknown;
}

export type InstanceConfigMap = Record<InstanceId, InstanceConfig>;

/** `allowed-once` grants only the asked-about action; `unavailable` is the fail-closed default: no answerer, no action. */
export type RequestOutcome = "allowed-once" | "rejected" | "answered" | "unavailable";

// Sessions start implicitly on the first turn; resumeCursor carries the provider-native continuation (e.g. a Claude session id).
export interface SendTurnInput {
  threadId: ThreadId;
  /** Drivers namespace process-level resources (broker socket, CLI session) by botId too: threadIds may coincide across bots. */
  botId?: string;
  text: string;
  /** The recall block the harness put in front of `text`; it informs this turn only, so a replay can leave it out. */
  recalled?: string;
  /** Reasserted every turn so a resumed native session cannot keep a stale, more permissive mode. */
  approvalMode?: ApprovalMode;
  /** Fresh owner selection, independent of execution approval and resume state. */
  toolScope?: ToolScope;
  /** A guest turn: no shell or command execution, no reads outside its folder. Sent only to drivers whose guestTurns is "confined". */
  guestConfined?: boolean;
  /** Why this turn is confined, in the owner's words, for a refusal to end with. */
  confinedWhy?: string;
  /** Images for this user turn only; kept out of replay transcripts. */
  images?: TurnImageInput[];
  model?: string;
  effort?: EffortLevel;
  variant?: string;
  resumeCursor?: unknown;
  /** Start without the previous native context or retained process; wins over resumeCursor. */
  sessionReset?: boolean;
  /** Hold the startup ACK until prompt dispatch (Claude: first model activity); a retired transient setup failure or sign-in refusal may reject with TurnNotStartedError. */
  startupRecovery?: boolean;
  /** Given to a driver with `capabilities.engineAdmission`: awaited right before it starts an engine process ("process") or
   * adds this thread's session to the running one whose pid is `joining` ("session"); rejects with TurnNotStartedError when
   * the turn is stopped first. */
  engineAdmission?: (start: "process" | "session", joining?: number) => Promise<void>;
  /** The turn with the conversation replayed inline, sent once on a fresh session when the provider refuses resumeCursor before reading the prompt. */
  recoveryText?: string;
  /** Prior turns for transcript-replay providers (API-backed drivers). */
  transcript?: Array<{ role: "user" | "assistant"; text: string }>;
  /** Bot persona (name/title/description) as a system prompt. */
  system?: string;
  /** `system` without its volatile sections (systemVolatile). A per-thread CLI process keys on this half; request-per-turn drivers
   * carry the volatile half in the newest user message so the cached prefix stays byte-identical. */
  systemStable?: string;
  systemVolatile?: string;
  /** The message tags teammates, so digest-based delivery must not suppress the mentions note even when it is unchanged. */
  mentionTurn?: boolean;
  /** The bot will likely browse, so a driver may load browser tools up front rather than behind tool search. */
  preloadBrowserTools?: boolean;
  /** Per-bot integrations the driver may hand to the agent as tools. */
  integrations?: {
    /** A harness-owned stdio bridge to Composio, so connection requests become trusted chat cards. */
    composio?: { command: string; args: string[]; env: Record<string, string> };
    /** The same bridge to a Team Cloud member's own apps, only in that member's own turns. */
    composioOwn?: { command: string; args: string[]; env: Record<string, string> };
    /** Stdio connection to a computer MCP server. `scope` is set only for the host desktop, so host-only approval rules never apply elsewhere. */
    localComputer?: {
      command: string;
      args: string[];
      env: Record<string, string>;
      platform?: "darwin" | "linux" | "win32";
      generation?: string;
      scope?: "local-computer";
    };
    /** Loopback URL and turn-scoped bearer for the engine's hook helper; hooks observe and inject context, never decide state. */
    hooks?: { url: string; token: string };
    /** Peer-agent MCP proxy (list_bots / coordinate_bots); the harness owns turns, permissions and recursion limits. */
    agents?: { command: string; args: string[]; env: Record<string, string> };
    /** Physical Android phone tools over authorized USB debugging. */
    phone?: { command: string; args: string[]; env: Record<string, string> };
    /** The built-in browser's MCP proxy: one tab per bot, in its own persistent partition. */
    browser?: { command: string; args: string[]; env: Record<string, string> };
    /** The Data tools' MCP proxy: DuckDB on this bot's own database. */
    data?: { command: string; args: string[]; env: Record<string, string> };
    /** The HighLevel CRM tools' MCP proxy: the harness holds the tokens and the per-bot verdict. */
    highlevel?: { command: string; args: string[]; env: Record<string, string> };
    /** The paired phone's app tools' MCP proxy: the harness holds the jobs and the per-bot verdict. */
    device?: { command: string; args: string[]; env: Record<string, string> };
    /** dweb daemon tools; `url` is the dweb HTTP base. */
    dweb?: { url: string };
    /** The user's MCP servers, mounted without any pre-allow; a driver skips a kind it cannot speak. */
    custom?: Record<string, McpServerSpec>;
    /** The `custom` servers this turn mounts through an MCP Apps observer; `extension`: advertise the
     * UI extension (false once the server refused it). A server not named here is mounted unchanged. */
    mcpApps?: Record<string, { extension: boolean }>;
    /** Characters of one tool result per `custom` server; 0 = never trim, a missing name = the app default. */
    customResultBudgets?: Record<string, number>;
  };
  cwd?: string;
  /** Also load the person's own CLI MCP setup (Claude Code user scope, claude.ai connectors). */
  mcpFromUserConfig?: boolean;
  /** Claude Code loads the person's own `~/.claude/skills` from this folder's `.claude/skills` (`--add-dir`). */
  userSkillsDir?: string;
  /** Per-call ceiling (ms) for this turn's MCP tools; absent is the driver's default (10 min). */
  mcpCallTimeoutMs?: number;
  /** Times an API-model turn that answers after a failed tool call is sent back to re-run it (`loopGuard.correctiveRounds`); never after a denial. */
  toolErrorCorrectiveRounds?: number;
}

/** An MCP server this machine starts and talks to over stdio. */
export interface StdioMcpSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** An MCP server over streamable HTTP (`http`) or the older SSE transport; header values are credentials and never go on argv. */
export interface RemoteMcpSpec {
  type: "http" | "sse";
  url: string;
  headers: Record<string, string>;
}

export type McpServerSpec = StdioMcpSpec | RemoteMcpSpec;
