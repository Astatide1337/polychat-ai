import { Command } from "commander";
import { loadConfig } from "../config/index.js";
import { isServerRunning } from "../utils/binary.js";

export function registerModelsCommand(program: Command) {
  program
    .command("models")
    .description("List available models")
    .action(async () => {
      const config = loadConfig();
      const serverUrl = process.env.POLYCHAT_SERVER_URL ?? `http://${config.server.host}:${config.server.port}`;

      if (!(await isServerRunning(serverUrl))) {
        console.error(
          `Polychat server is not running at ${serverUrl}.\n` +
          `Start it with: polychat serve`
        );
        process.exitCode = 1;
        return;
      }

      let models: Array<{ id: string; name: string; owned_by: string }> = [];
      try {
        const res = await fetch(`${serverUrl}/v1/models`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const payload = await res.json() as { data?: Array<{ id: string; name?: string; owned_by?: string }> };
        models = (payload.data ?? []).map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          owned_by: m.owned_by ?? "unknown",
        }));
      } catch (err) {
        console.error(`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }

      if (models.length === 0) {
        console.log("No connected provider models found.");
        return;
      }

      const widths = {
        provider: Math.max("Provider".length, ...models.map((m) => m.owned_by.length)),
        id: Math.max("Model".length, ...models.map((m) => m.id.length)),
        name: Math.max("Name".length, ...models.map((m) => m.name.length)),
      };

      const header = [
        pad("Provider", widths.provider),
        pad("Model", widths.id),
        pad("Name", widths.name),
      ].join("  ");
      console.log(header);
      console.log("─".repeat(header.length));
      for (const model of models) {
        console.log([
          pad(model.owned_by, widths.provider),
          pad(model.id, widths.id),
          pad(model.name, widths.name),
        ].join("  "));
      }
    });
}

function pad(value: string, width: number) {
  return value + " ".repeat(Math.max(0, width - value.length));
}
