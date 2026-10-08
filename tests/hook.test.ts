import { describe, expect, it } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  resolveHookConfig,
  summarize,
  toSessionMessages,
} from '../hooks/laya.ts';
import { applyDecisions, collectToolCalls, decideCall, type Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function layaFetch(answer: (name: string) => number, bodies: string[] = [], urls: string[] = []) {
  return async (url: string, init?: { body?: string }) => {
    urls.push(url);
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({ compactAtPercent: 60, minReductionRatio: 0.25 });
    expect(
      resolveHookConfig({
        url: 'http://h',
        apiKey: 'k',
        keepThreshold: 0.3,
        maxLen: 2048,
        maxStateTokens: 1000,
        model: 'multilingual',
        goal: 'g',
        compactAtPercent: 'no',
      }),
    ).toEqual({
      url: 'http://h',
      apiKey: 'k',
      keepThreshold: 0.3,
      maxLen: 2048,
      maxStateTokens: 1000,
      model: 'multilingual',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
    });
  });
});

describe('session message mapping', () => {
  it('keeps plain user prompts as the engine sent them and rebuilds every other message', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[laya-compaction truncated 1700 chars`),
    );
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[laya-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]?.toolUses[0]).toBe(messages[3]!.toolUses[0]);
    expect(out[4]?.toolResults?.[0]).toBe(messages[4]!.toolResults![0]);
    expect(out.map((m) => m.handle)).toEqual(['h-0', undefined, undefined, undefined, undefined, undefined, 'h-6']);
  });

  it('leaves short dropped results untouched', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'y'.repeat(100);
    messages[2]!.toolResults![0]!.text = 'y'.repeat(100);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out[1]?.toolUses[0]).toBe(messages[1]!.toolUses[0]);
    expect(out[2]?.toolResults?.[0]).toBe(messages[2]!.toolResults![0]);
  });
});

describe('compactSession', () => {
  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    const urls: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), url: 'http://h', apiKey: 'k', model: 'english' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      layaFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies, urls),
    );
    expect(bodies).toHaveLength(1);
    expect(urls).toEqual(['http://h/v1/systemone']);
    expect(JSON.parse(bodies[0]!).model).toBe('english');
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages.map((m) => m.text)).toEqual(['Fix the failing test.', '', '', 'Fixing now.', 'go ahead']);
    expect(messages[1]!.toolUses[0]!.tool_use_id).toBe('tool-2');
    expect(messages.map((m) => m.handle)).toEqual(['h-0', undefined, undefined, undefined, 'h-6']);
    expect(summarize(output)).toMatch(/^\d+% reduction; 1 kept, 1 call_dropped; state ~\d+ tokens \(full\) in 1 request\(s\)$/);
    expect(decisionLog(output)).toBe('t1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), url: 'http://h' };
    const { result: output } = await compactSession(transcript(), config, layaFetch(() => 0.1));
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:drop_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:drop_call/call=0.10/result=0.10',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('runs locally through the shared server, asking for multilingual', async () => {
    const bodies: string[] = [];
    const urls: string[] = [];
    const spawned: (readonly string[])[] = [];
    let up = false;
    const driver = {
      health: async () => up,
      spawn: async (argv: readonly string[]) => {
        spawned.push(argv);
        up = true;
        return { exitCode: 0, stderr: '' };
      },
      sleep: async () => {},
      now: () => 0,
    };
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), localPort: 8799, modelDir: '/ckpt' };
    const { result: output } = await compactSession(
      transcript(),
      config,
      layaFetch(() => 0.9, bodies, urls),
      { driver, root: '/plugins/laya-compaction' },
    );
    expect(spawned[0]!.slice(3)).toEqual(['sh', '/plugins/laya-compaction', '8799', '/ckpt']);
    expect(urls[0]).toBe('http://127.0.0.1:8799/v1/systemone');
    expect(JSON.parse(bodies[0]!)).toMatchObject({ model: 'multilingual', max_len: 4096 });
    expect(JSON.parse(bodies[0]!)).not.toHaveProperty('authorization');
    expect(output.stats.kept).toBe(2);
  });

  it('throws without a URL or local server, without uv, and on failed requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(compactSession(transcript(), config, layaFetch(() => 0))).rejects.toThrow(/LAYA_URL/);
    await expect(
      compactSession(transcript(), { ...config, url: 'http://h' }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
    const noUv = {
      health: async () => false,
      spawn: async () => ({ exitCode: 127, stderr: 'uv not found' }),
      sleep: async () => {},
      now: () => 0,
    };
    await expect(
      compactSession(transcript(), config, layaFetch(() => 0), { driver: noUv, root: '/p' }),
    ).rejects.toThrow(/uv is not installed/);
  });
});
