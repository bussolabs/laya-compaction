// Regressions for issues reported against upstream fast-jev-compaction
// (https://github.com/tamaratran/fast-jev-compaction/issues/N) that also
// apply to laya-compaction.
import { describe, expect, it } from 'vitest';
import { compactSession, register, resolveHookConfig, toSessionMessages } from '../hooks/laya.ts';
import {
  abridgeText,
  applyDecisions,
  collectToolCalls,
  compact,
  decideCall,
  estimateTokens,
  fitState,
  goalFromMessages,
  LayaClient,
  noulAnswer,
  parseLayaResponse,
  resolveOptions,
  truncate,
  type LayaAsker,
  type LayaQuestions,
  type Message,
} from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, text = 'x'.repeat(2000), tool = 'Read'): SessionMessage {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input: { file_path: `${id}.md` }, text }], handle: `h-${id}` });
}

function result(id: string, text = 'x'.repeat(2000)): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }], handle: `r-${id}` });
}

function asker(answer: (name: string) => number, seen: LayaQuestions[] = []): LayaAsker {
  return {
    async ask(_state, questions) {
      seen.push(questions);
      return {
        answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: answer(key) }])),
      };
    },
  };
}

const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('#137 #129 #89 session messages go back without engine handles', () => {
  it('returns tool messages without a handle, keeping content, order and the engine tool objects', () => {
    const input = [message('user', 'start', { handle: 'h-0' }), call('a'), result('a'), message('user', 'go', { handle: 'h-3' })];
    const out = toSessionMessages(input, input);
    // Plain user prompts keep their handle: it carries pasted images and documents the summary cannot.
    expect(out.map((m) => m.handle)).toEqual(['h-0', undefined, undefined, 'h-3']);
    expect(out.map((m) => m.text)).toEqual(input.map((m) => m.text));
    expect(out[1]!.toolUses[0]).toBe(input[1]!.toolUses[0]);
    expect(out[2]!.toolResults![0]).toBe(input[2]!.toolResults![0]);
  });

  it('keeps a parallel group whole when only one of its results is truncated (#137)', () => {
    const big = 'data\n'.repeat(500);
    const group: SessionMessage[] = [
      message('user', 'read the docs', { handle: 'h-0' }),
      message('assistant', '', {
        handle: 'h-group',
        toolUses: ['a', 'b', 'c'].map((id) => ({ tool_use_id: id, tool: 'Read', input: { file_path: id }, text: big })),
      }),
      message('user', '', {
        handle: 'r-group',
        toolResults: ['a', 'b', 'c'].map((id) => ({ tool_use_id: id, text: big, isError: false })),
      }),
    ];
    const calls = collectToolCalls(group, 0);
    const decisions = calls.map((c) =>
      decideCall(c, c.tool_use_id === 'b' ? { keepCall: 0.9, keepResult: 0.1 } : { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    );
    const out = toSessionMessages(group, applyDecisions(group, decisions, calls, 300));
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.handle)).toEqual(['h-0', undefined, undefined]);
    expect(out[1]!.toolUses.map((t) => t.tool_use_id)).toEqual(['a', 'b', 'c']);
    expect(out[2]!.toolResults!.map((r) => r.tool_use_id)).toEqual(['a', 'b', 'c']);
    expect(out[2]!.toolResults![1]!.text).toMatch(/laya-compaction truncated/);
    expect(out[2]!.toolResults![0]!.text).toBe(big);
  });
});

describe('#128 cuts never split a surrogate pair', () => {
  const emoji = '🔥'.repeat(400);

  it('truncate and abridge keep pairs whole', () => {
    for (let limit = 1; limit < 12; limit += 1) expect(lone.test(truncate(`a${emoji}`, limit))).toBe(false);
    for (let head = 0; head < 6; head += 1) {
      for (let tail = 1; tail < 6; tail += 1) {
        expect(lone.test(abridgeText(`a${emoji}b`, head, tail))).toBe(false);
      }
    }
  });

  it('the truncated head of a dropped result keeps pairs whole', () => {
    const text = `a${emoji}`;
    const input = [message('user', 'start'), call('a', text), result('a', text), message('user', 'go')];
    const calls = collectToolCalls(input, 0);
    const decisions = calls.map((c) => decideCall(c, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }));
    for (const head of [1, 2, 3]) {
      const out = applyDecisions(input, decisions, calls, head);
      expect(lone.test(out[2]!.toolResults![0]!.text)).toBe(false);
      expect(lone.test(out[1]!.toolUses[0]!.text ?? '')).toBe(false);
    }
  });
});

describe('#29 invalid probabilities never reach a deletion', () => {
  it('rejects out-of-range, mistyped, array and inherited answers', () => {
    for (const noul of [-1, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => noulAnswer({ x: { type: 'noul', noul } }, 'x')).toThrow(/Invalid/);
    }
    expect(() => noulAnswer({ x: { type: 'choice', noul: 0.2 } as never }, 'x')).toThrow(/Invalid/);
    expect(() => noulAnswer(Object.create({ x: { noul: 0 } }), 'x')).toThrow(/Invalid/);
    expect(() => noulAnswer({ x: Object.create({ noul: 0 }) }, 'x')).toThrow(/Invalid/);
    expect(() => parseLayaResponse(200, true, '{"answers":[]}')).toThrow(/missing answers/);
    expect(noulAnswer({ x: { noul: 0 } }, 'x')).toBe(0);
    expect(noulAnswer({ x: { type: 'noul', noul: 1 } }, 'x')).toBe(1);
  });
});

describe('#30 keep thresholds outside [0, 1] are rejected', () => {
  it('throws instead of dropping a certain keep', async () => {
    expect(() => resolveOptions({ keepThreshold: 1.01 })).toThrow(/keepThreshold/);
    expect(() => resolveOptions({ keepThreshold: -0.1 })).toThrow(/keepThreshold/);
    expect(resolveOptions({ keepThreshold: Number.NaN }).keepThreshold).toBe(0.5);
    expect(resolveOptions({ keepThreshold: 1 }).keepThreshold).toBe(1);
    const input = [message('user', 'start'), call('a'), result('a'), message('user', 'go')];
    await expect(compact(input, asker(() => 1), { keepThreshold: 1.01, preserveRecentMessages: 0 })).rejects.toThrow(/keepThreshold/);
  });
});

describe('#31 ambiguous tool pairs fail closed', () => {
  it('rejects duplicate calls, duplicate results and a result before its call', () => {
    expect(() => collectToolCalls([call('same'), result('same'), call('same'), message('user', 'go')], 0)).toThrow(/Duplicate tool_use_id/);
    expect(() => collectToolCalls([message('user', 'start'), call('x'), result('x'), result('x')], 0)).toThrow(/Duplicate tool_result/);
    expect(() => collectToolCalls([result('x'), call('x')], 0)).toThrow(/precedes/);
  });

  it('still accepts a call that has no result yet', () => {
    expect(collectToolCalls([message('user', 'start'), call('x')], 0)).toEqual([]);
  });
});

describe('#32 pending tool calls stay visible to the classifier', () => {
  it('lists a call without a result in the state, without asking about it', async () => {
    const input = [message('user', 'start'), call('done'), result('done'), message('user', 'go'), call('pending')];
    const seen: LayaQuestions[] = [];
    const states: unknown[] = [];
    const recording: LayaAsker = {
      async ask(state, questions) {
        states.push(state);
        return asker(() => 0.9, seen).ask(state, questions);
      },
    };
    await compact(input, recording, { preserveRecentMessages: 1 });
    expect(JSON.stringify(states[0])).toContain('"pending_calls"');
    expect(JSON.stringify(states[0])).toContain('pending.md');
    expect(Object.keys(seen[0]!)).toEqual(['call_t1', 'result_t1']);
  });
});

describe('#33 batches run with bounded concurrency and stop after a failure', () => {
  it('never runs more than four requests at once and dequeues nothing after a failure', async () => {
    const input: SessionMessage[] = [message('user', 'start')];
    for (let i = 0; i < 12; i += 1) input.push(call(`c${i}`, 'short'), result(`c${i}`, 'short'));
    input.push(message('user', 'go'));
    let running = 0;
    let peak = 0;
    let started = 0;
    const slow: LayaAsker = {
      async ask(state, questions) {
        started += 1;
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return asker(() => 0.9).ask(state, questions);
      },
    };
    const options = { preserveRecentMessages: 0, maxLen: 4096 };
    const state = fitState(input, collectToolCalls(input, 0), resolveOptions(options));
    // one request per call: the question budget fits a single pair
    await compact(input, slow, { ...options, maxRequestTokens: state.tokens + 150 });
    expect(started).toBe(12);
    expect(peak).toBeLessThanOrEqual(4);

    started = 0;
    const failing: LayaAsker = {
      async ask() {
        started += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('boom');
      },
    };
    await expect(compact(input, failing, { ...options, maxRequestTokens: state.tokens + 150 })).rejects.toThrow(/boom/);
    expect(started).toBeLessThanOrEqual(4);
  });
});

describe('#34 requests have a deadline', () => {
  it('LayaClient aborts a request past timeoutMs', async () => {
    const client = new LayaClient({
      url: 'http://h',
      timeoutMs: 20,
      fetch: ((_url: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        })) as typeof fetch,
    });
    await expect(client.ask('s', {})).rejects.toThrow(/timed out|abort/i);
  });
});

describe('#81 dense runs are not undercounted', () => {
  it('charges hex, UUIDs and base64 at least ~3 characters per token', () => {
    const sha = 'd41d8cd98f00b204e9800998ecf8427e';
    expect(estimateTokens(sha)).toBeGreaterThanOrEqual(Math.ceil(sha.length / 3));
    const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(estimateTokens(uuid)).toBeGreaterThanOrEqual(Math.ceil(uuid.replace(/-/g, '').length / 3));
    const blob = 'c3RhcnQgdGhlIGNvbXBhY3Rpb24gZnJvbSB0aGUgaG9vayBhbmQga2VlcCBpdCBydW5uaW5n';
    expect(estimateTokens(blob)).toBeGreaterThanOrEqual(Math.ceil(blob.length / 3));
    expect(estimateTokens('internationalization')).toBe(4);
    expect(estimateTokens('x'.repeat(200))).toBe(34);
  });
});

describe('#70 host-generated text is not taken as the goal', () => {
  it('skips command echoes, notifications and reminders', () => {
    const goal = goalFromMessages([
      message('user', 'Fix the parser test.'),
      message('user', '<command-name>/compact</command-name>'),
      message('user', '<local-command-caveat>Caveat: …</local-command-caveat>'),
      message('user', '<task-notification>done</task-notification>'),
      message('user', '<system-reminder>x</system-reminder>'),
    ]);
    expect(goal).toBe('Fix the parser test.');
  });
});

describe('#39 /compact instructions reach the goal', () => {
  it('appends the instructions to the inferred goal', async () => {
    const states: { goal: string }[] = [];
    const input = [message('user', 'Fix the parser test.'), call('a'), result('a'), message('user', 'go')];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), url: 'http://h' };
    await compactSession(input, config, async (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}') as { state: { goal: string }; questions: Record<string, unknown> };
      states.push(body.state);
      const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { noul: 0.9 }]));
      return { status: 200, ok: true, text: JSON.stringify({ answers }) };
    }, undefined, 'keep the parser decisions');
    expect(states[0]!.goal).toBe('Fix the parser test.\ngo\nkeep the parser decisions');
  });
});

type Handler = (...args: never[]) => unknown;

function hookHarness(options: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  register(((event: string, handler: Handler) => {
    handlers.set(event, handler);
  }) as never, options as never);
  return handlers;
}

function fakeEngine(overrides: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const $ = {
    ui: { log: (text: string) => logs.push(text), toast: () => {} },
    env: { get: async () => undefined },
    settings: { read: async () => ({}) },
    http: { fetch: async () => ({ status: 200, ok: true, text: '{"answers":{}}' }) },
    process: { run: async () => ({ exitCode: 127, stdout: '', stderr: 'uv not found' }) },
    clock: { sleep: async () => {}, now: async () => 0 },
    plugin: { root: '/p', name: 'laya-compaction' },
    session: { usage: async () => ({ context: { percent: 90 } }), compact: async () => ({ messages: [] }) },
    ...overrides,
  };
  return { $, logs };
}

function next() {
  const calls: unknown[] = [];
  const fn = Object.assign(async (event: unknown) => {
    calls.push(event);
    return { skip: 'core' };
  }, { signal: undefined, calls });
  return fn;
}

describe('#107 hooks leave subagents, precompute and non-answer turns alone', () => {
  it('session.compact hands a subagent transcript to core and skips precompute', async () => {
    const compactHook = hookHarness().get('session.compact')!;
    const { $ } = fakeEngine();
    const n = next();
    const sub = { trigger: 'auto', agentId: 'agent-1', messages: [] };
    await (compactHook as (...a: unknown[]) => Promise<unknown>)($, sub, n);
    expect(n.calls).toEqual([sub]);
    const pre = await (compactHook as (...a: unknown[]) => Promise<unknown>)($, { trigger: 'precompute', messages: [] }, n);
    expect(pre).toMatchObject({ skip: expect.stringContaining('precompute') });
  });

  it('turn.complete compacts only after an answered main-loop turn', async () => {
    const turnHook = hookHarness().get('turn.complete') as (...a: unknown[]) => Promise<unknown>;
    let compactions = 0;
    const { $ } = fakeEngine({ session: { usage: async () => ({ context: { percent: 90 } }), compact: async () => { compactions += 1; return { messages: [] }; } } });
    await turnHook($, { reason: 'answer', agentId: 'agent-1' }, next());
    await turnHook($, { reason: 'aborted' }, next());
    expect(compactions).toBe(0);
    await turnHook($, { reason: 'answer' }, next());
    expect(compactions).toBe(1);
  });
});

describe('#35 the auto-compaction lock is taken before the first await', () => {
  it('two overlapping turns request one compaction', async () => {
    const turnHook = hookHarness().get('turn.complete') as (...a: unknown[]) => Promise<unknown>;
    let compactions = 0;
    const { $ } = fakeEngine({
      session: {
        usage: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { context: { percent: 90 } };
        },
        compact: async () => {
          compactions += 1;
          return { messages: [] };
        },
      },
    });
    await Promise.all([turnHook($, { reason: 'answer' }, next()), turnHook($, { reason: 'answer' }, next())]);
    expect(compactions).toBe(1);
  });
});

describe('#36 UI failures do not break compaction or its fallback', () => {
  it('still falls back to core when the toast throws', async () => {
    const compactHook = hookHarness().get('session.compact') as (...a: unknown[]) => Promise<unknown>;
    const { $ } = fakeEngine({ ui: { log: () => { throw new Error('log down'); }, toast: () => { throw new Error('toast down'); } } });
    const n = next();
    const event = { trigger: 'manual', messages: [message('user', 'start'), call('a'), result('a'), message('user', 'go')] };
    await expect(compactHook($, event, n)).resolves.toEqual({ skip: 'core' });
    expect(n.calls).toEqual([event]);
  });

  it('keeps a successful compaction when logging throws', async () => {
    const compactHook = hookHarness({ minReductionRatio: 0, preserveRecentMessages: 1 }).get('session.compact') as (...a: unknown[]) => Promise<unknown>;
    const { $ } = fakeEngine({
      ui: { log: () => { throw new Error('log down'); }, toast: () => { throw new Error('toast down'); } },
      env: { get: async (name: string) => (name === 'LAYA_URL' ? 'http://h' : undefined) },
      http: {
        fetch: async (_url: string, init?: { body?: string }) => {
          const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
          return { status: 200, ok: true, text: JSON.stringify({ answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: 0 }])) }) };
        },
      },
    });
    const event = { trigger: 'manual', messages: [message('user', 'start'), call('a'), result('a'), message('user', 'go')] };
    const out = (await compactHook($, event, next())) as { messages?: unknown[] };
    expect(out.messages).toHaveLength(2);
  });
});
