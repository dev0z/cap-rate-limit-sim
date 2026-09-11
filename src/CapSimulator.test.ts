import { describe, expect, it } from 'vitest';
import {
  BURST, DEFAULT_CONFIG, LIMIT, N, PRESETS, createSim, stepSim,
  type MetricsSample, type SimConfig,
} from './CapSimulator';

const NONE = [false, false, false, false];
const cut = (node: number) => NONE.map((_, i) => i === node);
const cfg = (over: Partial<SimConfig>): SimConfig => ({ ...DEFAULT_CONFIG, skew: 0, ...over });
const between = (t: number, a: number, b: number) => t >= a && t <= b;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => sum(xs) / xs.length;

// Steps the engine with a per-tick config and keeps every sample (state.history is capped).
function run(seed: number, ticks: number, at: (t: number) => SimConfig) {
  let state = createSim(at(1), seed);
  const samples: MetricsSample[] = [];
  for (let t = 1; t <= ticks; t++) {
    state = stepSim(state, at(t));
    samples.push(state.history[state.history.length - 1]);
  }
  return { state, samples };
}

describe('engine', () => {
  it('is deterministic for a seed', () => {
    const at = () => cfg({ ...PRESETS.flash, mode: 'ap' });
    expect(run(7, 200, at).samples).toEqual(run(7, 200, at).samples);
  });

  it('conserves requests and window sums in every mode, with and without a partition', () => {
    for (const mode of ['ap', 'cp', 'static'] as const) {
      const { samples } = run(1, 200, (t) =>
        cfg({ mode, ratePerNode: 400, gossipMs: 400, partitioned: between(t, 50, 120) ? cut(3) : NONE }));
      samples.forEach((s, i) => {
        expect(s.incoming).toBe(s.admitted + s.rejected + s.failed);
        for (const n of s.nodes) expect(n.incoming).toBe(n.admitted + n.rejected + n.failed);
        expect(s.truthWindow).toBe(sum(samples.slice(Math.max(0, i - 4), i + 1).map((x) => x.admitted)));
      });
    }
  });

  it('CP never exceeds the limit, even under skew and flash crowds', () => {
    const { samples } = run(3, 400, () =>
      cfg({ mode: 'cp', ratePerNode: 500, skew: 0.4, burst: { ...BURST, everyTicks: 40 } }));
    for (const s of samples) expect(s.truthWindow).toBeLessThanOrEqual(LIMIT);
    expect(samples[samples.length - 1].debt).toBe(0);
  });

  it('admits everything when traffic is well under the limit', () => {
    const modes: Partial<SimConfig>[] = [
      { mode: 'ap', gossipMs: 200 }, { mode: 'ap', gossipMs: 2000 }, { mode: 'cp' }, { mode: 'static' },
    ];
    for (const m of modes) {
      const { samples } = run(5, 200, () => cfg({ ...m, ratePerNode: 120, skew: 0.3 }));
      for (const s of samples) {
        expect(s.rejected).toBe(0);
        expect(s.failed).toBe(0);
      }
      expect(samples[samples.length - 1].debt).toBe(0);
      expect(samples[samples.length - 1].under).toBe(0);
    }
  });

  it('AP overshoot grows with the gossip interval and plateaus past the window', () => {
    const debt = (gossipMs: number) =>
      run(11, 300, () => cfg({ mode: 'ap', gossipMs, ratePerNode: 500 })).samples[299].debt;
    const d200 = debt(200), d1000 = debt(1000), d2000 = debt(2000);
    expect(d200).toBeGreaterThan(0);
    expect(d1000).toBeGreaterThanOrEqual(2 * d200);
    expect(d2000).toBeGreaterThanOrEqual(0.9 * d1000);
  });

  it('AP at every-tick gossip still sits above the limit (four nodes fill one budget at once)', () => {
    const { samples } = run(11, 300, () => cfg({ mode: 'ap', gossipMs: 200, ratePerNode: 500 }));
    const m = mean(samples.slice(20).map((s) => s.truthWindow));
    expect(m).toBeGreaterThan(1050);
    expect(m).toBeLessThan(1450);
  });

  it('a partitioned CP node fails closed and the count stays exact', () => {
    const { state, samples } = run(2, 81, (t) =>
      cfg({ mode: 'cp', ratePerNode: 300, partitioned: between(t, 20, 80) ? cut(3) : NONE }));
    const during = samples.filter((s) => between(s.tick, 20, 80));
    for (const s of during) {
      expect(s.nodes[3].admitted).toBe(0);
      expect(s.nodes[3].failed).toBe(s.nodes[3].incoming);
      for (let i = 0; i < 3; i++) expect(s.nodes[i].failed).toBe(0);
      expect(s.truthWindow).toBeLessThanOrEqual(LIMIT);
    }
    const availability = 1 - sum(during.map((s) => s.failed)) / sum(during.map((s) => s.incoming));
    expect(availability).toBeGreaterThan(0.7);
    expect(availability).toBeLessThan(0.8);
    expect(state.lastReport?.node).toBe(3);
    expect(state.lastReport?.failed).toBeGreaterThan(0);
    expect(state.lastReport?.excess).toBe(0);
  });

  it('a partitioned AP node keeps serving from an aging view and the system overshoots more', () => {
    const at = (cutIt: boolean) => (t: number) =>
      cfg({ mode: 'ap', gossipMs: 400, ratePerNode: 500, partitioned: cutIt && between(t, 20, 100) ? cut(3) : NONE });
    const withCut = run(2, 101, at(true));
    const noCut = run(2, 101, at(false));
    for (const s of withCut.samples) expect(s.failed).toBe(0);
    for (const s of withCut.samples.filter((x) => between(x.tick, 26, 100))) expect(s.nodes[3].admitted).toBeGreaterThan(0);
    expect(withCut.samples[99].nodes[3].viewAgeTicks).toBeGreaterThanOrEqual(60);
    expect(withCut.samples[100].debt).toBeGreaterThan(noCut.samples[100].debt);
    expect(withCut.state.lastReport?.node).toBe(3);
    expect(withCut.state.lastReport?.excess).toBeGreaterThan(0);
  });

  it('ticket sale: CP sells exactly the inventory, AP oversells', () => {
    const base = { windowTicks: Infinity, ratePerNode: 300 };
    const cp = run(4, 100, () => cfg({ ...base, mode: 'cp' })).state;
    expect(cp.cum.admitted).toBe(LIMIT);
    const ap = run(4, 100, () => cfg({ ...base, mode: 'ap', gossipMs: 1000 })).state;
    expect(ap.cum.admitted).toBeGreaterThan(LIMIT);
    expect(ap.cum.admitted).toBeLessThan(N * LIMIT);
  });
});
