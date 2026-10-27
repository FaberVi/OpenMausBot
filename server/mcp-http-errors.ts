export type McpHttpFailure = "network" | "status" | "protocol";

export class McpHttpError extends Error {
  readonly kind: McpHttpFailure;
  readonly status: number | undefined;
  readonly wwwAuthenticate: string | undefined;

  constructor(kind: McpHttpFailure, message: string, status?: number, wwwAuthenticate?: string) {
    super(message);
    this.name = "McpHttpError";
    this.kind = kind;
    this.status = status;
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

export class McpRpcError extends McpHttpError {
  readonly code: number | undefined;
  readonly detail: string;

  constructor(code: number | undefined, detail: string) {
    super("protocol", `MCP error: ${detail}`);
    this.name = "McpRpcError";
    this.code = code;
    this.detail = detail;
  }
}

/** Whop's official server lists 425 tools in 1.2 MB of JSON (one tool ~51 KB), so a 1 MB cap refused it. */
export const MAX_REMOTE_MCP_BYTES = 32 * 1024 * 1024;
