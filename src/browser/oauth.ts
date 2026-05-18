import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { openUrlInDefaultBrowser } from "./external.js";
import { saveSession } from "../session/store.js";
import { loadConfig, saveConfig } from "../config/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthProviderConfig {
  id: string;
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string; // optional — public clients don't need it, installed apps may include it
  redirectUri: string;
  scopes: string[];
}

// ---------------------------------------------------------------------------
// Pre-configured OAuth providers
// ---------------------------------------------------------------------------

export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  claude: {
    id: "claude",
    name: "Claude",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    redirectUri: "http://localhost:53692/callback",
    scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
  },

  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    redirectUri: "http://localhost:1455/auth/callback",
    scopes: ["openid", "profile", "email", "offline_access"],
  },


};
// ---------------------------------------------------------------------------
// PKCE helpers (Web Crypto)
// ---------------------------------------------------------------------------

/** Base64url-encode an ArrayBuffer (no padding, URL-safe alphabet). */
function base64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a 32-byte random PKCE verifier (base64url-encoded). */
async function generateVerifier(): Promise<string> {
  const buffer = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return base64url(buffer.buffer as ArrayBuffer);
}

/** Compute the S256 PKCE code challenge from a verifier. */
async function computeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return base64url(digest);
}

// ---------------------------------------------------------------------------
// Callback HTML responses
// ---------------------------------------------------------------------------

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Login successful</title></head>
<body style="font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0">
<div style="text-align:center"><h1>&#x2705; Login successful!</h1><p>You can close this tab and return to polychat.</p></div>
</body></html>`;

const ERROR_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Login failed</title></head>
<body style="font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0">
<div style="text-align:center"><h1>&#x274c; Login failed</h1><p id="msg"></p></div>
<script>const p=new URLSearchParams(location.search);document.getElementById("msg").textContent=p.get("error_description")||p.get("error")||"Unknown error";</script>
</body></html>`;

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

async function exchangeCodeForTokens(
  provider: OAuthProviderConfig,
  code: string,
  verifier: string,
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: provider.clientId,
    redirect_uri: provider.redirectUri,
    code_verifier: verifier,
    ...(provider.clientSecret ? { client_secret: provider.clientSecret } : {}),
  });

  const response = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Token exchange failed (HTTP ${response.status}): ${body}`,
    );
  }

  return (await response.json()) as TokenResponse;
}

// ---------------------------------------------------------------------------
// Main login flow
// ---------------------------------------------------------------------------

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Run the OAuth PKCE login flow for a provider.
 *
 * 1. Generate PKCE verifier + challenge (Web Crypto)
 * 2. Start local HTTP server on the provider's redirect port
 * 3. Open authorization URL in default browser
 * 4. Wait for callback with code (timeout: 5 minutes)
 * 5. Exchange code for access + refresh tokens
 * 6. Save session as { type: "oauth", access_token, refresh_token, expires_at }
 * 7. Update config connected flag
 */
export async function loginWithOAuth(providerId: string): Promise<void> {
  const provider = OAUTH_PROVIDERS[providerId];
  if (!provider) {
    throw new Error(`Unknown OAuth provider: ${providerId}`);
  }

  // 1. PKCE
  const verifier = await generateVerifier();
  const challenge = await computeChallenge(verifier);

  // 2. Derive the callback port from redirect URI
  const redirectUrl = new URL(provider.redirectUri);
  const callbackPort = Number(redirectUrl.port);

  // 3. Start local HTTP server to receive the callback
  const { promise: codePromise, resolve: resolveCode, reject: rejectCode } =
    promiseWithResolvers<string>();

  const server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const reqUrl = new URL(req.url ?? "/", provider.redirectUri);

      const code = reqUrl.searchParams.get("code");
      const error = reqUrl.searchParams.get("error");

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(SUCCESS_HTML);
        resolveCode(code);
      } else {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(ERROR_HTML);
        rejectCode(
          new Error(
            `OAuth callback error: ${error ?? "no code returned"}`,
          ),
        );
      }

      // Close server immediately after handling the callback
      server.close();
    },
  );

  server.listen(callbackPort, "127.0.0.1");

  // 4. Build authorization URL and open browser
  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: provider.clientId,
    redirect_uri: provider.redirectUri,
    scope: provider.scopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  const authUrl = `${provider.authorizeUrl}?${authParams.toString()}`;
  openUrlInDefaultBrowser(authUrl);
  console.log(`\nOpening browser for ${provider.name} login...`);
  console.log(`If the browser does not open, visit:\n${authUrl}\n`);

  // 5. Wait for callback (with timeout)
  let timeoutId!: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      server.close();
      reject(
        new Error(
          `OAuth login timed out after 5 minutes waiting for callback from ${provider.name}`,
        ),
      );
    }, CALLBACK_TIMEOUT_MS);
  });

  let code: string;
  try {
    code = await Promise.race([codePromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
    // Ensure server is closed even if we resolved before the timeout
    server.close();
  }

  // 6. Exchange code for tokens
  const tokens = await exchangeCodeForTokens(provider, code, verifier);

  // 7. Save session
  const expiresAt =
    Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 3600);

  saveSession(provider.id, {
    type: "oauth",
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
    expires_at: expiresAt,
  });

  // 8. Update config connected flag
  const config = loadConfig();
  if (config.providers[provider.id]) {
    config.providers[provider.id].connected = true;
    saveConfig(config);
  }
}

// ---------------------------------------------------------------------------
// Utility: Promise.withResolvers polyfill (Node < 22 compat)
// ---------------------------------------------------------------------------

function promiseWithResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
