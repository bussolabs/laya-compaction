import { LayaClient, type LayaClientOptions } from './client.js';
import { compact } from './compact.js';
import { LOCAL_MODEL } from './local-server.js';
import { startLocalServer, type LocalServerOptions } from './local.js';
import { DEFAULT_MAX_LEN } from './request.js';
import type { CompactOptions, CompactResult, Message } from './types.js';

export type CompactMessagesOptions = CompactOptions & LayaClientOptions & LocalServerOptions;

/**
 * `compact` with Laya: over HTTP to `laya-serve` at `url` (or `LAYA_URL`), or,
 * when neither is set, to the shared local server, started on demand.
 */
export async function compactMessages(
  messages: readonly Message[],
  options: CompactMessagesOptions = {},
): Promise<CompactResult> {
  const maxLen = options.maxLen ?? DEFAULT_MAX_LEN;
  const remote = options.url ?? (process.env.LAYA_URL || undefined);
  const client = remote
    ? new LayaClient({ ...options, url: remote, maxLen })
    : new LayaClient({
        url: await startLocalServer(options),
        apiKey: '',
        model: LOCAL_MODEL,
        maxLen,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        fetch: options.fetch,
      });
  return compact(messages, client, { ...options, maxLen });
}
