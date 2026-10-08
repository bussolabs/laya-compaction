import { buildLayaRequest, parseLayaResponse } from './request.js';
import type { LayaAsker, LayaQuestions, LayaResponse, LayaState } from './types.js';

export interface LayaClientOptions {
  /** `laya-serve` base URL. Defaults to `process.env.LAYA_URL`. */
  url?: string;
  /** Bearer key, sent only when set. Defaults to `process.env.LAYA_API_KEY`. */
  apiKey?: string;
  /** Checkpoint name for `laya-serve`, omitted when unset. Defaults to `process.env.LAYA_MODEL`. */
  model?: string;
  /** Token window sent as `max_len`. */
  maxLen?: number;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Asks a `laya-serve` server over HTTP with the global `fetch` (or an injected one). */
export class LayaClient implements LayaAsker {
  private readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly model: string | undefined;
  private readonly maxLen: number | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: LayaClientOptions = {}) {
    this.url = options.url ?? process.env.LAYA_URL ?? '';
    this.apiKey = options.apiKey ?? (process.env.LAYA_API_KEY || undefined);
    this.model = options.model ?? (process.env.LAYA_MODEL || undefined);
    this.maxLen = options.maxLen;
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: LayaState, questions: LayaQuestions): Promise<LayaResponse> {
    if (!this.url) throw new Error('LAYA_URL is not configured');
    const request = buildLayaRequest(
      { url: this.url, apiKey: this.apiKey, model: this.model, maxLen: this.maxLen },
      state,
      questions,
    );
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return parseLayaResponse(response.status, response.ok, await response.text());
  }
}
