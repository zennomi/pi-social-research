import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildHelpText, parseSubcommand } from "./commands.js";
import { EXTENSION_COMMAND } from "./constants.js";
import { createXClient, type XClient } from "./x/client.js";
import { registerXTools } from "./x/tools.js";

/** Absolute path of the bundled skills directory, also discovered with bare pi -e loading. */
export const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

export default function socialResearch(pi: ExtensionAPI): void {
  let client: XClient | undefined;
  let clientKey: string | undefined;
  function getClient(): XClient {
    const apiKey = process.env.RAPIDAPI_KEY;
    if (!client || clientKey !== apiKey) {
      client = createXClient({ apiKey });
      clientKey = apiKey;
    }
    return client;
  }

  function status(): string {
    const key = process.env.RAPIDAPI_KEY?.trim() ? "set" : "missing";
    const remaining = getClient().rateLimit.remaining;
    return `RAPIDAPI_KEY: ${key}\nRate limit remaining: ${remaining ?? "unknown (no request yet)"}`;
  }

  pi.on("resources_discover", () => ({ skillPaths: [SKILLS_DIR] }));

  pi.registerCommand(EXTENSION_COMMAND, {
    description: "Social research help and X API credential/rate-limit status",
    getArgumentCompletions(prefix) {
      const matches = ["status", "help"].filter((option) =>
        option.startsWith(prefix.toLowerCase())
      );
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler(args, ctx) {
      const { name } = parseSubcommand(args);
      notify(ctx, name === "status" ? status() : buildHelpText());
      return Promise.resolve();
    },
  });
  registerXTools(pi, getClient);
}

/** Keep stdout clean in print/JSON modes. */
function notify(ctx: Pick<ExtensionContext, "hasUI" | "ui">, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "info");
  else console.error(message);
}
