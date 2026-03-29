import type { CommandHandler } from "../core/command-router.js";
import type { PlatformMessage } from "../platforms/types.js";

export interface CommandDef {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
  hidden?: boolean;
  execute: CommandHandler;
}

const registry = new Map<string, CommandDef>();

export function registerCommand(def: CommandDef): void {
  registry.set(def.name, def);
  if (def.aliases) {
    for (const alias of def.aliases) {
      registry.set(alias, def);
    }
  }
}

export function getRegistry(): Map<string, CommandDef> {
  return registry;
}

export function getUniqueCommands(): CommandDef[] {
  const seen = new Set<string>();
  const commands: CommandDef[] = [];
  for (const [, cmd] of registry) {
    if (!seen.has(cmd.name) && !cmd.hidden) {
      seen.add(cmd.name);
      commands.push(cmd);
    }
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}
