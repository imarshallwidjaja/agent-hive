import { HIVE_COMMANDS, type HiveCommandKey } from './registry.js';
import type { HiveCommandMetadata } from './types.js';
import type {
  HiveCommandContextFactory,
  HiveCommandRenderers,
  HiveRuntimeCommandMap,
} from './types.js';

export function buildHiveCommandMap(
  renderers: HiveCommandRenderers<HiveCommandKey>,
  createContext: HiveCommandContextFactory,
): HiveRuntimeCommandMap {
  return Object.fromEntries(
    HIVE_COMMANDS.map((command) => [
      command.key,
      {
        description: command.description,
        ...((command as HiveCommandMetadata).agent ? { agent: (command as HiveCommandMetadata).agent } : {}),
        run(args: string) {
          return renderers[command.key](args, createContext());
        },
      },
    ]),
  );
}
