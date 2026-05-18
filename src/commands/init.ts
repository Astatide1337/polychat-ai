import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Command } from "commander";
import { getConfigDir, getSessionDir, loadConfig } from "../config/index.js";

function ensureSecretFile(envFile: string): boolean {
	if (existsSync(envFile)) {
		try {
			chmodSync(envFile, 0o600);
		} catch {
			// Best effort on platforms that do not support POSIX permissions.
		}
		return false;
	}

	const secret = randomBytes(32).toString("hex");
	writeFileSync(
		envFile,
		[
			"# Polychat local secrets. Do not share this file.",
			`POLYCHAT_SECRET_KEY=${secret}`,
			"# Optional: require clients to send Authorization: Bearer <value>",
			"# POLYCHAT_API_KEY=",
			"",
		].join("\n"),
		{ mode: 0o600 },
	);
	try {
		chmodSync(envFile, 0o600);
	} catch {
		// Best effort on platforms that do not support POSIX permissions.
	}
	return true;
}

export function registerInitCommand(program: Command) {
	program
		.command("init")
		.description("Create local Polychat config and secret files")
		.action(() => {
			const configDir = getConfigDir();
			const sessionDir = getSessionDir();
			mkdirSync(configDir, { recursive: true });
			mkdirSync(sessionDir, { recursive: true });

			const envFile = join(configDir, ".env");
			const createdSecret = ensureSecretFile(envFile);
			const config = loadConfig();

			console.log("Polychat initialized.");
			console.log(`Config: ${join(configDir, "config.json")}`);
			console.log(`Sessions: ${sessionDir}`);
			console.log(`Secrets: ${envFile}${createdSecret ? " (created)" : " (already exists)"}`);
			console.log(`Server: http://${config.server.host}:${config.server.port}`);
		});
}
