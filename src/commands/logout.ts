import { Command } from "commander";
import { loadConfig, saveConfig, PROVIDERS, type ProviderKey } from "../config/index.js";
import { deleteSession } from "../session/store.js";

export function registerLogoutCommand(program: Command) {
  program
    .command("logout [provider]")
    .description("Log out of a provider or all providers")
    .option("--all", "Log out of all providers")
    .action((provider: string | undefined, options: { all?: boolean }) => {
      const config = loadConfig();

      if (options.all) {
        for (const key of Object.keys(PROVIDERS) as ProviderKey[]) {
          deleteSession(key);
          config.providers[key].connected = false;
          config.providers[key].lastValidated = null;
        }
        saveConfig(config);
        console.log("Logging out of all providers...");
        return;
      }

      if (!provider) {
        console.log("Logging out of all providers...");
        return;
      }

      if (!(provider in PROVIDERS)) {
        console.error(`Unknown provider "${provider}". Available: ${Object.keys(PROVIDERS).join(", ")}`);
        process.exitCode = 1;
        return;
      }

      deleteSession(provider);
      config.providers[provider].connected = false;
      config.providers[provider].lastValidated = null;
      saveConfig(config);
      console.log(`✓ Logged out of ${PROVIDERS[provider as ProviderKey].name}.`);
    });
}
