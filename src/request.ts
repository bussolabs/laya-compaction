import type { LayaAnswer, LayaQuestions, LayaResponse, LayaState } from './types.js';

/** Path of the Jev-compatible decision route `laya-serve` exposes. */
export const SYSTEM_ONE_PATH = '/v1/systemone';

/**
 * Token window sent as `max_len`. The state and one question header share it,
 * so it bounds the state budget. The multilingual checkpoint reads up to 8192;
 * a wider window gives Laya more context and makes every question slower.
 */
export const DEFAULT_MAX_LEN = 4096;

/**
 * Deadline for one request. A request carries the questions of a whole batch,
 * about 0.6 s each on Apple silicon at the default window, so it is generous.
 */
export const DEFAULT_TIMEOUT_MS = 300_000;

export interface LayaRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one `laya-serve` call, for any fetch-like transport. */
export function buildLayaRequest(
  params: {
    url: string;
    apiKey?: string;
    model?: string;
    maxLen?: number;
  },
  state: LayaState,
  questions: LayaQuestions,
): LayaRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (params.apiKey) headers.authorization = `Bearer ${params.apiKey}`;
  const body: Record<string, unknown> = {};
  if (params.model) body.model = params.model;
  body.state = state;
  body.questions = questions;
  if (params.maxLen !== undefined) body.max_len = params.maxLen;
  return {
    url: `${params.url.replace(/\/+$/, '')}${SYSTEM_ONE_PATH}`,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  };
}

/** Validates a Laya response body; throws on anything but an `answers` object. */
export function parseLayaResponse(
  status: number,
  ok: boolean,
  text: string,
): LayaResponse {
  if (!ok) {
    throw new Error(`Laya request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Laya returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object' ||
    Array.isArray(parsed.answers)
  ) {
    throw new Error('Laya response is missing answers');
  }
  return parsed as LayaResponse;
}

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/**
 * The `noul` probability of one answer; throws unless it is the answer's own
 * `noul`, a number in [0, 1], on an object whose `type`, when present, is
 * `noul`. Nothing malformed reaches a deletion decision.
 */
export function noulAnswer(
  answers: Record<string, LayaAnswer>,
  name: string,
): number {
  const answer: unknown = own(answers, name) ? answers[name] : undefined;
  if (
    answer === null ||
    typeof answer !== 'object' ||
    Array.isArray(answer) ||
    !own(answer, 'noul') ||
    (own(answer, 'type') && (answer as { type?: unknown }).type !== 'noul')
  ) {
    throw new Error(`Invalid Laya answer for ${name}`);
  }
  const noul = (answer as { noul: unknown }).noul;
  if (typeof noul !== 'number' || !(noul >= 0 && noul <= 1)) {
    throw new Error(`Invalid Laya answer for ${name}: ${String(noul)} is not a probability`);
  }
  return noul;
}
