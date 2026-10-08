// Checks a fine-tuning JSONL file line by line:
//   npm run tuning:validate -- tuning/dataset.jsonl
// Every line must be valid JSON with `state`, `questions` and `gold`; every
// question must be one of the templates in questions.json, filled in the way
// the compactor fills them; every gold must have "false"/"true"
// probabilities summing to 1 and a `label` equal to the most likely answer.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Template = { type: string; instructions: string };

const EPSILON = 1e-6;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `{id}` is t1, t2, ...; `{tool}` a tool name; `{chars}` a whole number. */
function templatePattern(text: string): RegExp {
  const source = escapeRegExp(text)
    .replaceAll('\\{id\\}', '(?<id>t\\d+)')
    .replaceAll('\\{tool\\}', '[^\\s,()]+')
    .replaceAll('\\{chars\\}', '\\d+');
  return new RegExp(`^${source}$`);
}

function loadTemplates(): { prefix: string; type: string; pattern: RegExp }[] {
  const path = fileURLToPath(new URL('./questions.json', import.meta.url));
  const templates = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Template>;
  return Object.entries(templates).map(([id, template]) => ({
    prefix: id.replace('{id}', ''),
    type: template.type,
    pattern: templatePattern(template.instructions),
  }));
}

export function validateLine(
  line: string,
  templates = loadTemplates(),
): string[] {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return ['not valid JSON'];
  }
  if (!row || typeof row !== 'object') return ['not a JSON object'];
  const { state, questions, gold } = row as Record<string, unknown>;
  const errors: string[] = [];
  if (state === undefined || state === null || state === '') errors.push('missing state');
  if (!questions || typeof questions !== 'object') return [...errors, 'missing questions'];
  if (!gold || typeof gold !== 'object') return [...errors, 'missing gold'];

  const goldMap = gold as Record<string, unknown>;
  for (const [qid, question] of Object.entries(questions as Record<string, Template>)) {
    const template = templates.find((t) => qid.startsWith(t.prefix));
    const match = template?.pattern.exec(question?.instructions ?? '');
    if (!template || question?.type !== template.type || !match) {
      errors.push(`${qid}: not one of the questions in questions.json`);
    } else if (`${template.prefix}${match.groups?.id}` !== qid) {
      errors.push(`${qid}: id does not match the call named in the instructions`);
    }
    const answer = goldMap[qid] as { label?: unknown; probabilities?: Record<string, unknown> } | undefined;
    if (!answer) {
      errors.push(`${qid}: no gold`);
      continue;
    }
    const probabilities = answer.probabilities ?? {};
    const keys = Object.keys(probabilities).sort();
    if (keys.join(',') !== 'false,true') {
      errors.push(`${qid}: probabilities must have exactly "false" and "true"`);
      continue;
    }
    const pFalse = probabilities.false;
    const pTrue = probabilities.true;
    if (typeof pFalse !== 'number' || typeof pTrue !== 'number' || pFalse < 0 || pTrue < 0) {
      errors.push(`${qid}: probabilities must be non-negative numbers`);
      continue;
    }
    if (Math.abs(pFalse + pTrue - 1) > EPSILON) errors.push(`${qid}: probabilities sum to ${pFalse + pTrue}, not 1`);
    if (pFalse === pTrue) errors.push(`${qid}: a 0.5/0.5 gold has no label; pick a side`);
    else if (answer.label !== (pTrue > pFalse ? 'true' : 'false')) {
      errors.push(`${qid}: label ${JSON.stringify(answer.label)} is not the most likely answer`);
    }
  }
  for (const qid of Object.keys(goldMap)) {
    if (!(qid in (questions as object))) errors.push(`${qid}: gold without a question`);
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? fileURLToPath(new URL('./examples.jsonl', import.meta.url));
  const templates = loadTemplates();
  const lines = readFileSync(file, 'utf8').split('\n');
  let rows = 0;
  let questions = 0;
  let failed = 0;
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    rows += 1;
    const errors = validateLine(line, templates);
    if (errors.length > 0) {
      failed += 1;
      for (const error of errors) console.log(`line ${index + 1}: ${error}`);
    } else {
      questions += Object.keys((JSON.parse(line) as { questions: object }).questions).length;
    }
  });
  console.log(`${file}: ${rows} rows, ${rows - failed} valid (${questions} questions), ${failed} with errors`);
  if (failed > 0 || rows === 0) process.exitCode = 1;
}
