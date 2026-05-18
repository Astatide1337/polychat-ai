import { Command } from "commander";
import { loadConfig } from "../config/index.js";
import { canonicalModelId, modelMatches } from "../utils/model-aliases.js";

type VerifyStatus = "pass" | "warn" | "fail";

interface VerifyCheck {
  name: string;
  status: VerifyStatus;
  message: string;
}

interface ListedModel {
  id: string;
  owned_by?: string;
}

interface HealthProviderStatus {
  connected?: boolean;
  defaultModel?: string;
}

interface HealthResponse {
  status?: string;
  providers?: Record<string, HealthProviderStatus>;
}

function authHeaders(): Record<string, string> {
  const apiKey = process.env.POLYCHAT_API_KEY?.trim();
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function modelAvailable(requested: string, models: ListedModel[]): ListedModel | null {
  return models.find((model) => modelMatches(requested, model.id)) ?? null;
}

function formatModelMessage(requested: string, matched: string): string {
  const canonical = canonicalModelId(requested);
  if (requested === matched || canonical === null || canonical === requested) {
    return matched;
  }
  return `${requested} -> ${matched}`;
}

export function registerVerifyCommand(program: Command) {
  program
    .command("verify")
    .description("Verify a running Polychat server and its configured models")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const config = loadConfig();
      const baseUrl = process.env.POLYCHAT_SERVER_URL ?? `http://${config.server.host}:${config.server.port}`;
      const checks: VerifyCheck[] = [];

      let health: HealthResponse | null = null;
      try {
        const res = await fetch(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
          checks.push({ name: "health", status: "fail", message: `Server returned ${res.status}` });
        } else {
          health = await res.json() as HealthResponse;
          checks.push({ name: "health", status: health?.status === "ok" ? "pass" : "fail", message: `${baseUrl}/health` });
        }
      } catch (error) {
        checks.push({
          name: "health",
          status: "fail",
          message: error instanceof Error ? error.message : String(error),
        });
      }

      let models: ListedModel[] = [];
      try {
        const res = await fetch(`${baseUrl}/v1/models`, {
          headers: authHeaders(),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          checks.push({ name: "models", status: "fail", message: `Server returned ${res.status}` });
        } else {
          const payload = await res.json() as { data?: ListedModel[] };
          models = payload.data ?? [];
          checks.push({
            name: "models",
            status: models.length > 0 ? "pass" : "warn",
            message: models.length > 0 ? `${models.length}` : "empty",
          });
        }
      } catch (error) {
        checks.push({
          name: "models",
          status: "fail",
          message: error instanceof Error ? error.message : String(error),
        });
      }

      const topLevelModel = modelAvailable(config.defaultModel, models);
      if (topLevelModel) {
        checks.push({
          name: "default-model",
          status: "pass",
          message: formatModelMessage(config.defaultModel, topLevelModel.id),
        });
      } else {
        checks.push({ name: "default-model", status: "warn", message: `${config.defaultModel} is not currently available` });
      }

      for (const [providerId, providerConfig] of Object.entries(config.providers)) {
        const providerHealth = health?.providers?.[providerId];
        const providerModels = models.filter((model) => model.owned_by === providerId);

        if (!providerConfig.connected) {
          checks.push({ name: `provider:${providerId}`, status: "warn", message: "disabled" });
          continue;
        }

        if (providerHealth?.connected === false) {
          checks.push({ name: `provider:${providerId}`, status: "fail", message: "not loaded" });
          continue;
        }

        if (providerModels.length === 0) {
          checks.push({ name: `provider:${providerId}`, status: "warn", message: "no models" });
          continue;
        }

        const matchedModel = modelAvailable(providerConfig.defaultModel, providerModels);
        if (matchedModel) {
          checks.push({
            name: `provider:${providerId}`,
            status: "pass",
            message: formatModelMessage(providerConfig.defaultModel, matchedModel.id),
          });
        } else {
          checks.push({ name: `provider:${providerId}`, status: "warn", message: `${providerConfig.defaultModel} missing` });
        }
      }

      const ok = checks.every((check) => check.status !== "fail");
      if (options.json) {
        console.log(JSON.stringify({ ok, baseUrl, checks }, null, 2));
      } else {
        for (const check of checks) {
          const marker = check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗";
          console.log(`${marker} ${check.name}: ${check.message}`);
        }
      }

      if (!ok) process.exitCode = 1;
    });
}
