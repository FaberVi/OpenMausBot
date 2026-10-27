// This client never logs a header value.
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

import type { RemoteMcpSpec } from "./contracts.ts";

export type { McpHttpFailure } from "./mcp-http-errors.ts";
export { MAX_REMOTE_MCP_BYTES, McpHttpError, McpRpcError } from "./mcp-http-errors.ts";

export const REMOTE_MCP_STARTUP_MS = 30_000;

/** Only this name reaches argv, never the address or a header value. */
export const REMOTE_MCP_CONFIG_ENV = /^OMB_REMOTE_MCP_CONFIG_[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate private proxy configuration without including secrets in errors. */
export function remoteMcpSpec(value: unknown): RemoteMcpSpec | undefined {
  if (!isRecord(value) || (value.type !== "http" && value.type !== "sse") || typeof value.url !== "string") return;
  try {
    const url = new URL(value.url);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return;
    const headers = value.headers ?? {};
    if (!isRecord(headers) || !Object.values(headers).every((header) => typeof header === "string")) return;
    new Headers(headers as Record<string, string>);
    return { type: value.type, url: value.url, headers: headers as Record<string, string> };
  } catch { return; }
}

export { RemoteMcpClient } from "./mcp-http-client.ts";

// Node 24's fetch hangs on plain http:// through its env proxy, so such a request goes to HTTP_PROXY in absolute form, as curl does.

function isLoopback(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** NO_PROXY by curl's rules: a name matches itself and subdomains, a leading dot or `*.` is ignored, `*` matches all, a port must match. */
export function bypassesProxy(target: URL, noProxy: string): boolean {
  const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isLoopback(host)) return true;
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  for (const raw of noProxy.split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    const hostPort = !bracketed && entry.split(":").length === 2 ? entry.split(":") : undefined;
    const name = (bracketed?.[1] ?? hostPort?.[0] ?? entry).replace(/^\*?\./, "");
    const entryPort = bracketed?.[2] ?? hostPort?.[1];
    if (entryPort && entryPort !== port) continue;
    if (name && (host === name || host.endsWith(`.${name}`))) return true;
  }
  return false;
}

export function plainHttpProxyFetch(env: Record<string, string | undefined>, fallback: typeof fetch = fetch): typeof fetch | undefined {
  const configured = env.http_proxy || env.HTTP_PROXY;
  if (!configured) return undefined;
  let proxy: URL;
  try {
    proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(configured) ? configured : `http://${configured}`);
    if (proxy.protocol !== "http:" && proxy.protocol !== "https:") return undefined;
  } catch { return undefined; }
  const noProxy = [env.no_proxy, env.NO_PROXY].filter(Boolean).join(",");
  const authorization = proxy.username
    ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`
    : undefined;
  const proxied = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    const body = init.body;
    if (input instanceof Request || target.protocol !== "http:" || bypassesProxy(target, noProxy) || (body != null && typeof body !== "string")) {
      return fallback(input, init);
    }
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
    headers.host = target.host;
    if (authorization) headers["proxy-authorization"] = authorization;
    if (typeof body === "string") headers["content-length"] = String(Buffer.byteLength(body));
    return new Promise<Response>((resolve, reject) => {
      const send = proxy.protocol === "https:" ? httpsRequest : httpRequest;
      const request = send({
        host: proxy.hostname.replace(/^\[|\]$/g, ""),
        port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
        method: init.method ?? "GET",
        path: target.href,
        headers,
        ...(init.signal ? { signal: init.signal } : {}),
      });
      request.on("response", (response: IncomingMessage) => {
        const status = response.statusCode ?? 502;
        const received = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) received.append(name, entry);
        }
        const empty = status === 204 || status === 205 || status === 304;
        if (empty) response.resume();
        try {
          resolve(new Response(empty ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, statusText: response.statusMessage, headers: received }));
        } catch (error) {
          response.destroy();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      request.on("error", reject);
      request.end(body ?? undefined);
    });
  };
  return proxied as typeof fetch;
}
