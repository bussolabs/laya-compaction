import type { LayaAnswer, LayaQuestions, LayaResponse, LayaState } from './types.js';

/** Path of the Jev-compatible decision route `laya-serve` exposes. */
export const SYSTEM_ONE_PATH = '/v1/systemone';

/**
 * Token window sent as `max_len`. The state and one question header share it,
 * so it bounds the state budget. The multilingual checkpoint reads up to 8192;
 * a wider window gives Laya more context and makes every question slower.
 */
export const DEFAULT_MAX_LEN = 4096;

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
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Laya response is missing answers');
  }
  return parsed as LayaResponse;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, LayaAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Laya answer for ${name}`);
  }
  return answer.noul;
}
