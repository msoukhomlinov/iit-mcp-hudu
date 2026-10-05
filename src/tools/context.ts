/**
 * tools/context.ts — what the tool registrations share: the caller's deps and the per-server values
 * `registerTools` derives from them once.
 */
import type { HuduClient } from 'node-hudu';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';

/**
 * Read tools share the read client; enabled mutation dispatchers each have a distinct SDK client.
 */
export interface ToolDeps {
  hudu: HuduClient;
  /** Origin selected with the dispatched client; absent on every fail-closed placeholder. */
  huduOrigin?: string;
  mutationClients?: { write: HuduClient; delete: HuduClient };
  /** The deployment's write policy — the authority this server enforces before the SDK governor. */
  config: Config;
  /** Sink for the one line a policy refusal writes (the audit hook never sees a refused call). */
  log: Logger;
}

/** `ToolDeps` plus the search policy `registerTools` derives from it; see there for each value. */
export interface ToolContext extends ToolDeps {
  ops: HuduClient['operations'];
  searchableResources: string[];
  defaultSearchScope: string[];
  indexSearchable: boolean;
  toolDefaultTier: 'auto' | 'vendor' | 'index';
}
