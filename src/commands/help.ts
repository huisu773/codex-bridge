import { registerCommand } from "./registry.js";
import { getUniqueCommands } from "./registry.js";

export function registerHelpCommand(): void {
  registerCommand({
    name: "help",
    aliases: ["h"],
    description: "Show all available commands",
    usage: "/help [command]",
    execute: async (_msg, args, sendReply) => {
      if (args) {
        // Show help for a specific command
        const commands = getUniqueCommands();
        const cmd = commands.find(
          (c) => c.name === args.toLowerCase() || c.aliases?.includes(args.toLowerCase()),
        );
        if (cmd) {
          const aliases = cmd.aliases?.length ? ` (aliases: ${cmd.aliases.join(", ")})` : "";
          await sendReply(
            `📖 /${cmd.name}${aliases}\n\n${cmd.description}\n\nUsage: ${cmd.usage}`,
          );
        } else {
          await sendReply(`❌ Unknown command: ${args}\nUse /help to see all commands.`);
        }
        return;
      }

      const commands = getUniqueCommands();
      const lines = [
        "📋 **Available Commands**\n",
        ...commands.map(
          (c) => `  /${c.name} — ${c.description}`,
        ),
        "",
        "💡 Send any text without a command prefix to chat with Codex directly.",
        "📖 Use /help <command> for detailed usage.",
      ];
      await sendReply(lines.join("\n"));
    },
  });
}
