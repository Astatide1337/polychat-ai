import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { detectBrowserKind } from "../browser/detect.js";
import { PROVIDERS, loadConfig } from "../config/index.js";
import { hasSession, loadSession } from "../session/store.js";
import { resolveBinary } from "../utils/binary.js";
import { canonicalModelId } from "../utils/model-aliases.js";

type CheckStatus = "pass" | "warn" | "fail";

interface DoctorCheck {
	name: string;
	status: CheckStatus;
	message: string;
}

function readEnvSecret(): string | null {
	const envFile = join(homedir(), ".polychat", ".env");
	if (!existsSync(envFile)) return null;
	const lines = readFileSync(envFile, "utf8").split(/\r?\n/);
	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		if (line.slice(0, eq).trim() === "POLYCHAT_SECRET_KEY") {
			return line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
		}
	}
	return null;
}

async function runDoctorChecks(): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	let config: ReturnType<typeof loadConfig> | null = null;

	try {
		config = loadConfig();
		checks.push({ name: "config", status: "pass", message: `Loaded config for ${Object.keys(config.providers).length} providers` });
	} catch (error) {
		checks.push({ name: "config", status: "fail", message: error instanceof Error ? error.message : String(error) });
	}

	if (config) {
		const port = config.server.port;
		if (Number.isInteger(port) && port >= 1 && port <= 65535) {
			checks.push({ name: "server-config", status: "pass", message: `${config.server.host}:${port}` });
		} else {
			checks.push({ name: "server-config", status: "fail", message: `Invalid server port: ${String(port)}` });
		}

		const topLevelAlias = canonicalModelId(config.defaultModel);
		checks.push({
			name: "default-model",
			status: topLevelAlias ? "warn" : "pass",
			message: topLevelAlias ? `${config.defaultModel} -> ${topLevelAlias}` : config.defaultModel,
		});

		for (const providerId of Object.keys(PROVIDERS)) {
			const configured = config.providers[providerId]?.defaultModel;
			if (!configured) {
				checks.push({ name: `provider-default:${providerId}`, status: "warn", message: "No default model configured" });
				continue;
			}

			const alias = canonicalModelId(configured);
			checks.push({
				name: `provider-default:${providerId}`,
				status: alias ? "warn" : "pass",
				message: alias ? `${configured} -> ${alias}` : configured,
			});
		}
	}

	const secret = process.env.POLYCHAT_SECRET_KEY ?? readEnvSecret();
	if (secret && secret.length >= 32) {
		checks.push({ name: "secret", status: "pass", message: "configured" });
	} else {
		checks.push({ name: "secret", status: "fail", message: "Run `polychat init` to create ~/.polychat/.env" });
	}

	try {
		checks.push({ name: "server-binary", status: "pass", message: resolveBinary() });
	} catch (error) {
		checks.push({ name: "server-binary", status: "fail", message: error instanceof Error ? error.message : String(error) });
	}

	try {
		const browser = await detectBrowserKind();
		if (browser.kind === "unsupported") {
			checks.push({ name: "browser", status: "warn", message: browser.unsupportedReason ?? "Unsupported default browser" });
		} else {
			checks.push({ name: "browser", status: "pass", message: `${browser.kind}: ${browser.name}` });
		}
	} catch (error) {
		checks.push({ name: "browser", status: "warn", message: error instanceof Error ? error.message : String(error) });
	}

	for (const provider of Object.keys(PROVIDERS)) {
		try {
			if (!hasSession(provider)) {
				checks.push({ name: `session:${provider}`, status: "warn", message: "missing" });
				continue;
			}
			loadSession(provider);
			checks.push({ name: `session:${provider}`, status: "pass", message: "ok" });
		} catch (error) {
			checks.push({ name: `session:${provider}`, status: "fail", message: error instanceof Error ? error.message : String(error) });
		}
	}

	if (process.env.POLYCHAT_API_KEY?.trim()) {
		checks.push({ name: "api-key", status: "pass", message: "configured" });
	} else {
		checks.push({ name: "api-key", status: "warn", message: "unset" });
	}

	return checks;
}

export function registerDoctorCommand(program: Command) {
	program
		.command("doctor")
		.description("Check local Polychat installation health")
		.option("--json", "Print machine-readable JSON")
		.action(async (options: { json?: boolean }) => {
			const checks = await runDoctorChecks();
			const ok = checks.every((check) => check.status !== "fail");

			if (options.json) {
				console.log(JSON.stringify({ ok, checks }, null, 2));
			} else {
				for (const check of checks) {
					const marker = check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗";
					console.log(`${marker} ${check.name}: ${check.message}`);
				}
			}

			if (!ok) process.exitCode = 1;
		});
}
