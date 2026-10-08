import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildExamples } from '../tuning/build-examples.ts';
import { questionTemplates } from '../tuning/export-questions.ts';
import { validateLine } from '../tuning/validate.ts';

const read = (name: string) => readFileSync(new URL(`../tuning/${name}`, import.meta.url), 'utf8');

describe('tuning sheets', () => {
  it('keeps questions.json in sync with the questions the compactor asks', () => {
    expect(JSON.parse(read('questions.json'))).toEqual(questionTemplates());
  });

  it('keeps examples.jsonl in sync with its builder, and every line valid', () => {
    const lines = read('examples.jsonl').trim().split('\n');
    expect(lines).toEqual(buildExamples());
    for (const line of lines) expect(validateLine(line)).toEqual([]);
  });

  it('flags a wrong label and a question that is not a template', () => {
    const row = JSON.parse(buildExamples()[0]!);
    row.gold.call_t1.label = row.gold.call_t1.label === 'true' ? 'false' : 'true';
    row.questions.call_t1.instructions = 'Is this useful?';
    expect(validateLine(JSON.stringify(row))).toEqual([
      'call_t1: not one of the questions in questions.json',
      'call_t1: label ' + JSON.stringify(row.gold.call_t1.label) + ' is not the most likely answer',
    ]);
  });
});
