import type {
  EngineInterface,
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import {
  ensureLocalServer,
  LOCAL_MODEL,
  localPort,
  type LocalServerDriver,
} from '../src/local-server.js';
import { buildLayaRequest, DEFAULT_MAX_LEN, parseLayaResponse } from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  LayaAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
};

/** How long a health probe may take before the server counts as down. */
const HEALTH_TIMEOUT_MS = 2_000;

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  url?: string;
  apiKey?: string;
  model?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  /** Local mode only: port of the shared server (`LAYA_LOCAL_PORT`). */
  localPort?: number;
  /** Local mode only: fine-tuned checkpoint directory (`LAYA_MODEL_DIR`). */
  modelDir?: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxLen',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
  };
  for (const key of ['url', 'apiKey', 'model'] as const) {
    const value = optionString(options, key);
    if (value) config[key] = value;
  }
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `LayaAsker` over the engine's `$.http.fetch`, for a `laya-serve` server. */
export function layaAsker(
  fetchFn: HookFetch,
  params: { url: string; apiKey?: string; model?: string; maxLen?: number },
): LayaAsker {
  return {
    async ask(state, questions) {
      const request = buildLayaRequest(params, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseLayaResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

export type HookLocal = {
  driver: LocalServerDriver;
  /** `$.plugin.root`: the plugin directory, which ships `serve/laya_serve.py`. */
  root: string;
};

/**
 * Runs the library over a session transcript: remote when `config.url` is set,
 * otherwise through the shared local server, started when it is down. Throws
 * when Laya fails, so the hook falls back.
 */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
  local?: HookLocal,
): Promise<SessionCompaction> {
  const maxLen = config.maxLen ?? DEFAULT_MAX_LEN;
  let asker: LayaAsker;
  if (config.url) {
    asker = layaAsker(fetchFn, { url: config.url, apiKey: config.apiKey, model: config.model, maxLen });
  } else if (local) {
    const url = await ensureLocalServer(local.driver, {
      root: local.root,
      port: localPort(config.localPort),
      checkpoint: config.modelDir,
    });
    asker = layaAsker(fetchFn, { url, model: LOCAL_MODEL, maxLen });
  } else {
    throw new Error('LAYA_URL is not configured and the local server cannot be started here');
  }
  const result = await compact(messages, asker, { ...config, maxLen });
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

/**
 * The local-server driver over the engine: `$.http.fetch` for health,
 * `$.process.run` for the spawn script (it backgrounds the server and returns
 * at once), `$.clock` for waiting.
 */
function hookDriver($: EngineInterface, signal?: AbortSignal): LocalServerDriver {
  return {
    async health(url) {
      try {
        const health = $.http.fetch(`${url}/health`);
        const timeout = $.clock.sleep(HEALTH_TIMEOUT_MS).then(() => undefined);
        const response = await Promise.race([health, timeout]);
        return response?.ok ?? false;
      } catch {
        return false;
      }
    },
    async spawn(argv) {
      const result = await $.process.run(argv, { timeoutMs: 30_000 });
      return { exitCode: result.exitCode, stderr: result.stderr };
    },
    sleep: (ms) => $.clock.sleep(ms, signal ? { signal } : undefined),
    now: () => $.clock.now(),
  };
}

type EnvReader = {
  env: { get: (name: string) => Promise<string | undefined> };
  settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
};

function settingsEnv(settings: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const env = settings['env'];
  if (!env || typeof env !== 'object') return undefined;
  const value = (env as Record<string, unknown>)[name];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Fills `url`, `apiKey` and `model` from plugin options, then the process
 * environment, then settings `env`. `$.env.get` needs literal names.
 */
async function withEnvironment($: EnvReader, config: HookConfig): Promise<HookConfig> {
  const settings = await $.settings.read();
  const url = config.url ?? ((await $.env.get('LAYA_URL')) || settingsEnv(settings, 'LAYA_URL'));
  const apiKey =
    config.apiKey ?? ((await $.env.get('LAYA_API_KEY')) || settingsEnv(settings, 'LAYA_API_KEY'));
  const model =
    config.model ?? ((await $.env.get('LAYA_MODEL')) || settingsEnv(settings, 'LAYA_MODEL'));
  const port = (await $.env.get('LAYA_LOCAL_PORT')) || settingsEnv(settings, 'LAYA_LOCAL_PORT');
  const modelDir = (await $.env.get('LAYA_MODEL_DIR')) || settingsEnv(settings, 'LAYA_MODEL_DIR');
  const resolved = { ...config };
  if (url) resolved.url = url;
  if (apiKey) resolved.apiKey = apiKey;
  if (model) resolved.model = model;
  if (port) resolved.localPort = localPort(port);
  if (modelDir) resolved.modelDir = modelDir;
  return resolved;
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    try {
      const config = await withEnvironment($, configured);
      const { result, messages } = await compactSession(
        event.messages,
        config,
        async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        },
        { driver: hookDriver($, next.signal), root: $.plugin.root },
      );
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages };
    } catch (error) {
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
