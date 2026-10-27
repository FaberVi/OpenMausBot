import { z } from "zod";

import type { EndpointAccount } from "./config";
import { tunnelActivity } from "./tunnel-activity";
import {
  API_BASE,
  API_TIMEOUT_MS,
  CloudflareAPIError,
  MANAGED_COMPANION_ORIGIN_URL,
  boundedResponseText,
  configurationSchema,
  connectorTokenSchema,
  deleteDNSRecordResultSchema,
  dnsRecordSchema,
  errorEnvelopeSchema,
  isNotFound,
  providerErrorCode,
  resultInfoSchema,
  scannedTunnelSchema,
  tunnelSchema,
  type CloudflareDNSRecord,
  type CloudflareFetch,
  type CloudflareTunnel,
  type CloudflareTunnelPage,
} from "./cloudflare-api-support.ts";

/** One account's API: its tunnels, and the DNS records of its one zone. */
export class CloudflareAPI {
  constructor(
    private readonly config: Pick<EndpointAccount, "accountId" | "apiToken" | "zoneId">,
    private readonly fetcher: CloudflareFetch,
  ) {}

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: { acceptResultOnlySuccess?: boolean; body?: unknown; method?: string } = {},
  ): Promise<T> {
    return (await this.requestEnvelope(path, schema, init)).result;
  }

  private async requestEnvelope<T>(
    path: string,
    schema: z.ZodType<T>,
    init: { acceptResultOnlySuccess?: boolean; body?: unknown; method?: string } = {},
  ): Promise<{ result: T; totalCount: number | null }> {
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${this.config.apiToken}`,
    });
    let body: string | undefined;
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.body);
    }

    let response: Response;
    try {
      // Calling a stored global fetch as `this.fetcher(...)` rebinds its
      // receiver to this API instance. Workers rejects that with an illegal
      // invocation, so detach the function before invoking it.
      const fetcher = this.fetcher;
      response = await fetcher(new URL(path, API_BASE), {
        body,
        headers,
        method: init.method ?? "GET",
        // Workers only implements `follow` and `manual`. Keep redirects manual
        // so the bearer token is never forwarded to a redirect destination;
        // the non-2xx response checks below reject the 3xx response.
        redirect: "manual",
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new CloudflareAPIError("cf_timeout");
      }
      throw new CloudflareAPIError("cf_network");
    }

    if (response.status === 429) {
      // Cloudflare API limits are per user token and shared by every request
      // this Worker makes. A distinct code lets the cron stop early.
      const retryAfter = response.headers.get("retry-after")?.trim() ?? "";
      await response.body?.cancel();
      throw new CloudflareAPIError(
        "cf_rate_limited",
        429,
        /^[0-9]{1,6}$/.test(retryAfter) ? Number(retryAfter) : null,
      );
    }

    const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/json") {
      if (!response.ok) throw new CloudflareAPIError(`cf_http_${response.status}`, response.status);
      throw new CloudflareAPIError("cf_invalid_response");
    }

    const text = await boundedResponseText(response);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new CloudflareAPIError(
        response.ok ? "cf_invalid_response" : `cf_http_${response.status}`,
        response.status,
      );
    }

    const envelope = errorEnvelopeSchema.safeParse(value);
    const resultOnlySuccess = init.acceptResultOnlySuccess === true
      && response.ok
      && envelope.success
      && envelope.data.success === undefined
      && (envelope.data.errors?.length ?? 0) === 0;
    if (
      !response.ok
      || !envelope.success
      || (envelope.data.success !== true && !resultOnlySuccess)
    ) {
      throw new CloudflareAPIError(providerErrorCode(value, response.status), response.status);
    }
    if (!value || typeof value !== "object" || !("result" in value)) {
      throw new CloudflareAPIError("cf_invalid_response");
    }
    const result = schema.safeParse(value.result);
    if (!result.success) throw new CloudflareAPIError("cf_invalid_response");
    const info = "result_info" in value ? resultInfoSchema.safeParse(value.result_info) : null;
    const totalCount = info?.success ? info.data?.total_count ?? null : null;
    return { result: result.data, totalCount };
  }

  /** One page of the account's undeleted tunnels, with connection state. The
   * query is deliberately unfiltered by name so its total is the account-wide
   * count that the provider quota applies to. */
  async listTunnelPage(page: number, perPage: number): Promise<CloudflareTunnelPage> {
    const query = new URLSearchParams({
      is_deleted: "false",
      page: String(page),
      per_page: String(perPage),
    });
    const { result, totalCount } = await this.requestEnvelope(
      `accounts/${encodeURIComponent(this.config.accountId)}/cfd_tunnel?${query}`,
      z.array(z.unknown()).max(1_000),
    );
    const tunnels: CloudflareTunnelPage["tunnels"] = [];
    let skipped = 0;
    for (const item of result) {
      const parsed = scannedTunnelSchema.safeParse(item);
      if (!parsed.success || parsed.data.deleted_at != null) {
        skipped += 1;
        continue;
      }
      tunnels.push({
        activity: tunnelActivity(parsed.data),
        id: parsed.data.id,
        managedConfig: parsed.data.config_src === "cloudflare",
        name: parsed.data.name,
      });
    }
    return { returned: result.length, skipped, totalCount, tunnels };
  }

  /** Undeleted tunnels in the whole account: what its tunnel quota counts. */
  async countTunnels(): Promise<number | null> {
    return (await this.listTunnelPage(1, 1)).totalCount;
  }

  /** Total DNS records in the zone, for the record-quota alert. */
  async countDNSRecords(): Promise<number | null> {
    const query = new URLSearchParams({ page: "1", per_page: "1" });
    const { totalCount } = await this.requestEnvelope(
      `zones/${encodeURIComponent(this.config.zoneId)}/dns_records?${query}`,
      z.array(z.unknown()).max(1),
    );
    return totalCount;
  }

  async listTunnels(name: string): Promise<CloudflareTunnel[]> {
    const query = new URLSearchParams({ is_deleted: "false", name, per_page: "2" });
    const tunnels = await this.request(
      `accounts/${encodeURIComponent(this.config.accountId)}/cfd_tunnel?${query}`,
      z.array(tunnelSchema),
    );
    const exact = tunnels.filter((tunnel) => tunnel.name === name && tunnel.deleted_at == null);
    return exact.map(({ id, name: tunnelName }) => ({ id, name: tunnelName }));
  }

  async getTunnel(tunnelId: string): Promise<CloudflareTunnel | null> {
    try {
      const tunnel = await this.request(
        `accounts/${encodeURIComponent(this.config.accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`,
        tunnelSchema,
      );
      if (tunnel.id !== tunnelId) throw new CloudflareAPIError("cf_invalid_response");
      if (tunnel.deleted_at != null) return null;
      return { activity: tunnelActivity(tunnel), id: tunnel.id, name: tunnel.name };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async createTunnel(name: string): Promise<CloudflareTunnel> {
    const tunnel = await this.request(
      `accounts/${encodeURIComponent(this.config.accountId)}/cfd_tunnel`,
      tunnelSchema,
      { body: { config_src: "cloudflare", name }, method: "POST" },
    );
    if (tunnel.name !== name) {
      throw new CloudflareAPIError("cf_invalid_response");
    }
    return { id: tunnel.id, name: tunnel.name };
  }

  async configureTunnel(tunnelId: string, hostname: string): Promise<void> {
    const result = await this.request(
      `accounts/${encodeURIComponent(this.config.accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
      configurationSchema,
      {
        body: {
          config: {
            ingress: [
              { hostname, service: MANAGED_COMPANION_ORIGIN_URL },
              { service: "http_status:404" },
            ],
          },
        },
        method: "PUT",
      },
    );
    const ingress = result.config.ingress;
    if (
      ingress.length !== 2
      || ingress[0]?.hostname !== hostname
      || ingress[0]?.service !== MANAGED_COMPANION_ORIGIN_URL
      || ingress[1]?.hostname !== undefined
      || ingress[1]?.service !== "http_status:404"
    ) {
      throw new CloudflareAPIError("cf_invalid_response");
    }
  }

  async listDNSRecords(hostname: string): Promise<CloudflareDNSRecord[]> {
    const query = new URLSearchParams({
      "name.exact": hostname,
      per_page: "2",
      type: "CNAME",
    });
    const records = await this.request(
      `zones/${encodeURIComponent(this.config.zoneId)}/dns_records?${query}`,
      z.array(dnsRecordSchema),
    );
    return records
      .filter((record) => record.type === "CNAME" && record.name.toLowerCase() === hostname)
      .map(({ content, id, name, proxied, type }) => ({ content, id, name, proxied, type }));
  }

  async getDNSRecord(recordId: string): Promise<CloudflareDNSRecord | null> {
    try {
      const record = await this.request(
        `zones/${encodeURIComponent(this.config.zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
        dnsRecordSchema,
      );
      if (record.id !== recordId) throw new CloudflareAPIError("cf_invalid_response");
      return {
        content: record.content,
        id: record.id,
        name: record.name,
        proxied: record.proxied,
        type: record.type,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async createDNSRecord(hostname: string, tunnelId: string): Promise<CloudflareDNSRecord> {
    return this.writeDNSRecord("POST", hostname, tunnelId);
  }

  async updateDNSRecord(recordId: string, hostname: string, tunnelId: string): Promise<CloudflareDNSRecord> {
    return this.writeDNSRecord("PATCH", hostname, tunnelId, recordId);
  }

  private async writeDNSRecord(
    method: "PATCH" | "POST",
    hostname: string,
    tunnelId: string,
    recordId?: string,
  ): Promise<CloudflareDNSRecord> {
    const target = `${tunnelId}.cfargotunnel.com`;
    const suffix = recordId ? `/${encodeURIComponent(recordId)}` : "";
    const record = await this.request(
      `zones/${encodeURIComponent(this.config.zoneId)}/dns_records${suffix}`,
      dnsRecordSchema,
      {
        body: { content: target, name: hostname, proxied: true, ttl: 1, type: "CNAME" },
        method,
      },
    );
    if (
      record.name.toLowerCase() !== hostname
      || record.type !== "CNAME"
      || record.content.toLowerCase() !== target
      || !record.proxied
    ) {
      throw new CloudflareAPIError("cf_invalid_response");
    }
    return {
      content: record.content,
      id: record.id,
      name: record.name,
      proxied: record.proxied,
      type: record.type,
    };
  }

  async getConnectorToken(tunnelId: string): Promise<string> {
    return this.request(
      `accounts/${encodeURIComponent(this.config.accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`,
      connectorTokenSchema,
    );
  }

  async deleteDNSRecord(recordId: string): Promise<void> {
    try {
      const result = await this.request(
        `zones/${encodeURIComponent(this.config.zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
        deleteDNSRecordResultSchema,
        { acceptResultOnlySuccess: true, method: "DELETE" },
      );
      if (result.id !== recordId) throw new CloudflareAPIError("cf_invalid_response");
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async deleteTunnel(tunnelId: string): Promise<void> {
    try {
      await this.request(
        `accounts/${encodeURIComponent(this.config.accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`,
        z.unknown(),
        { method: "DELETE" },
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}
