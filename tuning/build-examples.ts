// Builds tuning/examples.jsonl from hand-written, synthetic transcripts. Each
// state is produced by the compactor's own state builder with the default
// options, so it has exactly the shape Laya sees at runtime. The gold values
// are the probability that the answer is "true" for each question.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { questionsFor, resolveOptions } from '../src/compact.js';
import { collectToolCalls, fitState } from '../src/state.js';
import type { Message } from '../src/types.js';

type Gold = { keepCall: number; keepResult: number };

interface Scenario {
  name: string;
  messages: Message[];
  /** Gold per tool_use_id of every candidate call. */
  gold: Record<string, Gold>;
}

function user(text: string): Message {
  return { role: 'user', text, toolUses: [] };
}

function assistant(text: string): Message {
  return { role: 'assistant', text, toolUses: [] };
}

/** A tool call and its result; only the result length reaches the state. */
function tool(
  id: string,
  name: string,
  input: Record<string, unknown>,
  chars: number,
  isError = false,
  text = '',
): Message[] {
  const output = 'x'.repeat(chars);
  return [
    { role: 'assistant', text, toolUses: [{ tool_use_id: id, tool: name, input }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: output, isError }] },
  ];
}

const g = (keepCall: number, keepResult: number): Gold => ({ keepCall, keepResult });

export const scenarios: Scenario[] = [
  {
    name: 'superseded file read',
    messages: [
      user('Rename the `retries` option to `maxRetries` in src/config.ts.'),
      ...tool('a1', 'Read', { file_path: 'src/config.ts' }, 2400),
      ...tool('a2', 'Edit', { file_path: 'src/config.ts', old_string: 'retries:', new_string: 'maxRetries:' }, 90),
      ...tool('a3', 'Read', { file_path: 'src/config.ts' }, 2410),
      assistant('Renamed. The option is now `maxRetries` everywhere in the file.'),
      user('Now update the README section that mentions it.'),
    ],
    gold: { a1: g(0.15, 0.0), a2: g(0.9, 0.2), a3: g(0.6, 0.3) },
  },
  {
    name: 'failing test already fixed',
    messages: [
      user('The date parser test fails, please fix it.'),
      ...tool('b1', 'Bash', { command: 'npx vitest run src/date.test.ts' }, 1800, true),
      ...tool('b2', 'Edit', { file_path: 'src/date.ts', old_string: 'getDay()', new_string: 'getDate()' }, 80),
      ...tool('b3', 'Bash', { command: 'npx vitest run src/date.test.ts' }, 420),
      assistant('Fixed: the parser used getDay() instead of getDate(). The test passes now.'),
      user('Great, also check the other date helpers for the same mistake.'),
    ],
    gold: { b1: g(0.55, 0.05), b2: g(0.95, 0.2), b3: g(0.8, 0.15) },
  },
  {
    name: 'test output still needed',
    messages: [
      user('Run the API test suite and fix every failure.'),
      ...tool('c1', 'Bash', { command: 'npm test -- api/' }, 6200, true),
      assistant('Three tests fail: auth token expiry, pagination cursor and the 404 body. Starting with the token expiry.'),
      ...tool('c2', 'Edit', { file_path: 'api/auth.ts', old_string: 'expiresIn: 60', new_string: 'expiresIn: 3600' }, 75),
      assistant('Token expiry fixed. Two failures left.'),
      user('Continue with the next one.'),
    ],
    gold: { c1: g(1.0, 0.9), c2: g(0.9, 0.2) },
  },
  {
    name: 'glob used to locate a file',
    messages: [
      user('Add a `slug` field to the Article model.'),
      ...tool('d1', 'Glob', { pattern: '**/article*.ts' }, 160),
      ...tool('d2', 'Read', { file_path: 'src/models/article.ts' }, 3100),
      assistant('Found the model. Adding the field and its validation next.'),
      user('Make the slug unique too.'),
    ],
    gold: { d1: g(0.3, 0.1), d2: g(0.9, 0.85) },
  },
  {
    name: 'search in a folder the user excluded',
    messages: [
      user('Find where invoices get their number. Ignore the legacy/ folder, it is dead code.'),
      ...tool('e1', 'Grep', { pattern: 'invoiceNumber', path: 'legacy/' }, 2700),
      ...tool('e2', 'Grep', { pattern: 'invoiceNumber', path: 'src/' }, 640),
      assistant('Invoice numbers come from src/billing/sequence.ts, function nextInvoiceNumber.'),
      user('Explain how the sequence resets every year.'),
    ],
    gold: { e1: g(0.1, 0.0), e2: g(0.7, 0.4) },
  },
  {
    name: 'build error fixed by adding an import',
    messages: [
      user('The build is broken after my last commit.'),
      ...tool('f1', 'Bash', { command: 'npm run build' }, 2300, true),
      ...tool('f2', 'Edit', { file_path: 'src/report.ts', old_string: "import { sum } from './math';", new_string: "import { sum, round } from './math';" }, 85),
      ...tool('f3', 'Bash', { command: 'npm run build' }, 300),
      assistant('The build passes. `round` was used in report.ts without being imported.'),
      user('Thanks. Can you add a lint rule so this is caught earlier?'),
    ],
    gold: { f1: g(0.45, 0.0), f2: g(0.9, 0.15), f3: g(0.6, 0.05) },
  },
  {
    name: 'documentation fetched for the next step',
    messages: [
      user('Switch our HTTP client retries to the library built-in backoff option.'),
      ...tool('g1', 'WebFetch', { url: 'https://docs.example.com/http-client/retries', prompt: 'retry and backoff options' }, 5200),
      assistant('The docs describe `retry.backoff` with `initialMs` and `maxMs`. I will apply it to src/http.ts now.'),
      user('Use 200 ms initial delay.'),
    ],
    gold: { g1: g(0.9, 0.65) },
  },
  {
    name: 'large log where one line was quoted',
    messages: [
      user('Why did the nightly import job crash?'),
      ...tool('h1', 'Read', { file_path: 'logs/import-2026-10-01.log' }, 41000),
      assistant('The crash is at 02:14: "TimeoutError: upstream feed did not answer in 30s". Everything before it is normal progress output.'),
      user('Raise the timeout to 120 seconds.'),
    ],
    gold: { h1: g(0.4, 0.05) },
  },
  {
    name: 'stale git status and a fresh diff',
    messages: [
      user('Prepare a commit with the refactor of the cache module.'),
      ...tool('i1', 'Bash', { command: 'git status --short' }, 380),
      ...tool('i2', 'Edit', { file_path: 'src/cache.ts', old_string: 'class Cache', new_string: 'export class Cache' }, 70),
      ...tool('i3', 'Bash', { command: 'git diff --stat' }, 520),
      assistant('Two files changed. Proposed message: "Export Cache and drop the unused singleton".'),
      user('Shorten the commit message.'),
    ],
    gold: { i1: g(0.2, 0.0), i2: g(0.85, 0.2), i3: g(0.8, 0.6) },
  },
  {
    name: 'package.json read to find the test script',
    messages: [
      user('Run the end-to-end tests.'),
      ...tool('j1', 'Read', { file_path: 'package.json' }, 1500),
      ...tool('j2', 'Bash', { command: 'npm run test:e2e' }, 900),
      assistant('All 14 end-to-end tests pass.'),
      user('Now run them against the staging URL.'),
    ],
    gold: { j1: g(0.6, 0.35), j2: g(0.75, 0.3) },
  },
  {
    name: 'file the user forbade editing',
    messages: [
      user('Fix the lint errors. Never edit src/generated/api.ts, it is generated.'),
      ...tool('k1', 'Bash', { command: 'npm run lint' }, 3300, true),
      ...tool('k2', 'Read', { file_path: 'src/generated/api.ts' }, 8800),
      assistant('Most errors are in the generated file, which I will leave alone. Fixing the two in src/routes.ts.'),
      user('ok'),
    ],
    gold: { k1: g(0.9, 0.7), k2: g(0.6, 0.05) },
  },
  {
    name: 'superseded task list',
    messages: [
      user('Plan and implement CSV export for the orders page.'),
      ...tool('l1', 'TodoWrite', { todos: [{ content: 'Add export button', status: 'pending' }, { content: 'Write CSV serializer', status: 'pending' }] }, 60),
      ...tool('l2', 'Edit', { file_path: 'src/orders/export.ts', old_string: '', new_string: 'export function toCsv(rows) {}' }, 70),
      ...tool('l3', 'TodoWrite', { todos: [{ content: 'Add export button', status: 'in_progress' }, { content: 'Write CSV serializer', status: 'completed' }] }, 60),
      assistant('Serializer done, wiring the button now.'),
      user('Put the button next to the filters.'),
    ],
    gold: { l1: g(0.1, 0.0), l2: g(0.9, 0.2), l3: g(0.85, 0.7) },
  },
  {
    name: 'command typo',
    messages: [
      user('Run the unit tests.'),
      ...tool('m1', 'Bash', { command: 'npm tset' }, 210, true),
      ...tool('m2', 'Bash', { command: 'npm test' }, 1300),
      assistant('All 212 unit tests pass.'),
      user('Good. Bump the patch version.'),
    ],
    gold: { m1: g(0.0, 0.0), m2: g(0.7, 0.2) },
  },
  {
    name: 'type definition used by upcoming edits',
    messages: [
      user('Add a `discountCode` to the checkout flow end to end.'),
      ...tool('n1', 'Read', { file_path: 'src/types/checkout.ts' }, 2600),
      ...tool('n2', 'Read', { file_path: 'src/README.md' }, 4100),
      assistant('CheckoutRequest is the type to extend; the README has nothing relevant. Starting with the type, then the form and the API handler.'),
      user('Go.'),
    ],
    gold: { n1: g(0.95, 0.9), n2: g(0.15, 0.0) },
  },
  {
    name: 'directory listing and folder creation',
    messages: [
      user('Create a fixtures folder for the parser tests and add one sample file.'),
      ...tool('o1', 'Bash', { command: 'ls tests' }, 240),
      ...tool('o2', 'Bash', { command: 'mkdir -p tests/fixtures/parser' }, 0),
      ...tool('o3', 'Write', { file_path: 'tests/fixtures/parser/sample.json', content: '{"items": [1, 2, 3]}' }, 60),
      assistant('Created tests/fixtures/parser/sample.json.'),
      user('Use it in parser.test.ts.'),
    ],
    gold: { o1: g(0.2, 0.0), o2: g(0.55, 0.0), o3: g(0.9, 0.3) },
  },
  {
    name: 'two reads of different files, one finished',
    messages: [
      user('Make the footer link color match the header link color.'),
      ...tool('p1', 'Read', { file_path: 'src/styles/header.css' }, 1900),
      ...tool('p2', 'Read', { file_path: 'src/styles/footer.css' }, 1700),
      ...tool('p3', 'Edit', { file_path: 'src/styles/footer.css', old_string: 'color: #555;', new_string: 'color: var(--link);' }, 80),
      assistant('Footer links now use var(--link), the same token as the header.'),
      user('Also apply it to the hover state.'),
    ],
    gold: { p1: g(0.45, 0.15), p2: g(0.8, 0.6), p3: g(0.9, 0.2) },
  },
];

const options = resolveOptions({ preserveRecentMessages: 2 });

export function buildExamples(): string[] {
  return scenarios.map((scenario) => {
    const calls = collectToolCalls(scenario.messages, options.preserveRecentMessages);
    const candidates = calls.filter((call) => !call.pinned);
    const { state, tokens } = fitState(scenario.messages, calls, options);
    if (tokens > options.maxStateTokens) throw new Error(`${scenario.name}: state too large`);
    const questions = Object.assign({}, ...candidates.map(questionsFor));
    const gold: Record<string, { label: string; probabilities: Record<string, number> }> = {};
    for (const call of candidates) {
      const answer = scenario.gold[call.tool_use_id];
      if (!answer) throw new Error(`${scenario.name}: no gold for ${call.tool_use_id}`);
      gold[`call_${call.id}`] = noulGold(answer.keepCall);
      gold[`result_${call.id}`] = noulGold(answer.keepResult);
    }
    return JSON.stringify({ state, questions, gold });
  });
}

function noulGold(pTrue: number) {
  if (pTrue === 0.5) throw new Error('a 0.5 gold has no label; pick a side');
  const t = Math.round(pTrue * 10_000) / 10_000;
  const f = Math.round((1 - t) * 10_000) / 10_000;
  return { label: t > f ? 'true' : 'false', probabilities: { false: f, true: t } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lines = buildExamples();
  const path = process.argv[2] ?? fileURLToPath(new URL('./examples.jsonl', import.meta.url));
  writeFileSync(path, `${lines.join('\n')}\n`);
  console.log(`wrote ${lines.length} examples to ${path}`);
}
