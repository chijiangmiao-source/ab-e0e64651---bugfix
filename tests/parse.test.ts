import { describe, expect, it } from 'vitest';
import { parseScenario } from '../src/crdt/parse';

const tag = (zone: string) => ({ zone, lat: 1, lng: 2, radiusKm: 1 });

interface RawScenario {
  terminals: string[];
  messages: Array<Record<string, unknown>>;
  inbox: Record<string, string[]>;
}

function base(): RawScenario {
  return {
    terminals: ['A', 'B'],
    messages: [
      { id: 'A#1', kind: 'add', dot: 'D1', tag: tag('Z1'), ctx: { A: 1 } },
      { id: 'B#1', kind: 'add', dot: 'D2', tag: tag('Z2'), ctx: { B: 1 } },
    ],
    inbox: { A: ['A#1', 'B#1'], B: ['B#1', 'A#1'] },
  };
}

function expectRejected(s: unknown, needle: string) {
  const r = parseScenario(s);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(
      r.errors.some((e) => e.message.includes(needle)),
      `应包含错误「${needle}」，实际：${JSON.stringify(r.errors)}`,
    ).toBe(true);
  }
}

describe('场景校验', () => {
  it('接受合法场景并归一化上下文', () => {
    const r = parseScenario(base());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scenario.terminals).toEqual(['A', 'B']);
      expect(r.scenario.messagesById['A#1'].ctx).toEqual({ A: 1, B: 0 });
    }
  });

  it('拒绝终端标识冲突并定位', () => {
    const s = base();
    s.terminals = ['A', 'A'];
    expectRejected(s, '终端标识冲突');
  });

  it('拒绝终端数量越界（须 2-4 台）', () => {
    const s1 = base();
    s1.terminals = ['A'];
    expectRejected(s1, '2-4');
    const s5 = base();
    s5.terminals = ['A', 'B', 'C', 'D', 'E'];
    expectRejected(s5, '2-4');
  });

  it('拒绝未知终端的消息与非法事件标识', () => {
    const s = base();
    s.messages.push({ id: 'X#1', kind: 'add', dot: 'D9', tag: tag('Z9'), ctx: { X: 1 } });
    expectRejected(s, '未知终端');

    const s2 = base();
    s2.messages[0].id = 'A-1';
    expectRejected(s2, '非法消息标识');
  });

  it('拒绝不连续的消息链', () => {
    const s = base();
    s.messages = [
      { id: 'A#1', kind: 'add', dot: 'D1', tag: tag('Z1'), ctx: { A: 1 } },
      { id: 'A#3', kind: 'add', dot: 'D3', tag: tag('Z3'), ctx: { A: 3 } },
      { id: 'B#1', kind: 'add', dot: 'D2', tag: tag('Z2'), ctx: { B: 1 } },
    ];
    expectRejected(s, '不连续');
  });

  it('拒绝点标识复用但载荷不同，并定位双方', () => {
    const s = base();
    s.messages = [
      { id: 'A#1', kind: 'add', dot: 'D1', tag: tag('Z1'), ctx: { A: 1 } },
      { id: 'B#1', kind: 'add', dot: 'D1', tag: tag('Z-DIFFERENT'), ctx: { B: 1 } },
    ];
    const r = parseScenario(s);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const e = r.errors.find((x) => x.message.includes('点标识复用'));
      expect(e).toBeDefined();
      expect(e!.message).toContain('A#1');
      expect(e!.message).toContain('B#1');
    }
  });

  it('允许点标识复用但载荷完全相同（重复广播）', () => {
    const s = base();
    s.messages = [
      { id: 'A#1', kind: 'add', dot: 'D1', tag: tag('Z1'), ctx: { A: 1 } },
      { id: 'B#1', kind: 'add', dot: 'D1', tag: tag('Z1'), ctx: { B: 1 } },
    ];
    expect(parseScenario(s).ok).toBe(true);
  });

  it('拒绝非法上下文：自身序号不符', () => {
    const s = base();
    s.messages[0].ctx = { A: 2 };
    expectRejected(s, '自身序号');
  });

  it('拒绝非法上下文：引用未知终端 / 负值 / 观察未来 / 沿链回退', () => {
    const s1 = base();
    s1.messages[0].ctx = { A: 1, X: 1 };
    expectRejected(s1, '未知终端');

    const s2 = base();
    s2.messages[0].ctx = { A: 1, B: -1 };
    expectRejected(s2, '非负整数');

    const s3 = base();
    s3.messages[0].ctx = { A: 1, B: 5 };
    expectRejected(s3, '仅产生');

    const s4 = base();
    s4.messages = [
      { id: 'A#1', kind: 'add', dot: 'D1', tag: tag('Z1'), ctx: { A: 1, B: 0 } },
      { id: 'B#1', kind: 'add', dot: 'D2', tag: tag('Z2'), ctx: { B: 1 } },
      { id: 'A#2', kind: 'remove', zone: 'Z2', ctx: { A: 2, B: 1 } },
      { id: 'A#3', kind: 'remove', zone: 'Z1', ctx: { A: 3 } },
    ];
    s4.inbox = {
      A: ['A#1', 'A#2', 'A#3', 'B#1'],
      B: ['B#1', 'A#1', 'A#2', 'A#3'],
    };
    expectRejected(s4, '回退');
  });

  it('拒绝非法收件顺序：未知消息 / 缺少终端 / 覆盖不全', () => {
    const s1 = base();
    s1.inbox.A = ['A#1', 'B#9'];
    expectRejected(s1, '未知消息标识');

    const s2 = base();
    s2.inbox = { A: ['A#1', 'B#1'] };
    expectRejected(s2, '缺少收件顺序');

    const s3 = base();
    s3.inbox = { A: ['A#1'], B: ['A#1', 'B#1'] };
    expectRejected(s3, '未覆盖消息 B#1');
  });

  it('允许撤销从未新增的区域（合法空操作）', () => {
    const s = base();
    s.messages.push({ id: 'A#2', kind: 'remove', zone: 'Z-NOPE', ctx: { A: 2 } });
    s.inbox.A = ['A#1', 'A#2', 'B#1'];
    s.inbox.B = ['B#1', 'A#1', 'A#2'];
    expect(parseScenario(s).ok).toBe(true);
  });
});

describe('全局因果序无环校验', () => {
  const tag1 = { zone: 'Z1', lat: 1, lng: 2, radiusKm: 1 };

  function expectCycleRejected(s: unknown, members: string[]) {
    const r = parseScenario(s);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const joined = r.errors.map((e) => e.message).join('\n');
    expect(joined).toContain('互相依赖成环');
    expect(joined).toContain('不存在真实发生顺序');
    // 环上每个事件都应被定位
    for (const id of members) {
      expect(
        r.errors.some((e) => e.path === `$.messages[${id}].ctx` && e.message.includes(id)),
        `应在 ctx 位置定位环上事件 ${id}，实际：${JSON.stringify(r.errors)}`,
      ).toBe(true);
    }
  }

  it('拒绝两终端直接互相依赖：B#1 已见 A#2，而 A#2 又已见 B#1', () => {
    const s = {
      terminals: ['A', 'B'],
      messages: [
        { id: 'A#1', kind: 'add', dot: 'D1', tag: tag1, ctx: { A: 1 } },
        { id: 'B#1', kind: 'add', dot: 'D2', tag: tag1, ctx: { B: 1, A: 2 } },
        { id: 'A#2', kind: 'remove', zone: 'Z1', ctx: { A: 2, B: 1 } },
      ],
      inbox: { A: ['A#1', 'A#2', 'B#1'], B: ['B#1', 'A#2', 'A#1'] },
    };
    expectCycleRejected(s, ['A#2', 'B#1']);
  });

  it('拒绝更长的间接依赖链：A#2 → C#1 → B#1 → A#2', () => {
    const s = {
      terminals: ['A', 'B', 'C'],
      messages: [
        { id: 'A#1', kind: 'add', dot: 'D1', tag: tag1, ctx: { A: 1 } },
        { id: 'A#2', kind: 'remove', zone: 'Z1', ctx: { A: 2, B: 1 } },
        { id: 'B#1', kind: 'add', dot: 'D2', tag: tag1, ctx: { B: 1, C: 1 } },
        { id: 'C#1', kind: 'add', dot: 'D3', tag: tag1, ctx: { C: 1, A: 2 } },
      ],
      inbox: {
        A: ['A#1', 'A#2', 'B#1', 'C#1'],
        B: ['B#1', 'A#1', 'C#1', 'A#2'],
        C: ['C#1', 'A#1', 'B#1', 'A#2'],
      },
    };
    expectCycleRejected(s, ['A#2', 'B#1', 'C#1']);
  });

  it('拒绝四终端间接依赖链：A#2 → D#1 → C#1 → B#1 → A#2', () => {
    const s = {
      terminals: ['A', 'B', 'C', 'D'],
      messages: [
        { id: 'A#1', kind: 'add', dot: 'D1', tag: tag1, ctx: { A: 1 } },
        { id: 'A#2', kind: 'remove', zone: 'Z1', ctx: { A: 2, D: 1 } },
        { id: 'D#1', kind: 'add', dot: 'D4', tag: tag1, ctx: { D: 1, C: 1 } },
        { id: 'C#1', kind: 'add', dot: 'D3', tag: tag1, ctx: { C: 1, B: 1 } },
        { id: 'B#1', kind: 'add', dot: 'D2', tag: tag1, ctx: { B: 1, A: 2 } },
      ],
      inbox: {
        A: ['A#1', 'A#2', 'B#1', 'C#1', 'D#1'],
        B: ['B#1', 'A#1', 'A#2', 'C#1', 'D#1'],
        C: ['C#1', 'A#1', 'B#1', 'A#2', 'D#1'],
        D: ['D#1', 'A#1', 'B#1', 'C#1', 'A#2'],
      },
    };
    expectCycleRejected(s, ['A#2', 'B#1', 'C#1', 'D#1']);
  });

  it('接受不成环的跨终端观察（菱形依赖）', () => {
    const s = {
      terminals: ['A', 'B', 'C'],
      messages: [
        { id: 'A#1', kind: 'add', dot: 'D1', tag: tag1, ctx: { A: 1 } },
        { id: 'B#1', kind: 'add', dot: 'D2', tag: tag1, ctx: { B: 1, A: 1 } },
        { id: 'C#1', kind: 'add', dot: 'D3', tag: tag1, ctx: { C: 1, A: 1 } },
        { id: 'C#2', kind: 'remove', zone: 'Z1', ctx: { C: 2, A: 1, B: 1 } },
      ],
      inbox: {
        A: ['A#1', 'B#1', 'C#1', 'C#2'],
        B: ['B#1', 'A#1', 'C#1', 'C#2'],
        C: ['C#1', 'A#1', 'B#1', 'C#2'],
      },
    };
    expect(parseScenario(s).ok).toBe(true);
  });

  it('长自身链（1000 条）不成环且不溢出', () => {
    const messages: Array<Record<string, unknown>> = [];
    const inbox: Record<string, string[]> = { A: [], B: [] };
    for (let n = 1; n <= 1000; n += 1) {
      messages.push({ id: `A#${n}`, kind: 'add', dot: `D${n}`, tag: tag1, ctx: { A: n } });
      inbox.A.push(`A#${n}`);
      inbox.B.push(`A#${n}`);
    }
    const r = parseScenario({ terminals: ['A', 'B'], messages, inbox });
    expect(r.ok).toBe(true);
  });
});
