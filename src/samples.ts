/** 内置样例场景：并发新增/撤销收敛、乱序暂存释放、重复投递幂等、因果环整体拒绝 */

export interface Sample {
  name: string;
  data: unknown;
}

const concurrentAddRemove = {
  terminals: ['A', 'B', 'C'],
  messages: [
    {
      id: 'A#1',
      kind: 'add',
      dot: 'D-01',
      tag: { zone: 'Z-ALPHA', lat: 39.904, lng: 116.407, radiusKm: 3 },
      ctx: { A: 1 },
    },
    {
      id: 'B#1',
      kind: 'add',
      dot: 'D-02',
      tag: { zone: 'Z-ALPHA', lat: 39.905, lng: 116.408, radiusKm: 3 },
      ctx: { B: 1 },
    },
    { id: 'A#2', kind: 'remove', zone: 'Z-ALPHA', ctx: { A: 2 } },
    {
      id: 'C#1',
      kind: 'add',
      dot: 'D-03',
      tag: { zone: 'Z-BETA', lat: 31.23, lng: 121.47, radiusKm: 5 },
      ctx: { C: 1, A: 1 },
    },
  ],
  inbox: {
    A: ['A#1', 'A#2', 'B#1', 'C#1'],
    B: ['B#1', 'A#2', 'A#1', 'C#1'],
    C: ['C#1', 'A#1', 'B#1', 'A#2'],
  },
};

const outOfOrderRelease = {
  terminals: ['A', 'B'],
  messages: [
    {
      id: 'A#1',
      kind: 'add',
      dot: 'D-11',
      tag: { zone: 'Z-NORTH', lat: 40.1, lng: 116.9, radiusKm: 2 },
      ctx: { A: 1 },
    },
    {
      id: 'B#1',
      kind: 'add',
      dot: 'D-12',
      tag: { zone: 'Z-SOUTH', lat: 22.5, lng: 114.0, radiusKm: 4 },
      ctx: { B: 1 },
    },
    { id: 'B#2', kind: 'remove', zone: 'Z-NORTH', ctx: { B: 2, A: 1 } },
  ],
  inbox: {
    A: ['A#1', 'B#2', 'B#1'],
    B: ['B#2', 'B#1', 'A#1'],
  },
};

const duplicateDelivery = {
  terminals: ['A', 'B', 'C', 'D'],
  messages: [
    {
      id: 'A#1',
      kind: 'add',
      dot: 'D-21',
      tag: { zone: 'Z-1', lat: 30.6, lng: 104.0, radiusKm: 2 },
      ctx: { A: 1 },
    },
    {
      id: 'B#1',
      kind: 'add',
      dot: 'D-22',
      tag: { zone: 'Z-1', lat: 30.7, lng: 104.1, radiusKm: 2 },
      ctx: { B: 1 },
    },
    { id: 'C#1', kind: 'remove', zone: 'Z-1', ctx: { C: 1, A: 1 } },
    {
      id: 'D#1',
      kind: 'add',
      dot: 'D-23',
      tag: { zone: 'Z-2', lat: 23.1, lng: 113.3, radiusKm: 6 },
      ctx: { D: 1, B: 1 },
    },
  ],
  inbox: {
    A: ['A#1', 'A#1', 'B#1', 'C#1', 'D#1', 'C#1'],
    B: ['B#1', 'A#1', 'C#1', 'D#1', 'D#1'],
    C: ['C#1', 'A#1', 'B#1', 'D#1'],
    D: ['D#1', 'B#1', 'A#1', 'C#1', 'A#1'],
  },
};

const cyclicDependency = {
  // 非法场景：B#1 声称已见 A#2，而 A#2 又声称已见 B#1 —— 因果上下文互相
  // 依赖成环，不存在真实发生顺序，必须整体拒绝、清除旧回放（不产生任何步骤）。
  terminals: ['A', 'B'],
  messages: [
    {
      id: 'A#1',
      kind: 'add',
      dot: 'D-31',
      tag: { zone: 'Z-LOOP', lat: 39.9, lng: 116.4, radiusKm: 3 },
      ctx: { A: 1 },
    },
    {
      id: 'B#1',
      kind: 'add',
      dot: 'D-32',
      tag: { zone: 'Z-LOOP', lat: 39.8, lng: 116.3, radiusKm: 3 },
      ctx: { B: 1, A: 2 },
    },
    { id: 'A#2', kind: 'remove', zone: 'Z-LOOP', ctx: { A: 2, B: 1 } },
  ],
  inbox: {
    A: ['A#1', 'A#2', 'B#1'],
    B: ['B#1', 'A#2', 'A#1'],
  },
};

export const SAMPLES: Sample[] = [
  { name: '并发新增与撤销（add-wins 收敛）', data: concurrentAddRemove },
  { name: '乱序投递与暂存释放', data: outOfOrderRelease },
  { name: '重复投递幂等（四终端）', data: duplicateDelivery },
  { name: '因果环（非法，应整体拒绝）', data: cyclicDependency },
];
