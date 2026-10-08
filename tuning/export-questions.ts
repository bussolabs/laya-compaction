// Writes tuning/questions.json: the two noul questions the compactor asks
// about every tool call, as templates. At runtime `{id}`, `{tool}` and
// `{chars}` are filled in per call (t1, t2, ...), so a dataset uses the
// filled-in form; validate.ts matches it against these templates.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { questionsFor } from '../src/compact.js';
import type { ToolCall } from '../src/types.js';

export const PLACEHOLDER_CALL = {
  id: '{id}',
  tool: '{tool}',
  resultChars: '{chars}' as unknown as number,
} as ToolCall;

export function questionTemplates() {
  return questionsFor(PLACEHOLDER_CALL);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = fileURLToPath(new URL('./questions.json', import.meta.url));
  writeFileSync(path, `${JSON.stringify(questionTemplates(), null, 2)}\n`);
  console.log(`wrote ${path}`);
}
