import { describe, expect, it } from 'vitest';
import { runReplay } from '../src/crdt/replay';
import type { TerminalView } from '../src/crdt/types';
import { SAMPLES } from '../src/samples';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rnd: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 独立复核：末步快照中所有终端的有效标签一致且暂存清空 */
function assertConvergedIndependently(
  terminals: string[],
  stateAfter: Record<string, TerminalView>,
) {
  const zoneSets = terminals.map((t) => JSON.stringify(stateAfter[t].zones.map((z) => z.zone)));
  expect(new Set(zoneSets).size).toBe(1);
  for (const t of terminals) expect(stateAfter[t].pending).toEqual([]);
}

describe('回放：收敛、暂存释放、重复幂等', () => {
  it('样例1：并发新增与撤销收敛（add-wins）', () => {
    const r = runReplay(SAMPLES[0].data);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.converged).toBe(true);
    expect(r.finalZones).toEqual(['Z-ALPHA', 'Z-BETA']);
    // A#2 的撤销只见过 A#1：B#1 的并发点 D-02 必须存活
    const last = r.steps[r.steps.length - 1].stateAfter;
    for (const t of r.terminals) {
      const alpha = last[t].zones.find((z) => z.zone === 'Z-ALPHA');
      expect(alpha?.dots.map((d) => d.dot)).toEqual(['D-02']);
    }
    assertConvergedIndependently(r.terminals, last);
    // 该样例中 B、C 均出现乱序暂存并随后释放
    expect(r.steps.some((s) => s.action === 'buffered' && s.messageId === 'A#2')).toBe(true);
    expect(r.steps.some((s) => s.action === 'released' && s.messageId === 'A#2')).toBe(true);
    expect(r.steps.some((s) => s.action === 'released' && s.messageId === 'C#1')).toBe(true);
  });

  it('样例2：乱序暂存释放后收敛', () => {
    const r = runReplay(SAMPLES[1].data);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.converged).toBe(true);
    expect(r.finalZones).toEqual(['Z-SOUTH']);
    // B#2 在 A、B 两台都先缺前序被暂存，随后被释放
    for (const t of ['A', 'B']) {
      const buffered = r.steps.find(
        (s) => s.terminal === t && s.messageId === 'B#2' && s.action === 'buffered',
      );
      const released = r.steps.find(
        (s) => s.terminal === t && s.messageId === 'B#2' && s.action === 'released',
      );
      expect(buffered, `终端 ${t} 应暂存 B#2`).toBeDefined();
      expect(released, `终端 ${t} 应释放 B#2`).toBeDefined();
      expect(released!.index).toBeGreaterThan(buffered!.index);
    }
    assertConvergedIndependently(r.terminals, r.steps[r.steps.length - 1].stateAfter);
  });

  it('样例3：重复投递幂等且四终端收敛', () => {
    const r = runReplay(SAMPLES[2].data);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.converged).toBe(true);
    expect(r.finalZones).toEqual(['Z-1', 'Z-2']);
    const dups = r.steps.filter((s) => s.action === 'duplicate');
    expect(dups.length).toBeGreaterThanOrEqual(3);
    // 每个重复步骤前后，版本向量 / 有效标签 / 暂存队列完全不变
    const pick = (snap: Record<string, TerminalView>) =>
      Object.fromEntries(
        Object.entries(snap).map(([k, v]) => [
          k,
          { vector: v.vector, zones: v.zones, pending: v.pending },
        ]),
      );
    for (const d of dups) {
      const prev = r.steps[d.index - 1];
      expect(prev, '重复步骤之前应已有其他步骤').toBeDefined();
      expect(pick(d.stateAfter)).toEqual(pick(prev.stateAfter));
    }
    assertConvergedIndependently(r.terminals, r.steps[r.steps.length - 1].stateAfter);
  });

  it('任意乱序收件（含重复）均收敛到同一结果', () => {
    for (let iter = 0; iter < 20; iter += 1) {
      const rnd = mulberry32(iter + 1);
      const clone = structuredClone(SAMPLES[2].data) as {
        terminals: string[];
        inbox: Record<string, string[]>;
      };
      for (const t of clone.terminals) clone.inbox[t] = shuffle(clone.inbox[t], rnd);
      const r = runReplay(clone);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.converged, `第 ${iter} 轮乱序应收敛`).toBe(true);
      expect(r.finalZones).toEqual(['Z-1', 'Z-2']);
    }
  });

  it('内置样例：前三个合法且收敛，因果环样例被拒绝', () => {
    for (let i = 0; i < 3; i += 1) {
      const r = runReplay(SAMPLES[i].data);
      expect(r.ok, `样例 ${SAMPLES[i].name} 应合法`).toBe(true);
      if (r.ok) expect(r.converged, `样例 ${SAMPLES[i].name} 应收敛`).toBe(true);
    }
    const bad = runReplay(SAMPLES[3].data);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.map((e) => e.message).join('\n')).toContain('互相依赖成环');
    }
  });

  it('回放是确定性的：同一场景两次运行结果一致', () => {
    const a = runReplay(SAMPLES[0].data);
    const b = runReplay(SAMPLES[0].data);
    expect(a).toEqual(b);
  });

  it('非法场景整体拒绝且不产生步骤', () => {
    const bad = structuredClone(SAMPLES[0].data) as {
      messages: Array<{ id: string; dot?: string }>;
    };
    bad.messages[1].dot = 'D-01'; // B#1 复用 A#1 的点标识，但载荷（Z-ALPHA 不同坐标）不同
    const r = runReplay(bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.message.includes('点标识复用'))).toBe(true);
    expect('steps' in r).toBe(false);
  });

  it('两终端互相依赖的因果环：整体拒绝、清除旧回放、不产生任何步骤', () => {
    const cyclic = {
      terminals: ['A', 'B'],
      messages: [
        {
          id: 'A#1',
          kind: 'add',
          dot: 'D-01',
          tag: { zone: 'Z-1', lat: 39.9, lng: 116.4, radiusKm: 3 },
          ctx: { A: 1 },
        },
        {
          // B 的首条新增声称已经见过 A 随后的撤销
          id: 'B#1',
          kind: 'add',
          dot: 'D-02',
          tag: { zone: 'Z-1', lat: 39.8, lng: 116.3, radiusKm: 3 },
          ctx: { B: 1, A: 2 },
        },
        // A 的后续撤销又声称已经见过 B 的新增
        { id: 'A#2', kind: 'remove', zone: 'Z-1', ctx: { A: 2, B: 1 } },
      ],
      inbox: {
        A: ['A#1', 'A#2', 'B#1'],
        B: ['B#1', 'A#2', 'A#1'],
      },
    };
    const r = runReplay(cyclic);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const joined = r.errors.map((e) => `${e.path} ${e.message}`).join('\n');
    expect(joined).toContain('互相依赖成环');
    expect(joined).toContain('不能按乱序投递处理');
    expect(r.errors.some((e) => e.path === '$.messages[B#1].ctx')).toBe(true);
    expect(r.errors.some((e) => e.path === '$.messages[A#2].ctx')).toBe(true);
    // 拒绝结果不得携带任何回放步骤 / 收敛结论
    expect('steps' in r).toBe(false);
    expect('converged' in r).toBe(false);
    expect('finalZones' in r).toBe(false);
  });

  it('更长的间接依赖链（A#2→C#1→B#1→A#2）：整体拒绝且不产生步骤', () => {
    const tag = { zone: 'Z-1', lat: 39.9, lng: 116.4, radiusKm: 3 };
    const cyclic = {
      terminals: ['A', 'B', 'C'],
      messages: [
        { id: 'A#1', kind: 'add', dot: 'D-01', tag, ctx: { A: 1 } },
        { id: 'A#2', kind: 'remove', zone: 'Z-1', ctx: { A: 2, B: 1 } },
        { id: 'B#1', kind: 'add', dot: 'D-02', tag, ctx: { B: 1, C: 1 } },
        { id: 'C#1', kind: 'add', dot: 'D-03', tag, ctx: { C: 1, A: 2 } },
      ],
      inbox: {
        A: ['A#1', 'A#2', 'B#1', 'C#1'],
        B: ['B#1', 'A#1', 'C#1', 'A#2'],
        C: ['C#1', 'A#1', 'B#1', 'A#2'],
      },
    };
    const r = runReplay(cyclic);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.message).join('\n')).toContain('互相依赖成环');
    expect('steps' in r).toBe(false);
  });

  it('普通非法上下文仍被定位拒绝（回归）', () => {
    const bad = structuredClone(SAMPLES[1].data) as {
      messages: Array<{ id: string; ctx: Record<string, number> }>;
    };
    bad.messages[0].ctx = { A: 2 }; // ctx[自身] ≠ 自身序号
    const rejected = runReplay(bad);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.errors.some((e) => e.message.includes('自身序号'))).toBe(true);
    expect('steps' in rejected).toBe(false);
  });
});
