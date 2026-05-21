import chalk from "chalk";
import { Command } from "commander";
import { loadConfig, saveConfig, PROVIDERS, type ProviderKey } from "../config/index.js";

export function registerTemporaryCommand(program: Command) {
  program
    .command("temporary [provider]")
    .description("Toggle temporary chat for a provider — conversations won't be saved to provider history")
    .option("--on", "Enable temporary chat")
    .option("--off", "Disable temporary chat")
    .option("--all", "Apply to all providers")
    .action((provider: string | undefined, options: { on?: boolean; off?: boolean; all?: boolean }) => {
      const config = loadConfig();

      if (options.all) {
        const newValue = options.on ? true : options.off ? false : undefined;
        if (newValue === undefined) {
          console.error("Specify --on or --off when using --all.");
          process.exitCode = 1;
          return;
        }
        for (const key of Object.keys(PROVIDERS) as ProviderKey[]) {
          config.providers[key].temporary = newValue;
        }
        saveConfig(config);
        const label = newValue ? chalk.yellow("temporary") : chalk.green("persistent");
        console.log(`All providers set to ${label} chat.`);
        return;
      }

      if (!provider) {
        // Show current temporary status for all providers
        const rows: Array<{ provider: string; temporary: string }> = [];
        for (const [key, info] of Object.entries(PROVIDERS)) {
          const isTemp = config.providers[key]?.temporary ?? false;
          const label = isTemp ? chalk.yellow("temporary") : chalk.green("persistent");
          rows.push({ provider: info.name, temporary: label });
        }
        const width = Math.max("Provider".length, ...rows.map((r) => stripAnsi(r.provider).length));
        console.log(pad("Provider", width) + "  Chat Mode");
        console.log("─".repeat(width + 2 + 10));
        for (const row of rows) {
          console.log(pad(row.provider, width) + "  " + row.temporary);
        }
        return;
      }

      if (!(provider in PROVIDERS)) {
        console.error(`Unknown provider "${provider}". Available: ${Object.keys(PROVIDERS).join(", ")}`);
        process.exitCode = 1;
        return;
      }

      const current = config.providers[provider]?.temporary ?? false;

      if (options.on) {
        config.providers[provider].temporary = true;
        saveConfig(config);
        console.log(`✓ ${PROVIDERS[provider as ProviderKey].name} set to ${chalk.yellow("temporary")} chat — conversations won't be saved to history.`);
      } else if (options.off) {
        config.providers[provider].temporary = false;
        saveConfig(config);
        console.log(`✓ ${PROVIDERS[provider as ProviderKey].name} set to ${chalk.green("persistent")} chat — conversations will be saved to history.`);
      } else {
        // Toggle
        const newValue = !current;
        config.providers[provider].temporary = newValue;
        saveConfig(config);
        const label = newValue ? chalk.yellow("temporary") : chalk.green("persistent");
        console.log(`✓ ${PROVIDERS[provider as ProviderKey].name} toggled to ${label} chat.`);
      }
    });
}

function pad(value: string, width: number) {
  return value + " ".repeat(Math.max(0, width - stripAnsi(value).length));
}

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
