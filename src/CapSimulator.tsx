import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Activity, Check, ChevronLeft, ChevronRight, Clock, CloudLightning, Database, Flame, Gauge, Globe, GraduationCap, Hourglass, Info,
  Link2, Pause, Play, Radio, RotateCcw, Scale, Scissors, Server, Share2, ShieldCheck, Ticket, Timer, TriangleAlert, Unplug, Waves, X, Zap,
} from 'lucide-react';

// ───────────────────────────── Engine ─────────────────────────────
// Pure functions. Time is discrete: one tick = 200 ms. The UI never mutates SimState.

export const N = 4;
export const TICK_MS = 200;
export const WINDOW_TICKS = 5;
export const LIMIT = 1000;
export const HISTORY = 150;
export const TICKET_RATE_SCALE = 0.1;  // ticket sale: buyers/s per site = slider / 10, so a drop lasts seconds, not ticks
export const DROP_HOLD_TICKS = 25;     // pause after a sold-out drop before the next one starts

export const NODES = [
  { code: 'IAD', city: 'Virginia', rttMs: 15 },
  { code: 'FRA', city: 'Frankfurt', rttMs: 90 },
  { code: 'GRU', city: 'São Paulo', rttMs: 120 },
  { code: 'NRT', city: 'Tokyo', rttMs: 160 },
];

export type Mode = 'ap' | 'cp' | 'static';
export interface BurstSpec { mult: number; durationTicks: number; everyTicks: number }
export interface SimConfig {
  mode: Mode;
  ratePerNode: number;   // mean incoming req/s per node
  gossipMs: number;      // AP sync interval, 200..2000
  limit: number;
  windowTicks: number;   // WINDOW_TICKS, or Infinity for a counter that never refills
  skew: number;          // 0..0.6 amplitude of the wandering hot region
  burst: BurstSpec | null;
  partitioned: boolean[];
}
export type Bucket = [tick: number, count: number];
export interface Report { atTick: number; buckets: Bucket[] }
export interface NodeState { ring: number[]; total: number; known: (Report | null)[]; lastPullTick: number }
export interface NodeSample {
  incoming: number; admitted: number; rejected: number; failed: number;
  latencyMs: number; belief: number; viewAgeTicks: number; windowAdmitted: number; bursting: boolean;
}
export interface MetricsSample {
  tick: number; incoming: number; admitted: number; rejected: number; failed: number;
  offeredWindow: number; truthWindow: number; storeWindow: number; overshoot: number;
  availability: number; latencyMs: number; debt: number; under: number;
  nodes: NodeSample[]; cut?: number; healed?: number; burstStart?: number; dropStart?: boolean;
}
export interface PartitionReport { node: number; durationTicks: number; excess: number; failed: number }
// One ticket-sale run: 1000 seats offered, sold until every site stops selling.
export interface DropRecord { n: number; mode: Mode; gossipMs: number; cut: number[]; sold: number; failed: number; durationTicks: number; latencyMs: number }
export interface DropState { n: number; startTick: number; closedAt: number | null; failed: number; latencySum: number; answered: number }
export interface TickEvents { synced: number[]; cpRoundTrips: number[]; burstStartedOn: number | null; healed: PartitionReport | null }
export interface SimState {
  tick: number; seed: number; rngTraffic: number; rngLatency: number;
  mode: Mode; windowTicks: number;
  nodes: NodeState[]; hub: (Report | null)[];
  idealRing: number[]; idealTotal: number;
  burst: { node: number; start: number; end: number; mult: number } | null; lastBurstEnd: number;
  partitionSince: (number | null)[]; debtAtCut: number[]; failedAtCut: number[]; nodeFailed: number[];
  cum: { incoming: number; admitted: number; ideal: number; failed: number };
  ledger: { admitted: number; ideal: number };   // cum snapshot at the last mode switch; debt is per mode
  drop: DropState; drops: DropRecord[];          // ticket sale only; inert for the rate limiter
  history: MetricsSample[]; events: TickEvents; lastReport: PartitionReport | null;
}

const NONE = [false, false, false, false];
export const DEFAULT_CONFIG: SimConfig = {
  mode: 'ap', ratePerNode: 300, gossipMs: 600, limit: LIMIT, windowTicks: WINDOW_TICKS,
  skew: 0.2, burst: null, partitioned: NONE,
};
export const BURST: BurstSpec = { mult: 3, durationTicks: 20, everyTicks: 60 };
const CUT_NRT = [false, false, false, true];
export const PRESETS: Record<'calm' | 'max' | 'flash' | 'fast' | 'slow' | 'quiet' | 'storm', Partial<SimConfig>> = {
  calm: { ratePerNode: 150, gossipMs: 600, skew: 0.15, burst: null, partitioned: NONE },
  max: { ratePerNode: 500, gossipMs: 600, skew: 0.3, burst: null, partitioned: NONE },
  flash: { ratePerNode: 230, gossipMs: 600, skew: 0.2, burst: BURST, partitioned: NONE },
  fast: { ratePerNode: 500, gossipMs: 200, skew: 0.2, burst: null, partitioned: NONE },
  slow: { ratePerNode: 400, gossipMs: 2000, skew: 0.2, burst: null, partitioned: NONE },
  quiet: { ratePerNode: 150, gossipMs: 600, skew: 0.15, burst: null, partitioned: CUT_NRT },
  storm: { ratePerNode: 500, gossipMs: 400, skew: 0.3, burst: null, partitioned: CUT_NRT },
};

const zeros = () => new Array<number>(N).fill(0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// mulberry32 with explicit state so the engine stays pure.
function rand(state: number): [u: number, next: number] {
  const s = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), s | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

function gaussian(rnd: () => number): number {
  const u = rnd() || 1e-12;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

function poisson(lambda: number, rnd: () => number): number {
  if (lambda <= 0) return 0;
  if (lambda < 30) {
    const floor = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= rnd(); } while (p > floor);
    return k - 1;
  }
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gaussian(rnd)));
}

// Slow sinusoids with distinct periods: one region is always hot and the hot spot wanders.
const PERIODS = [185, 265, 355, 485];
function weights(t: number, skew: number): number[] {
  const w = PERIODS.map((p, i) => 1 + skew * Math.sin((2 * Math.PI * t) / p + (i * Math.PI) / 2));
  const mean = sum(w) / N;
  return w.map((x) => x / mean);
}

// Trapezoid: 25 % ramp up, hold, 25 % ramp down.
function burstMult(b: SimState['burst'], node: number, t: number): number {
  if (!b || b.node !== node || t < b.start || t > b.end) return 1;
  const x = (t - b.start) / Math.max(1, b.end - b.start);
  const f = x < 0.25 ? x / 0.25 : x > 0.75 ? (1 - x) / 0.25 : 1;
  return 1 + (b.mult - 1) * f;
}

const inWindow = (tk: number, t: number, W: number) => W === Infinity || tk > t - W;

// What a set of gossiped reports says about the current window. Old buckets fall out on their own.
function reportSum(reports: (Report | null)[], t: number, W: number): number {
  let s = 0;
  for (const r of reports) if (r) for (const [tk, c] of r.buckets) if (inWindow(tk, t, W)) s += c;
  return s;
}

// Ticks since the node last heard anything from its peers. Infinity = never.
export function viewAge(n: NodeState, self: number, t: number): number {
  let newest = -1;
  for (let j = 0; j < N; j++) if (j !== self && n.known[j]) newest = Math.max(newest, n.known[j]!.atTick);
  return newest < 0 ? Infinity : t - newest;
}

export function createSim(config: SimConfig, seed: number): SimState {
  const W = config.windowTicks;
  const len = Number.isFinite(W) ? W : 1;
  return {
    tick: 0, seed, rngTraffic: seed >>> 0, rngLatency: (seed ^ 0x9e3779b9) >>> 0,
    mode: config.mode, windowTicks: W,
    nodes: Array.from({ length: N }, () => ({
      ring: new Array<number>(len).fill(0), total: 0, known: new Array<Report | null>(N).fill(null), lastPullTick: -1,
    })),
    hub: new Array<Report | null>(N).fill(null),
    idealRing: new Array<number>(len).fill(0), idealTotal: 0,
    burst: null, lastBurstEnd: -40,
    partitionSince: new Array<number | null>(N).fill(null), debtAtCut: zeros(), failedAtCut: zeros(), nodeFailed: zeros(),
    cum: { incoming: 0, admitted: 0, ideal: 0, failed: 0 }, ledger: { admitted: 0, ideal: 0 },
    drop: { n: 1, startTick: 1, closedAt: null, failed: 0, latencySum: 0, answered: 0 }, drops: [],
    history: [], events: { synced: [], cpRoundTrips: zeros(), burstStartedOn: null, healed: null }, lastReport: null,
  };
}

// Clears every counter for a fresh ticket drop; history, ledgers and partitions carry on.
function newDrop(s: SimState, startTick: number): SimState {
  const len = s.nodes[0].ring.length;
  return {
    ...s, hub: new Array<Report | null>(N).fill(null), idealRing: new Array<number>(len).fill(0), idealTotal: 0, burst: null,
    nodes: s.nodes.map(() => ({ ring: new Array<number>(len).fill(0), total: 0, known: new Array<Report | null>(N).fill(null), lastPullTick: -1 })),
    drop: { n: s.drop.n + 1, startTick, closedAt: null, failed: 0, latencySum: 0, answered: 0 },
  };
}
export const restartDrop = (s: SimState): SimState => newDrop(s, s.tick + 1);

export function stepSim(prev0: SimState, config: SimConfig): SimState {
  if (config.windowTicks !== prev0.windowTicks) return stepSim(createSim(config, prev0.seed), config);
  const t = prev0.tick + 1;
  const { limit: L, windowTicks: W } = config;
  const finite = Number.isFinite(W);
  const slot = finite ? t % W : 0;
  const prev = !finite && prev0.drop.closedAt !== null && t - prev0.drop.closedAt >= DROP_HOLD_TICKS ? newDrop(prev0, t) : prev0;
  let rt = prev.rngTraffic, rl = prev.rngLatency;
  const rndT = () => { const [u, s] = rand(rt); rt = s; return u; };
  const rndL = () => { const [u, s] = rand(rl); rl = s; return u; };

  // 1. Flash crowds.
  let burst = prev.burst, lastBurstEnd = prev.lastBurstEnd, burstStartedOn: number | null = null;
  if (burst && t > burst.end) { burst = null; lastBurstEnd = t; }
  if (!burst && config.burst && t - lastBurstEnd >= config.burst.everyTicks) {
    burstStartedOn = Math.floor(rndT() * N);
    burst = { node: burstStartedOn, start: t, end: t + config.burst.durationTicks, mult: config.burst.mult };
  }

  // 2. Arrivals.
  const w = weights(t, config.skew);
  const rate = config.ratePerNode * (finite ? 1 : TICKET_RATE_SCALE);
  const incoming = w.map((wi, i) => poisson(rate * wi * burstMult(burst, i, t) * (TICK_MS / 1000), rndT));
  const incomingTotal = sum(incoming);

  // 3. An omniscient limiter on the same arrivals: the baseline for the ledgers.
  const idealExcl = finite ? sum(prev.idealRing) - prev.idealRing[slot] : prev.idealTotal;
  const idealAdmit = Math.min(incomingTotal, Math.max(0, L - idealExcl));

  // 4. Admission. Beliefs are whatever was pulled at the end of earlier ticks.
  const own = prev.nodes.map((n) => (finite ? sum(n.ring) - n.ring[slot] : n.total));
  const admitted = zeros(), rejected = zeros(), failed = zeros();
  if (config.mode === 'cp') {
    const room = Math.max(0, L - sum(own));
    const offered = sum(incoming.map((x, i) => (config.partitioned[i] ? 0 : x)));
    const grant = Math.min(offered, room);
    // Proportional share with largest-remainder rounding: atomic increments interleaving within one tick.
    const raw = incoming.map((x, i) => (config.partitioned[i] || offered === 0 ? 0 : (grant * x) / offered));
    const share = raw.map(Math.floor);
    let rest = grant - sum(share);
    const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (const [, i] of order) { if (rest <= 0) break; share[i]++; rest--; }
    for (let i = 0; i < N; i++) {
      if (config.partitioned[i]) failed[i] = incoming[i];
      else { admitted[i] = share[i]; rejected[i] = incoming[i] - share[i]; }
    }
  } else {
    for (let i = 0; i < N; i++) {
      const budget = config.mode === 'ap'
        ? L - own[i] - reportSum(prev.nodes[i].known, t, W)
        : Math.floor(L / N) - own[i];
      admitted[i] = Math.min(incoming[i], Math.max(0, budget));
      rejected[i] = incoming[i] - admitted[i];
    }
  }
  const admittedTotal = sum(admitted);

  // 5. Write counters.
  const nodes = prev.nodes.map((n, i) => ({
    ...n, ring: finite ? n.ring.map((v, k) => (k === slot ? admitted[i] : v)) : n.ring, total: n.total + admitted[i],
  }));
  const idealRing = finite ? prev.idealRing.map((v, k) => (k === slot ? idealAdmit : v)) : prev.idealRing;
  const idealTotal = prev.idealTotal + idealAdmit;

  // 6. Gossip (AP only) after admission, so a report includes this tick. All pushes, then all pulls.
  const hub = prev.hub.slice();
  const synced: number[] = [];
  if (config.mode === 'ap') {
    const k = Math.max(1, Math.round(config.gossipMs / TICK_MS));
    const force = prev.mode !== 'ap';
    const due = nodes.map((_, i) =>
      !config.partitioned[i] && (force || prev.partitionSince[i] !== null || (((t - Math.floor((i * k) / N)) % k) + k) % k === 0));
    for (let i = 0; i < N; i++) if (due[i]) {
      const buckets: Bucket[] = finite
        ? Array.from({ length: W }, (_, j) => { const tk = t - W + 1 + j; return [tk, nodes[i].ring[((tk % W) + W) % W]]; })
        : [[t, nodes[i].total]];
      hub[i] = { atTick: t, buckets };
    }
    for (let i = 0; i < N; i++) if (due[i]) {
      nodes[i] = { ...nodes[i], known: hub.map((r, j) => (j === i ? null : r)), lastPullTick: t };
      synced.push(i);
    }
  }

  // 7. Decision latency: one draw per node per tick. Failed requests get no answer, so no latency.
  const latency = NODES.map((n) =>
    config.mode === 'cp' ? Math.max(0.5 * n.rttMs, n.rttMs * (1 + 0.15 * gaussian(rndL)) + 2) : 1 + rndL());
  const answered = admitted.map((a, i) => a + rejected[i]);
  const answeredTotal = sum(answered);
  const latencyMs = answeredTotal ? sum(latency.map((l, i) => l * answered[i])) / answeredTotal : 0;

  // 8. Metrics.
  const windowAdmitted = nodes.map((n) => (finite ? sum(n.ring) : n.total));
  const truthWindow = sum(windowAdmitted);
  const storeWindow = config.mode === 'cp' ? truthWindow : reportSum(hub, t, W);
  const cum = {
    incoming: prev.cum.incoming + incomingTotal, admitted: prev.cum.admitted + admittedTotal,
    ideal: prev.cum.ideal + idealAdmit, failed: prev.cum.failed + sum(failed),
  };
  const ledger = prev.mode === config.mode ? prev.ledger : { admitted: prev.cum.admitted, ideal: prev.cum.ideal };
  const net = cum.admitted - ledger.admitted - (cum.ideal - ledger.ideal);
  const debt = Math.max(0, net);
  const under = Math.max(0, -net);
  const recent = prev.history.slice(-(WINDOW_TICKS - 1));
  const offeredWindow = sum(recent.map((s) => s.incoming)) + incomingTotal;
  const failedWindow = sum(recent.map((s) => s.failed)) + sum(failed);
  const availability = offeredWindow ? 1 - failedWindow / offeredWindow : 1;
  const nodeSamples: NodeSample[] = nodes.map((n, i) => ({
    incoming: incoming[i], admitted: admitted[i], rejected: rejected[i], failed: failed[i], latencyMs: latency[i],
    belief: config.mode === 'ap' ? reportSum(n.known, t, W) : truthWindow - windowAdmitted[i],
    viewAgeTicks: config.mode === 'ap' ? viewAge(n, i, t) : 0,
    windowAdmitted: windowAdmitted[i], bursting: !!burst && burst.node === i,
  }));

  // 9. Partition bookkeeping: on cut remember baselines, on heal report the bill.
  const partitionSince = prev.partitionSince.slice();
  const debtAtCut = prev.debtAtCut.slice();
  const failedAtCut = prev.failedAtCut.slice();
  const nodeFailed = prev.nodeFailed.map((f, i) => f + failed[i]);
  let healed: PartitionReport | null = null, cut: number | undefined, healedNode: number | undefined;
  for (let i = 0; i < N; i++) {
    const since = partitionSince[i];
    if (config.partitioned[i] && since === null) {
      partitionSince[i] = t; debtAtCut[i] = debt; failedAtCut[i] = nodeFailed[i]; cut = i;
    } else if (!config.partitioned[i] && since !== null) {
      healed = { node: i, durationTicks: t - since, excess: Math.round(debt - debtAtCut[i]), failed: nodeFailed[i] - failedAtCut[i] };
      partitionSince[i] = null; healedNode = i;
    }
  }

  // 10. Ticket drops: a drop is over once the venue is full and nobody has sold for three ticks.
  const drop: DropState = { ...prev.drop, failed: prev.drop.failed + sum(failed), latencySum: prev.drop.latencySum + latencyMs * answeredTotal, answered: prev.drop.answered + answeredTotal };
  let drops = prev.drops;
  if (!finite && drop.closedAt === null && truthWindow >= L && admittedTotal === 0 && t - drop.startTick >= 3
    && sum(prev.history.slice(-2).map((s) => s.admitted)) === 0) {
    drop.closedAt = t;
    const rec: DropRecord = {
      n: drop.n, mode: config.mode, gossipMs: config.gossipMs, cut: config.partitioned.flatMap((p, i) => (p ? [i] : [])),
      sold: truthWindow, failed: drop.failed, durationTicks: t - drop.startTick, latencyMs: drop.answered ? drop.latencySum / drop.answered : 0,
    };
    drops = [...prev.drops, rec].slice(-6);
  }

  const sample: MetricsSample = {
    tick: t, incoming: incomingTotal, admitted: admittedTotal, rejected: sum(rejected), failed: sum(failed),
    offeredWindow, truthWindow, storeWindow, overshoot: Math.max(0, truthWindow - L), availability, latencyMs,
    debt, under, nodes: nodeSamples, cut, healed: healedNode, burstStart: burstStartedOn ?? undefined,
    dropStart: !finite && t === drop.startTick && drop.n > 1 ? true : undefined,
  };
  return {
    ...prev, tick: t, rngTraffic: rt, rngLatency: rl, mode: config.mode, nodes, hub, idealRing, idealTotal,
    burst, lastBurstEnd, partitionSince, debtAtCut, failedAtCut, nodeFailed, cum, ledger, drop, drops,
    history: prev.history.length >= HISTORY ? [...prev.history.slice(1), sample] : [...prev.history, sample],
    events: { synced, cpRoundTrips: config.mode === 'cp' ? answered : zeros(), burstStartedOn, healed },
    lastReport: healed ?? prev.lastReport,
  };
}

export function triggerBurst(state: SimState, node?: number, spec: BurstSpec = BURST): SimState {
  let rng = state.rngTraffic, n = node;
  if (n === undefined) { const [u, s] = rand(rng); rng = s; n = Math.floor(u * N); }
  const start = state.tick + 1;
  return { ...state, rngTraffic: rng, burst: { node: n, start, end: start + spec.durationTicks, mult: spec.mult } };
}

// Steady-state estimate of admitted req/s in AP: each node sees its peers discounted by the share of the
// window its view is missing. Symmetric fixed point, ±20 %. Other modes: min(offered, limit).
export function predictedTotalRps(config: SimConfig): number {
  const offered = config.ratePerNode * N;
  if (config.mode !== 'ap') return Math.min(offered, config.limit);
  const k = Math.max(1, Math.round(config.gossipMs / TICK_MS));
  let miss = 0;
  for (let x = 1; x <= 2 * k - 1; x++) miss += Math.min(WINDOW_TICKS, x);
  const s = miss / (2 * k - 1) / WINDOW_TICKS;
  return Math.min(offered, (N * config.limit) / (1 + (N - 1) * (1 - s)));
}

// ───────────────────────────── UI ─────────────────────────────

const SEED = 1;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const secs = (ticks: number) => ((ticks * TICK_MS) / 1000).toFixed(1);
const cls = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');

type Accent = 'sky' | 'amber' | 'violet';
const ACCENT: Record<Accent, { text: string; hex: string; glow: string; slider: string }> = {
  sky: { text: 'text-sky-400', hex: '#38bdf8', glow: 'rgba(56,189,248,0.13)', slider: 'accent-sky-400' },
  amber: { text: 'text-amber-400', hex: '#fbbf24', glow: 'rgba(251,191,36,0.13)', slider: 'accent-amber-400' },
  violet: { text: 'text-violet-400', hex: '#a78bfa', glow: 'rgba(167,139,250,0.13)', slider: 'accent-violet-400' },
};
const MODES: { id: Mode; label: string; sub: string; accent: Accent; Icon: typeof Radio }[] = [
  { id: 'ap', label: 'Eventual (AP)', sub: 'local · ~1 ms · can overshoot', accent: 'sky', Icon: Radio },
  { id: 'cp', label: 'Strong (CP)', sub: 'coordinated · exact · slow', accent: 'amber', Icon: ShieldCheck },
  { id: 'static', label: 'Static quota', sub: 'pre-split · exact · wasteful', accent: 'violet', Icon: Scale },
];
const modeMeta = (m: Mode) => MODES.find((x) => x.id === m)!;

// Stage geometry in SVG user units; HTML cards are positioned by the same numbers in %.
const VB = { w: 1000, h: 440 };
const STORE = { x: 500, y: 220 };
const POS = [{ x: 210, y: 108 }, { x: 790, y: 108 }, { x: 210, y: 332 }, { x: 790, y: 332 }];
const CARD_HALF_W = 88;
const isLeft = (i: number) => POS[i].x < STORE.x;
const at = (p: { x: number; y: number }) => ({ left: `${(p.x / VB.w) * 100}%`, top: `${(p.y / VB.h) * 100}%` });

interface Particle { id: string; x: number; y: number; dx: number; dy: number; r: number; fill: string; anim: string; ms: number; delay: number }
interface Batch { tick: number; items: Particle[] }
interface Float { key: string; node: number; text: string; tone: 'rose' | 'zinc'; tick: number }
interface Flash { key: string; node: number; tick: number }
interface Narration { key: string; text: string; prio: number; since: number }

// One particle stands for `scale` requests, so the stage stays legible at 2000 req/s.
function particlesFor(sample: MetricsSample, events: TickEvents, mode: Mode, partitioned: boolean[]): Particle[] {
  const scale = Math.max(1, Math.ceil(sample.incoming / 40));
  const out: Particle[] = [];
  sample.nodes.forEach((n, i) => {
    const p = POS[i];
    const x0 = isLeft(i) ? 10 : VB.w - 10;
    const x1 = isLeft(i) ? p.x - CARD_HALF_W - 6 : p.x + CARD_HALF_W + 6;
    const adm = Math.min(8, Math.ceil(n.admitted / scale));
    const rej = Math.min(5, Math.ceil(n.rejected / scale));
    const fail = Math.min(5, Math.ceil(n.failed / scale));
    const total = adm + rej + fail;
    // Lanes are visited in a scrambled order so staggered starts read as a stream, not a diagonal.
    const lane = (j: number) => p.y + (((j * 7) % Math.max(1, total)) - (total - 1) / 2) * 10;
    let j = 0;
    const push = (k: string, fill: string, anim: string, ms: number) =>
      out.push({ id: `${sample.tick}-${i}-${k}${j}`, x: x0, y: lane(j), dx: x1 - x0, dy: 0, r: 3.2, fill, anim, ms, delay: j++ * 24 });
    for (let k = 0; k < adm; k++) push('a', '#34d399', 'req-in', 600);
    for (let k = 0; k < rej; k++) push('r', '#fb7185', 'req-bounce', 700);
    for (let k = 0; k < fail; k++) push('f', '#71717a', 'req-bounce', 700);
    if (mode === 'cp' && !partitioned[i]) {
      const trips = Math.min(4, Math.ceil(events.cpRoundTrips[i] / scale));
      const ms = Math.max(420, NODES[i].rttMs * 4);
      for (let k = 0; k < trips; k++)
        out.push({ id: `${sample.tick}-${i}-t${k}`, x: p.x, y: p.y, dx: STORE.x - p.x, dy: STORE.y - p.y, r: 2.6, fill: '#fbbf24', anim: 'rtt', ms, delay: k * 45 });
    }
  });
  for (const i of events.synced) {
    const p = POS[i];
    out.push({ id: `${sample.tick}-${i}-g0`, x: p.x, y: p.y, dx: STORE.x - p.x, dy: STORE.y - p.y, r: 6, fill: '#38bdf8', anim: 'gossip', ms: 420, delay: 0 });
    out.push({ id: `${sample.tick}-${i}-g1`, x: STORE.x, y: STORE.y, dx: p.x - STORE.x, dy: p.y - STORE.y, r: 6, fill: '#38bdf8', anim: 'gossip', ms: 420, delay: 380 });
  }
  return out;
}

// Each step applies settings, then spotlights the element carrying the matching data-tour attribute.
const TOUR: { title: string; body: string; target: string; apply: Partial<SimConfig> }[] = [
  { title: 'One rule, four servers', target: 'store', apply: { mode: 'ap', ratePerNode: 150, gossipMs: 600, partitioned: NONE, windowTicks: WINDOW_TICKS },
    body: 'The center is the truth: how many requests all four edges really admitted in the last second. The rule is 1,000. Green dots got in, red ones bounced.' },
  { title: 'Every edge decides alone', target: 'node-0', apply: {},
    body: 'Virginia only knows its own count plus what it last heard from the others. The blue bar is the total it believes; the white tick is the truth.' },
  { title: 'Fast, local, wrong', target: 'traffic', apply: { ratePerNode: 400, gossipMs: 1200 },
    body: 'Traffic is now 1,600/s and the edges only hear from each other every 1.2 s. Each says yes from a stale view, so the center runs past 1,000. Watch the red.' },
  { title: 'Sync harder', target: 'gossip', apply: { gossipMs: 200 },
    body: 'Gossip every tick. The overshoot shrinks to about 15 % but never reaches zero: four servers are filling the same budget at the same moment.' },
  { title: 'Ask before answering', target: 'modes', apply: { mode: 'cp' },
    body: 'Strong mode: every request phones the store first. Never above 1,000, but every answer now costs a round trip. Watch the latency tile and the amber traffic on the wires.' },
  { title: 'Cut the cable', target: 'wire-3', apply: { mode: 'cp', partitioned: [false, false, false, true] },
    body: 'Tokyo lost its link to the store. It cannot verify, so it fails closed: every Tokyo user gets an error and availability drops to 75 %.' },
  { title: 'Choose', target: 'node-3', apply: { mode: 'ap', partitioned: [false, false, false, true] },
    body: 'Same outage, eventual mode: Tokyo keeps answering from a view that ages every second. That is the CAP choice: when the network breaks, be available or be right.' },
  { title: 'The bill', target: 'debt', apply: { mode: 'ap', partitioned: NONE },
    body: 'Healing the link sends the bill: every request Tokyo let through beyond the limit. Debt is the price of availability. Next, try the ticket sale, where the debt is people without seats.' },
];
const TOUR_STEP_MS = 9000;

const PRESET_META: { id: keyof typeof PRESETS; label: string; hint: string; Icon: typeof Waves }[] = [
  { id: 'calm', label: 'Calm', Icon: Waves, hint: '600 req/s, well under the limit. Every mode says yes; only latency differs.' },
  { id: 'max', label: 'Max traffic', Icon: Activity, hint: '2,000 req/s, twice the limit, one region hotter than the rest. Eventual admits ~1,500; Strong holds 1,000.' },
  { id: 'flash', label: 'Flash crowd', Icon: Flame, hint: 'Normal load, then a 3× burst on one region every 12 s. Eventual lets the burst through; Strong caps it.' },
  { id: 'fast', label: 'Fast gossip', Icon: Timer, hint: '2,000 req/s with gossip every tick. The overshoot shrinks to ~20 % and stays there: that is the floor.' },
  { id: 'slow', label: 'Slow gossip', Icon: Hourglass, hint: '1,600 req/s with gossip every 2 s. Views are older than the 1 s window, so the limiter is effectively off.' },
  { id: 'quiet', label: 'Quiet partition', Icon: Unplug, hint: "Low traffic and Tokyo cut off. Eventual loses nothing; Strong still turns Tokyo's users away." },
  { id: 'storm', label: 'Partition storm', Icon: CloudLightning, hint: '2,000 req/s and Tokyo cut off. Eventual admits ~1,750; Strong holds 1,000 at 75 % availability.' },
];

// Query-string state so a situation can be shared as a link. Only non-default values are written.
function configFromUrl(): SimConfig {
  const c: SimConfig = { ...DEFAULT_CONFIG };
  try {
    const q = new URLSearchParams(location.search);
    const m = q.get('m');
    if (m === 'ap' || m === 'cp' || m === 'static') c.mode = m;
    if (q.has('r')) c.ratePerNode = Math.min(500, Math.max(0, Math.round(Number(q.get('r')) / 10) * 10)) || 0;
    if (q.has('g')) c.gossipMs = Math.min(2000, Math.max(200, Math.round(Number(q.get('g')) / 200) * 200)) || 200;
    if (q.has('k')) c.skew = Math.min(0.6, Math.max(0, Number(q.get('k')))) || 0;
    if (q.get('b') === '1') c.burst = BURST;
    if (q.get('s') === 'tickets') c.windowTicks = Infinity;
    const cut = q.get('cut');
    if (cut !== null) c.partitioned = NONE.map((_, i) => cut.split(',').includes(String(i)));
  } catch { /* no URL access */ }
  return c;
}
function urlFor(c: SimConfig): string {
  const q = new URLSearchParams();
  if (c.mode !== 'ap') q.set('m', c.mode);
  if (c.ratePerNode !== DEFAULT_CONFIG.ratePerNode) q.set('r', String(c.ratePerNode));
  if (c.gossipMs !== DEFAULT_CONFIG.gossipMs) q.set('g', String(c.gossipMs));
  if (c.skew !== DEFAULT_CONFIG.skew) q.set('k', String(c.skew));
  if (c.burst) q.set('b', '1');
  if (c.windowTicks === Infinity) q.set('s', 'tickets');
  const cut = c.partitioned.flatMap((p, i) => (p ? [i] : []));
  if (cut.length) q.set('cut', cut.join(','));
  const s = q.toString();
  return s ? `?${s}` : location.pathname;
}

// Small hover explainer: an info icon that opens a popover.
function Hint({ title, children }: { title: string; children: ReactNode }) {
  return (
    <span className="group/hint relative inline-flex align-middle">
      <Info size={11} className="cursor-help text-zinc-500 group-hover/hint:text-emerald-400" />
      <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden w-72 -translate-x-1/2 rounded-md border border-zinc-700 bg-zinc-950 p-3 text-left text-[11px] font-normal normal-case leading-snug tracking-normal text-zinc-300 shadow-2xl group-hover/hint:block">
        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-emerald-400">{title}</span>
        {children}
      </span>
    </span>
  );
}

function GossipHint() {
  return (
    <Hint title="Why slow gossip breaks the limit">
      Each edge says yes while <span className="text-zinc-100">its own count + the last totals it heard</span> stays under 1,000. What it heard is up to two gossip intervals old, and counts older than the 1 s window have already expired from its view. So it believes the others are quiet and keeps admitting.
      <span className="mt-2 block space-y-1 font-mono text-[10px]">
        <span className="flex items-center gap-2"><span className="w-14 text-zinc-500">believes</span><span className="h-1.5 rounded-full bg-sky-500/70" style={{ width: '38%' }} /><span className="text-sky-300">620</span></span>
        <span className="flex items-center gap-2"><span className="w-14 text-zinc-500">truth</span><span className="flex h-1.5 rounded-full" style={{ width: '72%' }}><span className="h-full rounded-l-full bg-sky-500/70" style={{ width: '53%' }} /><span className="h-full rounded-r-full bg-rose-500/70" style={{ width: '47%' }} /></span><span className="text-rose-300">1,180</span></span>
      </span>
      <span className="mt-2 block font-mono text-[10px] text-zinc-400">overshoot ≈ other edges' rate × staleness</span>
      <span className="mt-1 block">Faster gossip shrinks the gap but never closes it. Only asking the store first (Strong) removes it, and that costs a round trip per request.</span>
    </Hint>
  );
}

// Live comparison: the other two strategies run on the same arrivals in the background.
function Compare({ shadows, config }: { shadows: Record<Mode, SimState>; config: SimConfig }) {
  const L = config.limit;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3" title="Three copies of the simulation run on identical traffic and cut wires; only the decision rule differs.">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">Same traffic, three strategies</div>
      <div className="mt-1.5 flex flex-col gap-1">
        {MODES.map(({ id, label, accent, Icon }) => {
          const h = shadows[id].history;
          const s = h[h.length - 1];
          const adm = s?.truthWindow ?? 0, over = Math.max(0, adm - L), lat = s?.latencyMs ?? 0, avail = (s?.availability ?? 1) * 100;
          const refused = h.slice(-WINDOW_TICKS).reduce((a, x) => a + x.rejected, 0);
          const wasted = id === 'static' && adm < 0.97 * L && refused > 0;
          const active = config.mode === id;
          return (
            <div key={id} className={cls('grid grid-cols-[14px_72px_1fr_auto] items-center gap-2 rounded-md px-2 py-1 font-mono text-[11px] tabular-nums', active ? 'bg-zinc-800/80 ring-1 ring-zinc-700' : '')}>
              <Icon size={12} className={ACCENT[accent].text} />
              <span className="font-sans text-[11px] text-zinc-300">{label.replace(/ \(.*\)$/, '')}</span>
              <span className={adm > L ? 'text-rose-400' : 'text-emerald-400'}>{fmt(adm)}{over > 0 && <span className="text-rose-400/80"> +{fmt(over)}</span>}</span>
              <span className="text-zinc-500">{wasted ? <span className="text-violet-300">{fmt(refused)} refused</span> : lat < 5 ? '~1 ms' : `${fmt(lat)} ms`}{avail < 99.5 && <span className="text-rose-400"> · {avail.toFixed(0)} %</span>}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-1 text-[10px] text-zinc-500">Admitted req/s · latency · availability when below 100 %.</div>
    </div>
  );
}

function narrate(last: MetricsSample, config: SimConfig, sim: SimState, heal: { report: PartitionReport; untilTick: number } | null): Omit<Narration, 'since'> {
  const L = config.limit;
  const tickets = config.windowTicks === Infinity;
  const code = (i: number) => NODES[i].city;
  const k = Math.max(1, Math.round(config.gossipMs / TICK_MS));
  if (heal && heal.untilTick >= last.tick) {
    const r = heal.report, name = code(r.node), t = secs(r.durationTicks);
    if (config.mode === 'cp' || (r.excess <= 0 && r.failed > 0))
      return { key: `heal-${r.node}`, prio: 5, text: `Link restored. ${name} refused ${fmt(r.failed)} requests while cut off — zero overshoot, ${fmt(r.failed)} unhappy users.` };
    if (r.excess > 0)
      return { key: `heal-${r.node}`, prio: 5, text: `Link restored. During the ${t} s partition, ${name} admitted ${fmt(r.excess)} requests beyond the limit. That debt is real.` };
    return { key: `heal-${r.node}`, prio: 5, text: `Link restored. ${name} is back in sync — the ${t} s partition was short enough to cost nothing.` };
  }
  const cutIdx = config.partitioned.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  if (cutIdx.length) {
    const i = cutIdx.reduce((a, b) => (last.nodes[b].viewAgeTicks > last.nodes[a].viewAgeTicks ? b : a));
    const since = sim.partitionSince[i];
    const t = since === null ? '0.0' : secs(last.tick - since);
    const n = last.nodes[i];
    if (config.mode === 'cp')
      return { key: `cut-cp-${i}`, prio: 4, text: tickets
        ? `${code(i)} can't reach the store, so it sells nothing: ${fmt(n.failed * 5)} buyers/s get errors. The seat count stays exact.`
        : last.offeredWindow < 0.8 * L
          ? `${code(i)} can't reach the store, so it refuses everyone: ${fmt(n.failed * 5)} errors/s — even though there is room for all of them.`
          : `${code(i)} can't reach the store, so it refuses everyone: ${fmt(n.failed * 5)} errors/s. The global count stays exact.` };
    if (config.mode === 'static')
      return { key: `cut-st-${i}`, prio: 4, text: `${code(i)} is cut off and doesn't care: a fixed 250 req/s quota needs no one. Exact, until traffic moves.` };
    const excess = Math.max(0, Math.round(last.debt - sim.debtAtCut[i]));
    const blind = n.viewAgeTicks === Infinity || n.viewAgeTicks >= WINDOW_TICKS;
    if (tickets) return { key: `cut-tk-${i}`, prio: 4, text: last.truthWindow > L
      ? `${code(i)} is cut off and still selling — it cannot hear that the venue is full. ${fmt(last.truthWindow - L)} seats oversold so far.`
      : `${code(i)} is cut off ${t} s and keeps selling from the last count it heard. It will not hear when the venue fills.` };
    return { key: `cut-ap-${i}`, prio: 4, text: blind
      ? `${code(i)} lost its link ${t} s ago and serves blind — it counts only itself now. ${fmt(excess)} beyond the limit so far.`
      : `${code(i)} lost its link ${t} s ago and keeps serving from a ${secs(n.viewAgeTicks)} s-old view — ${fmt(excess)} beyond the limit so far.` };
  }
  if (tickets) {
    const sold = last.truthWindow, d = sim.drop;
    if (d.closedAt !== null) {
      const wait = secs(Math.max(0, DROP_HOLD_TICKS - (last.tick - d.closedAt)));
      if (sold > L) return { key: `drop-over-${d.n}`, prio: 3, text: `Drop ${d.n} sold ${fmt(sold)} of ${fmt(L)} seats — ${fmt(sold - L)} people hold tickets to seats that don't exist. Next drop in ${wait} s.` };
      if (config.mode === 'cp') return { key: `drop-exact-${d.n}`, prio: 3, text: `Drop ${d.n}: ${fmt(L)} of ${fmt(L)} sold, exactly. Every buyer waited ~${fmt(d.answered ? d.latencySum / d.answered : 0)} ms for the store. Next drop in ${wait} s.` };
      return { key: `drop-exact-${d.n}`, prio: 3, text: `Drop ${d.n}: ${fmt(L)} of ${fmt(L)} sold, exactly — each site stopped at its own 250. Next drop in ${wait} s.` };
    }
    if (sold > L) return { key: 'overselling', prio: 3, text: `The venue is full and sites are still selling: ${fmt(sold - L)} seats oversold so far. Nobody has heard the news yet.` };
    return { key: 'selling', prio: 1, text: `Drop ${d.n}: ${fmt(sold)} of ${fmt(L)} seats sold, ${fmt(last.offeredWindow)} buyers/s across four sites.` };
  }
  const saturated = last.offeredWindow >= 0.9 * L || last.truthWindow >= 0.95 * L;
  if (saturated) {
    if (config.mode === 'cp')
      return { key: 'sat-cp', prio: 2, text: `Every request waits ${fmt(last.latencyMs)} ms for the store to answer. Exactly ${fmt(last.truthWindow)} admitted — never more.` };
    if (config.mode === 'static') {
      const rej = last.nodes.map((n, i) => [n.rejected, i] as const).sort((a, b) => b[0] - a[0])[0];
      const idle = last.nodes.map((n, i) => [n.windowAdmitted, i] as const).sort((a, b) => a[0] - b[0])[0];
      if (rej[0] > 0 && last.truthWindow < L)
        return { key: 'quota-skew', prio: 2, text: `Static quota: ${code(rej[1])} rejects above 250 req/s while ${code(idle[1])} idles at ${fmt(idle[0])}. Exact, but ${fmt(L - last.truthWindow)} req/s is wasted.` };
      return { key: 'quota-ok', prio: 2, text: `Static quota: each node stops at 250 req/s on its own. Exact and coordination-free — as long as traffic stays even.` };
    }
    const over = Math.max(0, last.truthWindow - L);
    if (k === 1) return { key: 'sat-ap-1', prio: 2, text: `Syncing every tick shrinks the error to ~${fmt(over)} req/s — never to zero. Four nodes fill the same budget at once.` };
    const i = last.nodes.map((n, j) => [n.viewAgeTicks, j] as const).sort((a, b) => b[0] - a[0])[0][1];
    const n = last.nodes[i];
    if (k >= WINDOW_TICKS && n.viewAgeTicks >= WINDOW_TICKS)
      return { key: 'sat-ap-blind', prio: 2, text: `${code(i)}'s view is older than the 1 s window — it is blind, and the limiter is effectively off.` };
    const g = last.nodes.map((x, j) => [x.windowAdmitted + x.belief, j] as const).sort((a, b) => a[0] - b[0])[0];
    return { key: 'sat-ap', prio: 2, text: `${code(g[1])} thinks ${fmt(g[0])} were admitted globally; the real number is ${fmt(last.truthWindow)} (its view is ${secs(last.nodes[g[1]].viewAgeTicks)} s old).` };
  }
  return { key: 'under', prio: 1, text: `Total traffic is ${fmt(last.offeredWindow)} req/s, under the ${fmt(L)} limit — every node can say yes without asking anyone.` };
}

function Header({ config, running, onMode, onScenario, onRun, onReset, onIntro }: {
  config: SimConfig; running: boolean; onMode: (m: Mode) => void; onScenario: () => void; onRun: () => void; onReset: () => void; onIntro: () => void;
}) {
  const tickets = config.windowTicks === Infinity;
  const [copied, setCopied] = useState(false);
  const share = () => {
    navigator.clipboard?.writeText(location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined);
  };
  return (
    <header className="flex h-12 items-center gap-4">
      <div className="flex items-center gap-2">
        <Globe size={18} className="text-zinc-400" />
        <div>
          <div className="text-base font-semibold tracking-tight text-zinc-100">CAP in practice</div>
          <div className="text-[11px] text-zinc-500">one global rate limit · four edge nodes · one truth</div>
        </div>
        <button onClick={onIntro} className="ml-2 flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-300 hover:border-zinc-600" title="What is this and what is CAP?">
          <Info size={12} className="text-emerald-400" /> What is CAP?
        </button>
      </div>
      <div className="flex flex-1 justify-center">
        <div data-tour="modes" className="flex rounded-lg border border-zinc-800 bg-zinc-900/60 p-1">
          {MODES.map(({ id, label, sub, accent, Icon }) => {
            const active = config.mode === id;
            return (
              <button key={id} onClick={() => onMode(id)} title={sub}
                className={cls('flex items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors', active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}>
                <Icon size={14} className={active ? ACCENT[accent].text : ''} />
                <span>
                  <span className="block text-[13px] font-medium leading-tight">{label}</span>
                  <span className="block text-[10px] leading-tight text-zinc-500">{sub}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button data-tour="scenario" onClick={onScenario} title="Switch between the rate limiter and a 1,000-seat ticket sale"
          className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-[12px] text-zinc-300 hover:border-zinc-600">
          {tickets ? <Ticket size={13} className="text-violet-400" /> : <Gauge size={13} className="text-emerald-400" />}
          {tickets ? 'Ticket sale' : 'Rate limit'}
        </button>
        <button onClick={onRun} className="flex h-8 w-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-zinc-600" title={running ? 'Pause' : 'Play'}>
          {running ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button onClick={onReset} className="flex h-8 w-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-zinc-600" title="Reset counters and debt">
          <RotateCcw size={14} />
        </button>
        <button onClick={share} className="flex h-8 w-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-zinc-600" title="Copy a link to this exact situation">
          {copied ? <Check size={14} className="text-emerald-400" /> : <Share2 size={14} />}
        </button>
      </div>
    </header>
  );
}

function TourRow({ step, auto, onStep, onAuto, onClose }: {
  step: number | null; auto: boolean; onStep: (s: number) => void; onAuto: (a: boolean) => void; onClose: () => void;
}) {
  if (step === null) {
    return (
      <div className="flex h-11 items-center gap-2">
        <button onClick={() => { onAuto(false); onStep(0); }} className="flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[12px] text-zinc-200 hover:border-zinc-500">
          <GraduationCap size={14} className="text-emerald-400" /> Take the guided tour
        </button>
        <button onClick={() => { onAuto(true); onStep(0); }} className="flex items-center gap-2 rounded-full border border-zinc-800 px-3 py-1.5 text-[12px] text-zinc-400 hover:border-zinc-600 hover:text-zinc-200" title="Plays all eight steps, nine seconds each">
          <Play size={12} /> Auto-play it
        </button>
      </div>
    );
  }
  const s = TOUR[step];
  const last = step === TOUR.length - 1;
  return (
    <div className="relative flex h-11 items-center gap-3 overflow-hidden rounded-lg border border-emerald-500/40 bg-zinc-900/90 px-3">
      <GraduationCap size={15} className="shrink-0 text-emerald-400" />
      <span className="shrink-0 font-mono text-[11px] text-zinc-500">{step + 1}/{TOUR.length}</span>
      <span className="shrink-0 text-[13px] font-semibold text-zinc-100">{s.title}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-300" title={s.body}>{s.body}</span>
      <button onClick={() => onAuto(!auto)} className={cls('flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]', auto ? 'border-emerald-500/60 text-emerald-300' : 'border-zinc-700 text-zinc-400 hover:text-zinc-100')} title="Advance automatically every nine seconds">
        {auto ? <Pause size={11} /> : <Play size={11} />} Auto
      </button>
      <button onClick={() => onStep(step - 1)} disabled={step === 0} className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-zinc-400 hover:text-zinc-100 disabled:opacity-30">
        <ChevronLeft size={13} /> Back
      </button>
      <button onClick={() => (last ? onClose() : onStep(step + 1))} className="flex items-center gap-1 rounded-md bg-zinc-100 px-2.5 py-1 text-[12px] font-medium text-zinc-900 hover:bg-white">
        {last ? 'Done' : 'Next'} {!last && <ChevronRight size={13} />}
      </button>
      <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200" title="Close tour"><X size={14} /></button>
      {auto && <div key={step} className="absolute bottom-0 left-0 h-0.5 bg-emerald-400" style={{ animation: `tour-progress ${TOUR_STEP_MS}ms linear forwards` }} />}
    </div>
  );
}

// Dims the page around the element tagged data-tour={target}; clicks pass through.
function Spotlight({ target }: { target: string | null }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!target) { setRect(null); return; }
    const measure = () => {
      const el = document.querySelector(`[data-tour="${target}"]`);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    const id = setInterval(measure, 400);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { clearInterval(id); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [target]);
  if (!rect) return null;
  return (
    <div className="pointer-events-none fixed z-40 rounded-lg ring-2 ring-emerald-400 spotlight"
      style={{ left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12, boxShadow: '0 0 0 9999px rgba(9, 9, 11, 0.6)' }} />
  );
}

function Intro({ onTour, onClose }: { onTour: () => void; onClose: () => void }) {
  const h = 'flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-400';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/85 p-6 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-3xl rounded-xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <Globe size={22} className="mt-0.5 text-emerald-400" />
          <div className="flex-1">
            <div className="text-lg font-semibold text-zinc-100">CAP in practice</div>
            <div className="text-[13px] text-zinc-400">A live simulation of one hard rule enforced by many servers at once.</div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200" title="Close"><X size={16} /></button>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-5 text-[13px] leading-relaxed text-zinc-300">
          <section>
            <div className={h}><Server size={12} /> The problem</div>
            <p className="mt-1.5">A CDN runs edge servers around the world. A customer says: <span className="text-zinc-100">"let at most 1,000 requests per second reach my API."</span> Each edge sees only its own traffic, yet together they must keep that one promise.</p>
          </section>
          <section>
            <div className={h}><Scale size={12} /> The CAP theorem</div>
            <p className="mt-1.5">Servers spread over a network want <span className="text-zinc-100">C</span>onsistency (everyone sees the same count), <span className="text-zinc-100">A</span>vailability (every request gets an answer) and <span className="text-zinc-100">P</span>artition tolerance (it keeps working when the network breaks). Networks do break, and while one is broken you keep only one of the other two: answer from what you know and risk being wrong, or refuse what you cannot verify.</p>
          </section>
          <section>
            <div className={h}><Gauge size={12} /> How to read the screen</div>
            <p className="mt-1.5">The center card is the truth. Each edge card shows what that server believes. Sliders set the traffic and how often the edges talk. Scissors cut a wire. Red on the chart means the promise was broken; the Debt tile counts how badly.</p>
          </section>
        </div>
        <div className="mt-6 flex items-center gap-3">
          <button onClick={onTour} className="flex items-center gap-2 rounded-md bg-emerald-400 px-3.5 py-2 text-[13px] font-semibold text-zinc-950 hover:bg-emerald-300">
            <GraduationCap size={15} /> Take the guided tour
          </button>
          <button onClick={onClose} className="rounded-md border border-zinc-700 px-3.5 py-2 text-[13px] text-zinc-200 hover:border-zinc-500">Explore on my own</button>
          <span className="ml-auto text-[11px] text-zinc-500">Reopen any time with "What is CAP?" in the header.</span>
        </div>
      </div>
    </div>
  );
}

const modeShort = (m: Mode) => (m === 'ap' ? 'AP' : m === 'cp' ? 'CP' : 'quota');

function DropStatus({ sim, L }: { sim: SimState; L: number }) {
  const d = sim.drop;
  const sold = sim.history[sim.history.length - 1]?.truthWindow ?? 0;
  const closed = d.closedAt !== null;
  const wait = closed ? Math.max(0, DROP_HOLD_TICKS - (sim.tick - (d.closedAt as number))) : 0;
  const tone = !closed ? 'border-emerald-500/50 text-emerald-300' : sold > L ? 'border-rose-500/60 text-rose-300' : 'border-amber-400/60 text-amber-300';
  return (
    <>
      <div className={cls('absolute left-1/2 top-2 -translate-x-1/2 whitespace-nowrap rounded-full border bg-zinc-950/90 px-3 py-1 font-mono text-[11px]', tone)}>
        {closed
          ? `Drop ${d.n} · sold out · ${fmt(sold)} / ${fmt(L)}${sold > L ? ` · ${fmt(sold - L)} oversold` : ' · exact'} · next in ${secs(wait)} s`
          : `Drop ${d.n} · selling · ${fmt(sold)} / ${fmt(L)} seats · ${secs(sim.tick - d.startTick)} s`}
      </div>
      {sim.drops.length > 0 && (
        <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1.5 whitespace-nowrap">
          {sim.drops.slice(-4).map((r) => (
            <div key={r.n} className={cls('rounded-md border bg-zinc-950/90 px-2 py-1 font-mono text-[10px]', r.sold > L ? 'border-rose-500/50 text-rose-300' : 'border-emerald-500/40 text-emerald-300')}
              title={`Drop ${r.n}: ${r.durationTicks * TICK_MS / 1000 | 0} s, mean decision ${fmt(r.latencyMs)} ms`}>
              <span className="text-zinc-500">#{r.n} {modeShort(r.mode)}{r.mode === 'ap' ? ` ${r.gossipMs} ms` : ''}{r.cut.length ? ` · ${r.cut.map((i) => NODES[i].code).join('+')} cut` : ''}</span>
              <span className="ml-1.5">{fmt(r.sold)} sold{r.sold > L ? ` (+${fmt(r.sold - L)})` : ''}{r.failed ? ` · ${fmt(r.failed)} errors` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function StoreCard({ last, config, pingKey }: { last: MetricsSample | undefined; config: SimConfig; pingKey: number }) {
  const L = config.limit;
  const truth = last?.truthWindow ?? 0;
  const knows = last?.storeWindow ?? 0;
  const tickets = config.windowTicks === Infinity;
  const tone = truth > L ? 'text-rose-400' : truth > 0.9 * L ? 'text-amber-400' : 'text-emerald-400';
  const bar = truth > L ? 'bg-rose-500' : truth > 0.9 * L ? 'bg-amber-400' : 'bg-emerald-400';
  const showKnows = config.mode === 'ap' && Math.abs(knows - truth) > 0.02 * L;
  const hex = ACCENT[modeMeta(config.mode).accent].hex;
  return (
    <div key={pingKey} data-tour="store" className="absolute left-1/2 top-1/2 w-[236px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-zinc-700 bg-zinc-900/95 p-3 shadow-xl backdrop-blur"
      style={{ '--accent': hex, animation: pingKey ? 'store-ping 700ms ease-out' : undefined } as CSSProperties}>
      <div className="flex items-center gap-1.5 whitespace-nowrap text-[10px] uppercase tracking-[0.1em] text-zinc-500">
        <Database size={12} className="text-zinc-400" /> Global store · ground truth
      </div>
      <div className="mt-1 flex items-baseline gap-1.5 font-mono tabular-nums">
        <span className={cls('text-[26px] font-semibold leading-none', tone)}>{fmt(truth)}</span>
        <span className="text-[13px] text-zinc-500">/ {fmt(L)}</span>
        <span className="ml-auto text-[10px] text-zinc-500">{tickets ? 'seats sold' : 'req/s'}</span>
      </div>
      <div className="relative mt-2 h-1.5 w-full rounded-full bg-zinc-800">
        <div className={cls('h-full rounded-full transition-[width] duration-200', bar)} style={{ width: `${Math.min(100, (truth / (1.5 * L)) * 100)}%` }} />
        <div className="absolute top-[-3px] h-3 w-px bg-zinc-300" style={{ left: '66.7%' }} title="limit" />
      </div>
      <div className="mt-1.5 h-4 text-[11px]">
        {showKnows ? (
          <span className="text-sky-400/80">store knows: <span className="font-mono">{fmt(knows)}</span> · gossip is behind</span>
        ) : config.mode === 'cp' ? (
          <span className="rounded bg-amber-400/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">exact · every request checks in</span>
        ) : config.mode === 'static' ? (
          <span className="text-zinc-500">no coordination · 250 req/s each</span>
        ) : (
          <span className="text-zinc-500">gossip is current</span>
        )}
      </div>
    </div>
  );
}

function NodeCard({ i, ns, config, truth, cut }: { i: number; ns: NodeSample; config: SimConfig; truth: number; cut: boolean }) {
  const meta = NODES[i];
  const L = config.limit;
  const ap = config.mode === 'ap', cp = config.mode === 'cp';
  const ageT = ns.viewAgeTicks;
  const blind = ap && (ageT === Infinity || ageT >= WINDOW_TICKS);
  const believed = ns.windowAdmitted + ns.belief;
  const scale = 1.5 * L;
  const ageTone = !ap ? 'text-zinc-500' : ageT === Infinity || ageT >= 8 ? 'text-rose-400' : ageT >= 3 ? 'text-amber-300' : 'text-zinc-400';
  const led = cut ? 'bg-rose-500 shadow-[0_0_8px_#f43f5e] led-blink' : ns.rejected > 0 ? 'bg-amber-400 shadow-[0_0_6px_#fbbf24]' : 'bg-emerald-400 shadow-[0_0_6px_#34d399]';
  const inc = Math.max(1, ns.incoming);
  return (
    <div data-tour={`node-${i}`} className={cls('group absolute w-[176px] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-zinc-900/95 p-2 shadow-lg backdrop-blur transition-colors',
      cut ? 'border-rose-500/60' : 'border-zinc-800 hover:border-zinc-600')} style={at(POS[i])}>
      <div className="flex items-center gap-1.5">
        <Server size={12} className="text-zinc-400" />
        <span className="font-mono text-[13px] font-semibold text-zinc-100">{meta.code}</span>
        <span className="text-[10px] text-zinc-500">{meta.city}</span>
        {ns.bursting && <Flame size={11} className="text-orange-400" />}
        <span className="ml-auto flex items-center gap-1">
          {cut && <span className="text-[9px] uppercase tracking-wider text-rose-400">{cp ? 'fail-closed' : ap ? 'serving stale' : 'cut'}</span>}
          <span className={cls('h-1.5 w-1.5 rounded-full', led)} />
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-1 font-mono tabular-nums">
        <span className="text-[22px] font-semibold leading-none text-emerald-400">{fmt(ns.windowAdmitted)}</span>
        <span className="text-[10px] text-zinc-500">{config.windowTicks === Infinity ? 'sold' : 'req/s admitted'}</span>
      </div>
      <div className="relative mt-1.5 h-1.5 w-full rounded-full bg-zinc-800" title="what this node believes the global count is, vs the truth">
        <div className="absolute h-full rounded-full bg-sky-500/70" style={{ width: `${Math.min(100, (believed / scale) * 100)}%` }} />
        {truth > believed && (
          <div className="absolute h-full bg-rose-500/60" style={{ left: `${Math.min(100, (believed / scale) * 100)}%`, width: `${Math.min(100 - (believed / scale) * 100, ((truth - believed) / scale) * 100)}%` }} />
        )}
        <div className="absolute top-[-2px] h-2.5 w-px bg-zinc-100" style={{ left: `${Math.min(100, (truth / scale) * 100)}%` }} />
        <div className="absolute top-[-2px] h-2.5 w-px bg-zinc-500" style={{ left: '66.7%' }} />
      </div>
      <div className={cls('mt-1 text-[11px]', ap ? ageTone : 'text-sky-400/80')}>
        {ap ? <>believes {config.windowTicks === Infinity ? 'sold' : 'global'} ≈ <span className="font-mono">{fmt(believed)}</span></>
          : cp ? <>sees global = <span className="font-mono">{fmt(truth)}</span> (live)</>
          : <>own quota <span className="font-mono">{fmt(ns.windowAdmitted)}</span> / 250</>}
      </div>
      <div className={cls('mt-0.5 flex items-center gap-1 text-[11px]', ageTone)}>
        <Clock size={10} />
        {!ap ? (cp ? 'view: live' : 'no sync needed') : ageT === Infinity ? 'no view yet' : blind ? `blind (${secs(ageT)} s)` : `view ${secs(ageT)} s old`}
      </div>
      <div className="mt-1.5 flex h-1 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className="bg-emerald-400" style={{ width: `${(ns.admitted / inc) * 100}%` }} />
        <div className="bg-rose-400" style={{ width: `${(ns.rejected / inc) * 100}%` }} />
        <div className="bg-zinc-500" style={{ width: `${(ns.failed / inc) * 100}%` }} />
      </div>
      <div className="mt-1 font-mono text-[10px] text-zinc-500">
        {cp ? <span className="text-amber-300">decision {fmt(ns.latencyMs)} ms</span> : <>RTT {meta.rttMs} ms · decision ~1 ms</>}
      </div>
      <div className="pointer-events-none absolute -bottom-7 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-[10px] text-zinc-300 group-hover:block">
        admitted {fmt(ns.admitted * 5)} · rejected {fmt(ns.rejected * 5)} · failed {fmt(ns.failed * 5)} /s · RTT {meta.rttMs} ms
      </div>
    </div>
  );
}

function Stage({ sim, config, batches, flashes, floats, pingKey, onToggleLink }: {
  sim: SimState; config: SimConfig; batches: Batch[]; flashes: Flash[]; floats: Float[]; pingKey: number; onToggleLink: (i: number) => void;
}) {
  const last = sim.history[sim.history.length - 1];
  const meta = modeMeta(config.mode);
  return (
    <div className="relative aspect-[25/11] w-full overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950"
      style={{
        backgroundImage: `radial-gradient(circle at 50% 50%, ${ACCENT[meta.accent].glow}, transparent 38%), linear-gradient(to right, rgba(63,63,70,.22) 1px, transparent 1px), linear-gradient(to bottom, rgba(63,63,70,.22) 1px, transparent 1px)`,
        backgroundSize: '100% 100%, 32px 32px, 32px 32px',
      }}>
      <svg viewBox={`0 0 ${VB.w} ${VB.h}`} preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full">
        {POS.map((p, i) => (
          <line key={i} x1={p.x} y1={p.y} x2={STORE.x} y2={STORE.y} strokeWidth={2}
            className={cls('transition-[stroke] duration-300', config.partitioned[i] ? 'stroke-rose-500' : 'stroke-zinc-700')}
            strokeDasharray={config.partitioned[i] ? '6 6' : undefined} />
        ))}
        {flashes.map((f) => (
          <line key={f.key} x1={POS[f.node].x} y1={POS[f.node].y} x2={STORE.x} y2={STORE.y} strokeWidth={3} className="stroke-sky-400"
            style={{ animation: 'edge-flash 700ms ease-out forwards' }} />
        ))}
        {batches.flatMap((b) => b.items).map((pt) => (
          <circle key={pt.id} cx={pt.x} cy={pt.y} r={pt.r} fill={pt.fill} className="particle"
            style={{ '--dx': `${pt.dx}px`, '--dy': `${pt.dy}px`, animation: `${pt.anim} ${pt.ms}ms ${pt.delay}ms ease-out both` } as CSSProperties} />
        ))}
        {floats.map((f) => (
          <text key={f.key} x={POS[f.node].x} y={POS[f.node].y - 72} textAnchor="middle"
            className={cls('font-mono text-[15px] font-semibold', f.tone === 'rose' ? 'fill-rose-400' : 'fill-zinc-400')}
            style={{ animation: 'float-up 1600ms ease-out forwards' }}>{f.text}</text>
        ))}
      </svg>
      <StoreCard last={last} config={config} pingKey={pingKey} />
      {last && NODES.map((n, i) => (
        <NodeCard key={n.code} i={i} ns={last.nodes[i]} config={config} truth={last.truthWindow} cut={config.partitioned[i]} />
      ))}
      {config.windowTicks === Infinity && <DropStatus sim={sim} L={config.limit} />}
      {POS.map((p, i) => {
        const cut = config.partitioned[i];
        return (
          <button key={i} data-tour={`wire-${i}`} onClick={() => onToggleLink(i)} style={at({ x: (p.x + STORE.x) / 2, y: (p.y + STORE.y) / 2 })}
            title={cut ? `Heal ${NODES[i].city}'s link` : `Cut ${NODES[i].city}'s link to the store`}
            className={cls('absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border transition-colors',
              cut ? 'border-rose-500 bg-zinc-950 text-rose-400 ring-2 ring-rose-500/30' : 'border-zinc-700 bg-zinc-900 text-zinc-500 hover:border-zinc-400 hover:text-zinc-100')}>
            {cut ? <Unplug size={13} /> : <Scissors size={13} />}
          </button>
        );
      })}
    </div>
  );
}

function Tile({ label, value, sub, tone, pop, hint, tour, extra }: { label: string; value: string; sub: string; tone: string; pop?: number; hint: string; tour?: string; extra?: ReactNode }) {
  return (
    <div data-tour={tour} title={hint} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">{label}{extra}</div>
      <div key={pop} className={cls('font-mono text-2xl font-semibold tabular-nums leading-tight', tone)} style={pop ? { animation: 'pop 200ms ease-out' } : undefined}>{value}</div>
      <div className="truncate text-[11px] text-zinc-500">{sub}</div>
    </div>
  );
}

function Metrics({ history, config }: { history: MetricsSample[]; config: SimConfig }) {
  const last = history[history.length - 1];
  const L = config.limit;
  const recent = history.slice(-WINDOW_TICKS);
  const rejected = recent.reduce((a, s) => a + s.rejected, 0);
  const admitted = last?.truthWindow ?? 0;
  const over = last?.overshoot ?? 0;
  const avail = (last?.availability ?? 1) * 100;
  const lat = last?.latencyMs ?? 0;
  const debt = last?.debt ?? 0, under = last?.under ?? 0;
  const tickets = config.windowTicks === Infinity;
  return (
    <div className="grid grid-cols-6 gap-2">
      <Tile label="Incoming" value={fmt(last?.offeredWindow ?? 0)} sub={tickets ? 'buyers/s arriving' : 'req/s offered'} tone="text-zinc-200"
        hint="Requests arriving at all four edges in the last second, before any decision." />
      <Tile label={tickets ? 'Sold (truth)' : 'Admitted (truth)'} value={fmt(admitted)} sub={admitted > L ? 'OVER THE LIMIT' : `${fmt(rejected)} rejected /s`} tone={admitted > L ? 'text-rose-400' : 'text-emerald-400'}
        hint={tickets ? 'Seats actually sold in this drop, all sites combined.' : 'What actually got through in the last second, all edges combined. This is the ground truth, not what any node believes.'} />
      <Tile label="Overshoot" value={over > 0 ? `+${fmt(over)}` : '0'} sub={tickets ? 'seats oversold' : 'req/s over limit'} tone={over > 0 ? 'text-rose-400' : 'text-zinc-500'}
        hint="How far the real total is above the 1,000 limit right now. Anything above zero is a broken promise." extra={<GossipHint />} />
      <Tile label="Debt" value={fmt(debt)} sub={under > 0 ? `${fmt(under)} turned away needlessly` : 'over the limit, in this mode'} tone={debt > 0 ? 'text-rose-400' : 'text-zinc-500'} pop={Math.floor(debt / 50)} tour="debt"
        hint="Requests admitted beyond the limit since you chose this mode, measured against a perfect limiter on the same traffic. The sub-line counts requests refused while there was still room." />
      <Tile label="Availability" value={`${avail.toFixed(1)}%`} sub="requests that got an answer" tone={avail >= 99.5 ? 'text-emerald-400' : avail >= 90 ? 'text-amber-400' : 'text-rose-400'}
        hint="Share of requests that received any answer in the last second. A cut-off node in Strong mode answers nobody, so its users count against this." />
      <Tile label="Decision latency" value={lat < 5 ? '~1 ms' : `${fmt(lat)} ms`} sub={config.mode === 'cp' ? 'one round trip per request' : 'decided locally'} tone={lat < 5 ? 'text-sky-400' : 'text-amber-400'} tour="latency"
        hint="How long a request waits for its admit-or-reject decision. Local decisions take about a millisecond; asking the store costs a round trip to Virginia." />
    </div>
  );
}

function Chart({ history, config }: { history: MetricsSample[]; config: SimConfig }) {
  const W = 900, H = 136, PL = 36, PR = 44, PT = 10, PB = 16;
  const L = config.limit;
  const tickets = config.windowTicks === Infinity;
  const yMax = tickets ? 1.2 * L : 2 * L;
  const iw = W - PL - PR, ih = H - PT - PB;
  const xs = (i: number) => PL + (i / (HISTORY - 1)) * iw;
  const ys = (v: number) => PT + (1 - Math.min(v, yMax) / yMax) * ih;
  const yl = (ms: number) => PT + (1 - Math.min(ms, 200) / 200) * ih;
  const offset = HISTORY - history.length;
  const pts = history.map((s, k) => ({ x: xs(offset + k), s }));
  const path = (get: (s: MetricsSample) => number, yf: (v: number) => number) =>
    pts.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(1)},${yf(get(p.s)).toFixed(1)}`).join(' ');
  const area = (top: (s: MetricsSample) => number, bottom: (s: MetricsSample) => number) => pts.length
    ? `${pts.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(1)},${ys(top(p.s)).toFixed(1)}`).join(' ')} ${[...pts].reverse().map((p) => `L${p.x.toFixed(1)},${ys(bottom(p.s)).toFixed(1)}`).join(' ')} Z`
    : '';
  const label = 'font-mono text-[10px] fill-zinc-500';
  return (
    <div data-tour="chart" className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 pt-1" title="The real admitted rate over the last 30 seconds against the limit. Red fill is the broken promise; the thin amber line is decision latency.">
      <div className="flex items-center gap-1.5 px-1 text-[10px] uppercase tracking-wider text-zinc-500">
        <Activity size={11} /> last 30 s · <span className="text-emerald-400">{tickets ? 'sold' : 'admitted'}</span> · <span className="text-rose-400">{tickets ? 'oversold' : 'overshoot'}</span>{!tickets && <> · <span className="text-zinc-400">offered</span></>} · <span className="text-amber-400">latency</span>{tickets && <> · <span className="text-violet-400">new drop</span></>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ aspectRatio: `${W} / ${H}` }}>
        <path d={area((s) => Math.min(s.truthWindow, L), () => 0)} className="fill-emerald-500/15" />
        <path d={area((s) => Math.max(s.truthWindow, L), () => L)} className="fill-rose-500/45" />
        {!tickets && <path d={path((s) => s.offeredWindow, ys)} fill="none" strokeWidth={1} strokeDasharray="2 3" className="stroke-zinc-500" />}
        <path d={path((s) => s.truthWindow, ys)} fill="none" strokeWidth={1.5} className="stroke-emerald-400" />
        <path d={path((s) => s.latencyMs, yl)} fill="none" strokeWidth={1} className="stroke-amber-400/80" />
        <line x1={PL} x2={W - PR} y1={ys(L)} y2={ys(L)} strokeWidth={1} strokeDasharray="5 4" className="stroke-zinc-400" />
        <text x={W - PR - 4} y={ys(L) - 4} textAnchor="end" className={label}>limit {fmt(L)}</text>
        {pts.filter((p) => p.s.cut !== undefined || p.s.healed !== undefined || p.s.burstStart !== undefined || p.s.dropStart).map((p) => (
          <line key={p.s.tick} x1={p.x} x2={p.x} y1={PT} y2={p.s.dropStart ? H - PB : PT + 10} strokeWidth={p.s.dropStart ? 1 : 2} strokeDasharray={p.s.dropStart ? '3 3' : undefined}
            className={p.s.cut !== undefined ? 'stroke-rose-500' : p.s.healed !== undefined ? 'stroke-emerald-400' : p.s.dropStart ? 'stroke-violet-400/70' : 'stroke-orange-400'} />
        ))}
        <text x={PL - 4} y={ys(0) + 3} textAnchor="end" className={label}>0</text>
        <text x={PL - 4} y={ys(L) + 3} textAnchor="end" className={label}>{tickets ? '1k' : '1k'}</text>
        <text x={PL - 4} y={ys(yMax) + 8} textAnchor="end" className={label}>{tickets ? '1.2k' : '2k'}</text>
        <text x={W - PR + 4} y={yl(200) + 8} className="font-mono text-[10px] fill-amber-400/70">200 ms</text>
        <text x={W - PR + 4} y={yl(0) + 3} className="font-mono text-[10px] fill-amber-400/70">0 ms</text>
        <text x={PL} y={H - 4} className={label}>-30 s</text>
        <text x={PL + iw / 2} y={H - 4} textAnchor="middle" className={label}>-15 s</text>
        <text x={W - PR} y={H - 4} textAnchor="end" className={label}>now</text>
      </svg>
    </div>
  );
}

function Controls({ config, update, onPreset, onSpike, onNewDrop, onToggleLink, sim }: {
  config: SimConfig; update: (p: Partial<SimConfig>) => void; onPreset: (id: keyof typeof PRESETS) => void; onSpike: () => void;
  onNewDrop: () => void; onToggleLink: (i: number) => void; sim: SimState;
}) {
  const meta = modeMeta(config.mode);
  const slider = ACCENT[meta.accent].slider;
  const cp = config.mode === 'cp';
  const blind = config.gossipMs >= WINDOW_TICKS * TICK_MS;
  const tickets = config.windowTicks === Infinity;
  const rate = tickets ? config.ratePerNode * TICKET_RATE_SCALE : config.ratePerNode;
  const section = 'text-[10px] uppercase tracking-wider text-zinc-500';
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
      <div data-tour="traffic" title="Mean arrivals per node. Traffic is random around this value and one region is always a little hotter than the others.">
        <div className="flex items-baseline justify-between">
          <span className={section}>Traffic</span>
          <span className="font-mono text-[13px] tabular-nums text-zinc-100">{fmt(rate)} <span className="text-zinc-500">{tickets ? 'buyers/s' : 'req/s'}</span></span>
        </div>
        <div className="text-[11px] text-zinc-400">{tickets ? 'Buyers per site' : 'Incoming per node'}</div>
        <input type="range" min={0} max={500} step={10} value={config.ratePerNode} onChange={(e) => update({ ratePerNode: +e.target.value })} className={cls('mt-1 w-full', slider)} aria-label="Incoming traffic per node" />
        <div className="font-mono text-[11px] text-zinc-500">≈ {fmt(rate * N)} total · {tickets ? `${fmt(config.limit)} seats per drop` : `limit ${fmt(config.limit)} req/s`}</div>
      </div>
      <div data-tour="gossip" title="How often each edge exchanges counters with the store in Eventual mode. Longer means a staler view." className={cp || config.mode === 'static' ? 'opacity-50' : ''}>
        <div className="flex items-baseline justify-between">
          <span className={section}>Sync</span>
          <span className="font-mono text-[13px] tabular-nums text-zinc-100">{config.gossipMs} <span className="text-zinc-500">ms</span></span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">Gossip interval <GossipHint /></div>
        <input type="range" min={200} max={2000} step={200} value={config.gossipMs} disabled={cp || config.mode === 'static'} onChange={(e) => update({ gossipMs: +e.target.value })} className={cls('mt-1 w-full', slider)} aria-label="Gossip interval in milliseconds" />
        <div className="flex justify-between font-mono text-[10px] text-zinc-600"><span>every tick</span><span>1 s = window</span><span>2 s</span></div>
        <div className="text-[11px] text-zinc-500">
          {cp ? 'unused — every request asks the store' : config.mode === 'static' ? 'unused — nothing to sync' : blind ? 'blind: a view older than the window counts for nothing' : "how stale a node's view may get"}
        </div>
      </div>
      <div>
        <div className={section}>Links to the store</div>
        <div className="mt-1 flex flex-col gap-1">
          {NODES.map((n, i) => {
            const cut = config.partitioned[i];
            const since = sim.partitionSince[i];
            return (
              <label key={n.code} className="flex cursor-pointer items-center gap-2 text-[12px]">
                <button role="switch" aria-checked={!cut} aria-label={`${n.city} link to the store`} onClick={() => onToggleLink(i)}
                  className={cls('relative h-4 w-7 rounded-full transition-colors', cut ? 'bg-rose-500/70' : 'bg-emerald-500/70')}>
                  <span className={cls('absolute top-0.5 h-3 w-3 rounded-full bg-zinc-950 transition-transform', cut ? 'translate-x-0.5' : 'translate-x-3.5')} />
                </button>
                <span className="font-mono text-zinc-200">{n.code}</span>
                <span className="text-zinc-500">{n.city}</span>
                <span className="ml-auto font-mono text-[10px] text-zinc-500">
                  {cut ? <span className="text-rose-400">{since === null ? 'cut' : `cut ${secs(sim.tick - since)} s`}</span> : <><Link2 size={10} className="inline" /> {n.rttMs} ms</>}
                </span>
              </label>
            );
          })}
        </div>
      </div>
      <div>
        <div className={section}>Scenarios <span className="normal-case tracking-normal text-zinc-600">· hover for what to watch</span></div>
        <div className="mt-1 grid grid-cols-2 gap-1.5">
          {PRESET_META.map(({ id, label, hint, Icon }) => (
            <button key={id} onClick={() => onPreset(id)} title={hint} className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-left text-[12px] text-zinc-200 hover:border-zinc-500">
              <Icon size={12} className="shrink-0 text-zinc-400" /> {label}
            </button>
          ))}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <button onClick={onSpike} title="A 3× flash crowd on a random node for 4 s" className="flex items-center gap-1.5 rounded-md border border-orange-500/40 bg-zinc-900 px-2 py-1 text-[12px] text-orange-300 hover:border-orange-400">
            <Zap size={12} /> Spike a node
          </button>
          {tickets && (
            <button onClick={onNewDrop} title="Clear the seats and start selling again with the current settings" className="flex items-center gap-1.5 rounded-md border border-violet-500/40 bg-zinc-900 px-2 py-1 text-[12px] text-violet-300 hover:border-violet-400">
              <Ticket size={12} /> New drop
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CapBadge({ config }: { config: SimConfig }) {
  const anyCut = config.partitioned.some(Boolean);
  const meta = modeMeta(config.mode);
  const hex = ACCENT[meta.accent].hex;
  const C = { x: 80, y: 20 }, A = { x: 22, y: 120 }, P = { x: 138, y: 120 };
  const edge = config.mode === 'ap' ? [A, P] : config.mode === 'cp' ? [C, P] : [C, A];
  const chosen = (v: 'C' | 'A' | 'P') => (config.mode === 'ap' ? v !== 'C' : config.mode === 'cp' ? v !== 'A' : v !== 'P');
  const caption = config.mode === 'ap' ? 'Choosing A: keep answering, accept being wrong.' : config.mode === 'cp' ? 'Choosing C: be exact, accept saying no.' : 'Dodging the choice: no shared state, wasted capacity.';
  const dot = (v: 'C' | 'A' | 'P', p: { x: number; y: number }, tip: string) => (
    <g>
      <title>{tip}</title>
      <circle cx={p.x} cy={p.y} r={9} fill={chosen(v) ? hex : '#3f3f46'} />
      <text x={p.x} y={p.y + 4} textAnchor="middle" className="fill-zinc-950 font-mono text-[11px] font-bold">{v}</text>
    </g>
  );
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">The trade-off you are making</div>
      <div className="mt-1 flex items-center gap-3">
        <svg viewBox="0 0 160 140" className="h-[92px] w-[105px] shrink-0">
          <polygon points={`${C.x},${C.y} ${A.x},${A.y} ${P.x},${P.y}`} fill="none" strokeWidth={1.5} className="stroke-zinc-700" />
          <line x1={edge[0].x} y1={edge[0].y} x2={edge[1].x} y2={edge[1].y} stroke={hex} strokeWidth={4} strokeDasharray={config.mode === 'static' ? '4 4' : undefined} />
          {dot('C', C, 'Consistency — every node sees the same count at the same time.')}
          {dot('A', A, 'Availability — every request gets an answer, even a stale one.')}
          {dot('P', P, "Partition tolerance — the network will break; you don't get to opt out.")}
          <text x={P.x} y={P.y + 20} textAnchor="middle" className={cls('font-mono text-[9px]', anyCut ? 'fill-rose-400' : 'fill-zinc-500')}>{anyCut ? 'happening' : 'forced'}</text>
        </svg>
        <div className="text-[12px] leading-snug text-zinc-300">
          <div className="font-medium text-zinc-100">{meta.label}</div>
          <div className="mt-1">{caption}</div>
          <div className="mt-1 text-[11px] text-zinc-500">P is not optional: networks fail. The choice is what to do meanwhile.</div>
        </div>
      </div>
    </div>
  );
}

const shadowsFor = (c: SimConfig): Record<Mode, SimState> =>
  ({ ap: createSim({ ...c, mode: 'ap' }, SEED), cp: createSim({ ...c, mode: 'cp' }, SEED), static: createSim({ ...c, mode: 'static' }, SEED) });

export default function CapSimulator() {
  const [config, setConfig] = useState<SimConfig>(configFromUrl);
  const configRef = useRef(config);
  configRef.current = config;
  const [sim, setSim] = useState(() => createSim(config, SEED));
  const [shadows, setShadows] = useState(() => shadowsFor(config));
  const [running, setRunning] = useState(true);
  const [tour, setTour] = useState<number | null>(null);
  const [auto, setAuto] = useState(false);
  const [intro, setIntro] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [flashes, setFlashes] = useState<Flash[]>([]);
  const [floats, setFloats] = useState<Float[]>([]);
  const [heal, setHeal] = useState<{ report: PartitionReport; untilTick: number } | null>(null);
  const [narration, setNarration] = useState<Narration | null>(null);
  const [pingKey, setPingKey] = useState(0);
  const reduceMotion = useRef(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

  // The 200 ms tick. Sliders write configRef, so they never restart the interval.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const c = configRef.current;
      setSim((s) => stepSim(s, c));
      // The comparison panel only exists for the rate limiter; ticket drops are compared through the drop log.
      if (c.windowTicks !== Infinity)
        setShadows((sh) => ({ ap: stepSim(sh.ap, { ...c, mode: 'ap' }), cp: stepSim(sh.cp, { ...c, mode: 'cp' }), static: stepSim(sh.static, { ...c, mode: 'static' }) }));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [running]);

  // Keep the address bar in sync so any situation can be shared as a link.
  useEffect(() => {
    try { history.replaceState(null, '', urlFor(config)); } catch { /* sandboxed */ }
  }, [config]);

  // Per-tick animation batches and narration, derived from the latest sample and events.
  useEffect(() => {
    const last = sim.history[sim.history.length - 1];
    if (!last) return;
    const ev = sim.events;
    if (!reduceMotion.current) {
      const items = particlesFor(last, ev, config.mode, config.partitioned);
      setBatches((b) => [...b.filter((x) => x.tick !== sim.tick && sim.tick - x.tick < 4), { tick: sim.tick, items }]);
      setFlashes((f) => [...f.filter((x) => x.tick !== sim.tick && sim.tick - x.tick < 4), ...ev.synced.map((node) => ({ key: `${sim.tick}-${node}`, node, tick: sim.tick }))]);
    }
    let healNow = heal;
    if (ev.healed) {
      healNow = { report: ev.healed, untilTick: sim.tick + 30 };
      setHeal(healNow);
      const r = ev.healed;
      const text = r.excess > 0 ? `+${fmt(r.excess)} over the limit` : r.failed > 0 ? `${fmt(r.failed)} refused` : 'no damage';
      setFloats((f) => [...f.filter((x) => sim.tick - x.tick < 9), { key: `${sim.tick}-${r.node}`, node: r.node, text, tone: r.excess > 0 ? 'rose' : 'zinc', tick: sim.tick }]);
    } else {
      setFloats((f) => (f.some((x) => sim.tick - x.tick >= 9) ? f.filter((x) => sim.tick - x.tick < 9) : f));
    }
    const next = narrate(last, config, sim, healNow);
    // Hold a sentence for 1.6 s unless something more important happens, so the line does not flicker.
    setNarration((cur) => (cur && cur.key !== next.key && next.prio <= cur.prio && sim.tick - cur.since < 8 ? cur : cur && cur.key === next.key ? { ...cur, text: next.text } : { ...next, since: sim.tick }));
  }, [sim.tick]);

  // First visit: explain what this is before the numbers start moving.
  useEffect(() => {
    try { if (!localStorage.getItem('capsim.intro')) setIntro(true); } catch { setIntro(true); }
  }, []);
  const closeIntro = () => { setIntro(false); try { localStorage.setItem('capsim.intro', '1'); } catch { /* private mode */ } };

  const tickets = config.windowTicks === Infinity;
  const update = (p: Partial<SimConfig>) => setConfig((c) => ({ ...c, ...p }));
  // In the ticket sale, a mode or link change restarts the drop so the result reflects the new choice.
  const setMode = (mode: Mode) => {
    if (mode === config.mode) return;
    update({ mode }); setPingKey((k) => k + 1);
    if (tickets) setSim((s) => restartDrop(s));
  };
  const toggleLink = (i: number) => {
    update({ partitioned: config.partitioned.map((p, j) => (j === i ? !p : p)) });
    if (tickets) setSim((s) => restartDrop(s));
  };
  const reset = () => {
    setSim(createSim(configRef.current, SEED)); setShadows(shadowsFor(configRef.current));
    setBatches([]); setFlashes([]); setFloats([]); setHeal(null); setNarration(null);
  };
  const toggleScenario = () => {
    const next = { ...configRef.current, windowTicks: tickets ? WINDOW_TICKS : Infinity, partitioned: NONE };
    setConfig(next); setSim(createSim(next, SEED)); setShadows(shadowsFor(next));
    setBatches([]); setFloats([]); setHeal(null); setNarration(null);
  };
  const applyPreset = (id: keyof typeof PRESETS) => update(PRESETS[id]);
  const goTour = (s: number) => {
    setTour(s);
    const apply = TOUR[s].apply;
    if (apply.windowTicks !== undefined && apply.windowTicks !== configRef.current.windowTicks) {
      const next = { ...configRef.current, ...apply };
      setConfig(next); setSim(createSim(next, SEED)); setShadows(shadowsFor(next));
    } else update(apply);
  };
  const closeTour = () => { setTour(null); setAuto(false); };

  // Auto-play advances the tour every TOUR_STEP_MS and closes it after the last step.
  useEffect(() => {
    if (tour === null || !auto) return;
    const id = setTimeout(() => (tour >= TOUR.length - 1 ? closeTour() : goTour(tour + 1)), TOUR_STEP_MS);
    return () => clearTimeout(id);
  }, [tour, auto]);

  return (
    <div className="min-h-screen bg-zinc-950 font-sans text-zinc-200">
      {intro && <Intro onClose={closeIntro} onTour={() => { closeIntro(); setAuto(false); goTour(0); }} />}
      <Spotlight target={tour === null ? null : TOUR[tour].target} />
      <div className="mx-auto flex max-w-[1340px] flex-col gap-2.5 p-4">
        <Header config={config} running={running} onMode={setMode} onScenario={toggleScenario} onRun={() => setRunning((r) => !r)} onReset={reset} onIntro={() => setIntro(true)} />
        <TourRow step={tour} auto={auto} onStep={goTour} onAuto={setAuto} onClose={closeTour} />
        <div className="grid grid-cols-1 gap-3 min-[1180px]:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex min-w-[860px] flex-col gap-2.5">
            <Stage sim={sim} config={config} batches={batches} flashes={flashes} floats={floats} pingKey={pingKey} onToggleLink={toggleLink} />
            <div className="flex h-10 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 text-[13px] text-zinc-300" title="What is happening right now, in plain words.">
              <TriangleAlert size={13} className={cls('shrink-0', narration && narration.prio >= 4 ? 'text-rose-400' : narration && narration.prio >= 2 ? 'text-amber-400' : 'text-emerald-400')} />
              <span className="truncate tabular-nums">{narration?.text ?? 'Starting the edge…'}</span>
            </div>
            <Metrics history={sim.history} config={config} />
            <Chart history={sim.history} config={config} />
          </div>
          <div className="flex flex-col gap-3">
            <Controls config={config} update={update} onPreset={applyPreset} onSpike={() => setSim((s) => triggerBurst(s))} onNewDrop={() => setSim((s) => restartDrop(s))} onToggleLink={toggleLink} sim={sim} />
            {!tickets && <Compare shadows={shadows} config={config} />}
            <CapBadge config={config} />
          </div>
        </div>
      </div>
    </div>
  );
}
