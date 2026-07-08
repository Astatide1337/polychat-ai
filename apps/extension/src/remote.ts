import { permissionsRequest } from "./webext.js";

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function validateServerUrl(value: string): string {
  const url = new URL(value.trim() || "http://127.0.0.1:3333");
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) {
    return url.toString();
  }
  throw new Error("Use https:// for remote servers, or http://127.0.0.1 / http://localhost for local development");
}

export function serverOriginPattern(serverUrl: string): string | null {
  const url = new URL(serverUrl);
  if (url.protocol !== "https:" || isLoopbackHostname(url.hostname)) return null;
  if (url.hostname === "polychat.astatide.com") return null;
  return `${url.protocol}//${url.host}/*`;
}

export async function ensureServerPermission(serverUrl: string): Promise<void> {
  const originPattern = serverOriginPattern(serverUrl);
  if (!originPattern) return;
  const granted = await permissionsRequest({ origins: [originPattern] });
  if (!granted) {
    throw new Error(`Permission required to access ${new URL(serverUrl).origin}`);
  }
}
