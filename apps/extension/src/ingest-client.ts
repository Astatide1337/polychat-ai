import type {
  Conversation,
  IngestRequest,
  ProviderId,
  SyncProviderStatus,
} from "@polychat-ai/history-core/browser";

export type IngestClientConfig = {
  serverUrl: string;
  ingestToken: string;
};

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function assertSecureServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return url.toString();
  throw new Error("MCP server URL must be https:// or localhost");
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T) : ({} as T);
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? response.statusText);
  }
  return body;
}

function headers(token: string, contentType = "application/json"): HeadersInit {
  return {
    "content-type": contentType,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export async function postConversation(
  config: IngestClientConfig,
  request: IngestRequest
): Promise<{ ok: boolean }> {
  const serverUrl = assertSecureServerUrl(config.serverUrl).replace(/\/$/, "");
  return requestJson(`${serverUrl}/ingest/conversation`, {
    method: "POST",
    headers: headers(config.ingestToken),
    body: JSON.stringify(request),
  });
}

export async function postBatch(config: IngestClientConfig, conversations: IngestRequest[]): Promise<{ ok: boolean }> {
  const serverUrl = assertSecureServerUrl(config.serverUrl).replace(/\/$/, "");
  return requestJson(`${serverUrl}/ingest/batch`, {
    method: "POST",
    headers: headers(config.ingestToken),
    body: JSON.stringify({ conversations }),
  });
}

export async function getSyncStatus(
  config: IngestClientConfig,
  provider?: ProviderId
): Promise<{ ok: boolean; providers: SyncProviderStatus[] }> {
  const url = new URL(`${assertSecureServerUrl(config.serverUrl).replace(/\/$/, "")}/ingest/status`);
  if (provider) url.searchParams.set("provider", provider);
  return requestJson(url.toString(), {
    method: "GET",
    headers: headers(config.ingestToken, "application/json"),
  });
}

export async function getHealth(config: IngestClientConfig): Promise<{ ok: boolean }> {
  const serverUrl = assertSecureServerUrl(config.serverUrl).replace(/\/$/, "");
  return requestJson(`${serverUrl}/health`, {
    method: "GET",
    headers: headers(config.ingestToken, "application/json"),
  });
}
