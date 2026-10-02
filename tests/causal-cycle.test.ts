import { describe, expect, it } from 'vitest';
import { parseScenario } from '../src/crdt/parse';
import { runReplay } from '../src/crdt/replay';

const tag = (zone: string) => ({ zone, lat: 39.9, lng: 116.4, radiusKm: 3 });

/**
 * 任务描述的两终端互相依赖场景：
 * A 先新增标签（A#1）；B 的首条新增 B#1 声称已见过 A 随后的撤销 A#2；
 * 而 A#2 又声称已见过 B#1。A#2 → B#1 → A#2 构成因果环，
 * 不存在任何真实的先后发生顺序。
 */
function mutualTwoTerminal() {
  return {
    terminals: ['A', 'B'],
    messages: [
      { id: 'A#1', kind: 'add', dot: 'D-01', tag: tag('Z-1'), ctx: { A: 1 } },
      { id: 'B#1', kind: 'add', dot: 'D-02', tag: tag('Z-2'), ctx: { B: 1, A: 2 } },
      { id: 'A#2', kind: 'remove', zone: 'Z-1', ctx: { A: 2, B: 1 } },
    ],
    inbox: {
      A: ['A#1', 'A#2', 'B#1'],
      B: ['B#1', 'A#2', 'A#1'],
    },
  };
}

/** 三终端间接依赖链：A#2 → C#1 → B#1 → A#2 */
function indirectThreeTerminal() {
  return {
    terminals: ['A', 'B', 'C'],
    messages: [
      { id: 'A#1', kind: 'add', dot: 'D-01', tag: tag('Z-1'), ctx: { A: 1 } },
      { id: 'A#2', kind: 'remove', zone: 'Z-1', ctx: { A: 2, C: 1 } },
      { id: 'B#1', kind: 'add', dot: 'D-02', tag: tag('Z-2'), ctx: { B: 1, A: 2 } },
      { id: 'C#1', kind: 'add', dot: 'D-03', tag: tag('Z-3'), ctx: { C: 1, B: 1 } },
    ],
    inbox: {
      A: ['A#1', 'A#2', 'B#1', 'C#1'],
      B: ['B#1', 'C#1', 'A#1', 'A#2'],
      C: ['C#1', 'A#2', 'B#1', 'A#1'],
    },
  };
}

/** 四终端间接依赖链：A#2 → C#1 → B#1 → D#1 → A#2 */
function indirectFourTerminal() {
  return {
    terminals: ['A', 'B', 'C', 'D'],
    messages: [
      { id: 'A#1', kind: 'add', dot: 'D-01', tag: tag('Z-1'), ctx: { A: 1 } },
      { id: 'A#2', kind: 'remove', zone: 'Z-1', ctx: { A: 2, C: 1 } },
      { id: 'B#1', kind: 'add', dot: 'D-02', tag: tag('Z-2'), ctx: { B: 1, D: 1 } },
      { id: 'C#1', kind: 'add', dot: 'D-03', tag: tag('Z-3'), ctx: { C: 1, B: 1 } },
      { id: 'D#1', kind: 'add', dot: 'D-04', tag: tag('Z-4'), ctx: { D: 1, A: 2 } },
    ],
    inbox: {
      A: ['A#1', 'A#2', 'B#1', 'C#1', 'D#1'],
      B: ['B#1', 'D#1', 'C#1', 'A#1', 'A#2'],
      C: ['C#1', 'B#1', 'A#2', 'D#1', 'A#1'],
      D: ['D#1', 'A#1', 'A#2', 'B#1', 'C#1'],
    },
  };
}

function expectCycleRejected(raw: unknown, members: string[]) {
  const r = runReplay(raw);
  expect(r.ok, `应整体拒绝：${JSON.stringify(r)}`).toBe(false);
  if (r.ok) return;
  // 不产生任何回放步骤
  expect('steps' in r).toBe(false);
  // 定位为非法上下文，且错误位置可读（指向具体消息的 ctx）
  const e = r.errors.find((x) => x.message.includes('因果依赖成环'));
  expect(e, `应报告因果环错误，实际：${JSON.stringify(r.errors)}`).toBeDefined();
  expect(e!.message).toContain('非法上下文');
  expect(e!.path).toMatch(/^\$\.messages\[[A-Za-z0-9_-]+#\d+\]\.ctx$/);
  // 环上每个成员都应在错误描述中可见
  for (const m of members) expect(e!.message).toContain(m);
}

describe('因果环拒绝：不存在真实发生顺序的操作脚本', () => {
  it('两终端互相依赖：整体拒绝、定位可读、不产生回放步骤', () => {
    expectCycleRejected(mutualTwoTerminal(), ['A#2', 'B#1']);
    // parseScenario 层面同样拒绝
    const p = parseScenario(mutualTwoTerminal());
    expect(p.ok).toBe(false);
  });

  it('更长的间接依赖链（三终端环）：整体拒绝且不产生回放步骤', () => {
    expectCycleRejected(indirectThreeTerminal(), ['A#2', 'C#1', 'B#1']);
  });

  it('更长的间接依赖链（四终端环）：整体拒绝且不产生回放步骤', () => {
    expectCycleRejected(indirectFourTerminal(), ['A#2', 'C#1', 'B#1', 'D#1']);
  });

  it('不成环的跨终端观察仍得到既有稳定结果（add-wins + 乱序释放 + 重复幂等）', () => {
    // B#1 见过 A#1（跨终端观察但不成环）；A#2 撤销时未见过 B#1；
    // B 的收件乱序（先收到 A#2、B#1 再收到 A#1），A 的收件含重复投递。
    const r = runReplay({
      terminals: ['A', 'B'],
      messages: [
        { id: 'A#1', kind: 'add', dot: 'D-01', tag: tag('Z-1'), ctx: { A: 1 } },
        { id: 'B#1', kind: 'add', dot: 'D-02', tag: tag('Z-1'), ctx: { B: 1, A: 1 } },
        { id: 'A#2', kind: 'remove', zone: 'Z-1', ctx: { A: 2 } },
      ],
      inbox: {
        A: ['A#1', 'A#1', 'B#1', 'A#2'],
        B: ['A#2', 'B#1', 'A#1'],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.converged).toBe(true);
    // add-wins：A#2 的撤销只覆盖 A#1，并发新增 D-02 存活
    expect(r.finalZones).toEqual(['Z-1']);
    const last = r.steps[r.steps.length - 1].stateAfter;
    for (const t of r.terminals) {
      expect(last[t].zones.find((z) => z.zone === 'Z-1')?.dots.map((d) => d.dot)).toEqual([
        'D-02',
      ]);
      expect(last[t].pending).toEqual([]);
    }
    // 乱序暂存后释放
    expect(r.steps.some((s) => s.terminal === 'B' && s.messageId === 'A#2' && s.action === 'buffered')).toBe(true);
    expect(r.steps.some((s) => s.terminal === 'B' && s.messageId === 'A#2' && s.action === 'released')).toBe(true);
    // 重复投递幂等
    expect(r.steps.some((s) => s.messageId === 'A#1' && s.action === 'duplicate')).toBe(true);
  });
});
