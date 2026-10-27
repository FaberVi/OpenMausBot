import { z } from "zod";
import type { TunnelActivity } from "./tunnel-activity";

export const MANAGED_COMPANION_ORIGIN_URL = "http://127.0.0.1:8812";

export const API_BASE = "https://api.cloudflare.com/client/v4/";
export const API_TIMEOUT_MS = 5_000;
export const MAX_RESPONSE_BYTES = 512 * 1024;

const timestampSchema = z.string().max(64).nullable().optional();

// Connection-state fields are optional so an older or trimmed provider
// response still parses; a missing field can only make a tunnel look active.
const tunnelActivityFields = {
  status: z.string().max(32).nullable().optional(),
  created_at: timestampSchema,
  conns_active_at: timestampSchema,
  conns_inactive_at: timestampSchema,
  connections: z.array(z.unknown()).max(1_000).nullable().optional(),
};

export const tunnelSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(256),
  config_src: z.literal("cloudflare"),
  deleted_at: z.string().nullable().optional(),
  ...tunnelActivityFields,
});

// The account-wide scan also sees tunnels that other services own, including
// locally configured ones. Each item is parsed on its own so one unfamiliar
// tunnel cannot hide the rest of the page.
export const scannedTunnelSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(256),
  config_src: z.string().max(32).nullable().optional(),
  deleted_at: z.string().nullable().optional(),
  ...tunnelActivityFields,
});

export const resultInfoSchema = z.object({
  count: z.number().int().min(0).optional(),
  page: z.number().int().min(0).optional(),
  per_page: z.number().int().min(0).optional(),
  total_count: z.number().int().min(0).optional(),
}).optional();

export const dnsRecordSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  type: z.string().min(1).max(16),
  content: z.string().min(1).max(255),
  proxied: z.boolean(),
});

export const deleteDNSRecordResultSchema = z.object({
  id: z.string().min(1).max(64),
});

export const configurationSchema = z.object({
  config: z.object({
    ingress: z.array(z.object({
      hostname: z.string().optional(),
      service: z.string(),
    })).min(1),
  }),
});

export const errorEnvelopeSchema = z.object({
  errors: z.array(z.object({ code: z.number().int().optional() })).optional(),
  success: z.boolean().optional(),
});

export const connectorTokenSchema = z.string().min(20).max(4_096).regex(/^[\x21-\x7e]+$/);

export type CloudflareFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CloudflareTunnel {
  /** Connection state, when the provider returned it. */
  activity?: TunnelActivity;
  id: string;
  name: string;
}

export interface CloudflareTunnelPage {
  /** Items in this page that did not match the expected tunnel shape. */
  skipped: number;
  /** Raw number of items the provider returned in this page. */
  returned: number;
  /** Account-wide count for the query, when the provider reported one. */
  totalCount: number | null;
  tunnels: Array<CloudflareTunnel & { activity: TunnelActivity; managedConfig: boolean }>;
}

export interface CloudflareDNSRecord {
  content: string;
  id: string;
  name: string;
  proxied: boolean;
  type: string;
}

export class CloudflareAPIError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number | null = null,
    /** Cloudflare's Retry-After (delay-seconds form only) on a 429, else null. */
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(code);
    this.name = "CloudflareAPIError";
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareAPIError
    && (error.status === 404 || error.code === "cf_http_404" || error.code === "cf_api_81044");
}

export async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_RESPONSE_BYTES) {
      throw new CloudflareAPIError("cf_invalid_response");
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CloudflareAPIError("cf_invalid_response");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CloudflareAPIError("cf_invalid_response");
  }
}

export function providerErrorCode(value: unknown, status: number): string {
  const envelope = errorEnvelopeSchema.safeParse(value);
  const providerCode = envelope.success
    ? envelope.data.errors?.find((error) => error.code !== undefined)?.code
    : undefined;
  if (providerCode !== undefined && providerCode >= 0 && providerCode <= 999_999) {
    return `cf_api_${providerCode}`;
  }
  return `cf_http_${status}`;
}

