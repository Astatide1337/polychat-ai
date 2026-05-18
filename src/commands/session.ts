import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getSessionDir, loadConfig } from "../config/index.js";
import { decrypt, getEncryptionKey, sealForTransport, type TransportEnvelope } from "../session/crypto.js";
import { PROVIDERS } from "../config/index.js";

const VALID_PROVIDERS = Object.keys(PROVIDERS);

export function registerSessionCommand(program: Command) {
  const session = program
    .command("session")
    .description("Manage and transfer provider sessions");

  // ── polychat session export <provider> ────────────────────────────────────
  session
    .command("export <provider>")
    .description(
      "Export a sealed session blob for pushing to a remote server.\n" +
      "Requires POLYCHAT_SECRET_KEY (local) and --api-key (remote server key).\n" +
      "The blob is encrypted for that server; only it can unseal it.",
    )
    .requiredOption(
      "--api-key <key>",
      "POLYCHAT_API_KEY of the target server (used to seal the blob for that server only)",
    )
    .action(async (provider: string, opts: { apiKey: string }) => {
      try {
        validateProvider(provider);
        const sessionPath = join(getSessionDir(), `${provider}.enc`);
        if (!existsSync(sessionPath)) {
          console.error(`✗ No session found for "${provider}". Run: polychat login ${provider}`);
          process.exitCode = 1;
          return;
        }

        const localKey = getEncryptionKey();
        const encrypted = readFileSync(sessionPath);
        const sessionJson = decrypt(encrypted, localKey);

        // Validate the decrypted session has the expected shape before exporting
        const parsed = JSON.parse(sessionJson);
        if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
          throw new Error("Session file is corrupt or in an unrecognised format");
        }

        const { sessionSalt } = loadConfig();
        const envelope = sealForTransport(sessionJson, provider, opts.apiKey, sessionSalt);
        // Print JSON to stdout — caller pipes it to polychat session push or saves it
        console.log(JSON.stringify(envelope));
      } catch (err) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  // ── polychat session push <provider> <server-url> ─────────────────────────
  session
    .command("push <provider> <server-url>")
    .description(
      "Push a local session to a remote Polychat server.\n" +
      "The server must be running and have POLYCHAT_API_KEY set.\n\n" +
      "Example:\n" +
      "  polychat session push claude https://my-server.com --api-key sk-...",
    )
    .requiredOption(
      "--api-key <key>",
      "POLYCHAT_API_KEY configured on the remote server",
    )
    .option(
      "--insecure",
      "Allow plain HTTP (not recommended — only for localhost testing)",
      false,
    )
    .action(async (provider: string, serverUrl: string, opts: { apiKey: string; insecure: boolean }) => {
      try {
        validateProvider(provider);
        const url = normalizeServerUrl(serverUrl);

        if (!opts.insecure && !url.startsWith("https://")) {
          console.error(
            "✗ Refusing to push session over plain HTTP.\n" +
            "  Use an HTTPS URL or pass --insecure if you are on localhost.\n" +
            "  Sessions contain authentication credentials — always use TLS in production.",
          );
          process.exitCode = 1;
          return;
        }

        const sessionPath = join(getSessionDir(), `${provider}.enc`);
        if (!existsSync(sessionPath)) {
          console.error(`✗ No session found for "${provider}". Run: polychat login ${provider}`);
          process.exitCode = 1;
          return;
        }

        const localKey = getEncryptionKey();
        const encrypted = readFileSync(sessionPath);
        const sessionJson = decrypt(encrypted, localKey);

        const parsed = JSON.parse(sessionJson);
        if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
          throw new Error("Session file is corrupt or in an unrecognised format");
        }

        // Seal using the target server's salt — we fetch it from /health first
        // (health is public, no auth required). The salt is used to bind the
        // transport key to this specific server instance.
        process.stdout.write(`Connecting to ${url}…\n`);
        const healthRes = await fetch(`${url}/health`, {
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null);

        if (!healthRes || !healthRes.ok) {
          console.error(
            `✗ Could not reach ${url}/health.\n` +
            "  Make sure polychat serve is running on the target server.",
          );
          process.exitCode = 1;
          return;
        }

        const health = await healthRes.json().catch(() => null) as { status?: string; session_salt?: string } | null;
        if (health?.status !== "ok") {
          console.error("✗ Server health check failed");
          process.exitCode = 1;
          return;
        }

        // The server exposes its sessionSalt in /health only when POLYCHAT_API_KEY is set
        // (it is safe to expose because the salt alone is useless without the secret key).
        // If not present, we use a fixed placeholder — the server will derive the transport
        // key consistently as long as its salt matches.
        const serverSalt = health.session_salt ?? "default-salt";

        const envelope = sealForTransport(sessionJson, provider, opts.apiKey, serverSalt);

        process.stdout.write(`Pushing ${provider} session…\n`);
        const pushRes = await fetch(`${url}/v1/sessions/${provider}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(30_000),
        });

        if (!pushRes.ok) {
          const body = await pushRes.json().catch(() => ({ error: { message: `HTTP ${pushRes.status}` } })) as { error?: { message?: string } };
          console.error(`✗ Push failed: ${body.error?.message ?? `HTTP ${pushRes.status}`}`);
          process.exitCode = 1;
          return;
        }

        const result = await pushRes.json() as { provider?: string };
        console.log(`✓ ${provider} session pushed to ${url}`);
        console.log(`  Provider: ${result.provider ?? provider}`);
        console.log("  Run 'polychat status' on the server to verify.");
      } catch (err) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

}

function validateProvider(provider: string) {
  if (!VALID_PROVIDERS.includes(provider)) {
    throw new Error(
      `Unknown provider "${provider}". Available: ${VALID_PROVIDERS.join(", ")}`,
    );
  }
}

function normalizeServerUrl(raw: string): string {
  // Strip trailing slash
  return raw.replace(/\/+$/, "");
}
