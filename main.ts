// Trophy rarity forecaster for gta6-trophy-rarity-forecast-01.
//
// What it forecasts: for every trophy of Grand Theft Auto VI on PS5, five
// quantiles of its Exophase earn rate (percent of tracked players who earned
// it) at the case's target instant.
//
// How it works, in one paragraph: an earn rate is a ratio, earners over
// players tracked, and both sides move. On launch night the tracked set is a
// few hundred hardcore players and the rates sit near 1%; as the week goes on
// the tracked set grows with more casual players (which drags most rates
// down) while the players already in keep playing through the game (which
// pushes story trophies up). So a flat "rates stay put" forecast is wrong in
// a systematic direction, and the direction differs per trophy. This program
// fits, per trophy, a damped trend of the rate's logit against log-time
// (log-time is concave, so a straight line in it already slows down), with
// each read weighted by how fresh it is and by how precisely its rate is
// measured (a rate from 638 tracked players is far noisier than one from
// 50,000), then pulls each trophy's slope toward the mean slope of its tier
// and of all trophies, so noisy trophies borrow strength from the group.
// The median blends the trend with the last read, the move from the last
// read is capped, and the spread combines the horizon's random-walk width,
// the slope's own uncertainty, the fit's residuals and the size of the jumps
// between past reads, so a history that says nothing (flat launch night)
// still gets an honest wide band.
//
// It runs offline, standard library only, deterministic: no randomness, no
// clock, no network. Every case file in the input directory is read in name
// order and one forecast file per case is written.
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

/** Percent clamped into the range the scorer's logit can take. */
function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 1;
  if (pct < 0.01) return 0.01;
  if (pct > 99.99) return 99.99;
  return pct;
}

/** logit of a percent: ln(p / (100 - p)) with p clamped. */
function logitOf(pct: number): number {
  const p = clampPct(pct);
  return Math.log(p / (100 - p));
}

/** Inverse logistic: back from logit units to a percent. */
function pctOf(logit: number): number {
  if (logit >= 40) return 99.99;
  if (logit <= -40) return 0.01;
  return 100 / (1 + Math.exp(-logit));
}

/** A number rounded to 4 decimals (half away from zero, via Math.round). */
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function clampNum(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Inverse of the standard normal CDF (Acklam's rational approximation,
 * accurate to ~1e-9). Lets the program honour whatever levels a case asks
 * for instead of hard-coding five z values.
 */
function normalQuantile(prob: number): number {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687,
    138.357751867269, -30.66479806614716, 2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866,
    66.80131188771972, -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    0.007784695709041462, 0.3224671290700398, 2.445134137142996,
    3.754408661907416,
  ];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  const p = clampNum(prob, 0.0001, 0.9999);
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  q = p - 0.5;
  r = q * q;
  return (
    (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
    q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

// ---------------------------------------------------------------------------
// Case file shapes
// ---------------------------------------------------------------------------

type TrophyIn = {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
};

type ReadIn = {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: Array<number | null>;
};

type CaseIn = {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { name: string; platform: string; release_date: string; source: string };
  trophies: TrophyIn[];
  history: ReadIn[];
  notes?: string;
};

/** One read after collapsing, with its time in hours since the release. */
type Point = {
  hours: number;
  players: number;
  rate: number | null;
};

/** Release instant: GTA VI launched 2026-11-19 (UTC). */
const RELEASE_MS = Date.parse('2026-11-19T00:00:00Z');

function hoursSinceRelease(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 0;
  return (ms - RELEASE_MS) / 3_600_000;
}

/** Log-time: concave in clock time, so a straight line in it decelerates. */
function logTime(hours: number): number {
  return Math.log(Math.max(0.05, 1 + hours));
}

// ---------------------------------------------------------------------------
// Per-trophy trend fit
// ---------------------------------------------------------------------------

/** Result of fitting one trophy's logit-rate series against log-time. */
type TrendFit = {
  /** Slope in logit units per log-time unit. */
  slope: number;
  /** Standard error of the slope. */
  slopeSe: number;
  /** Fitted logit at the last read's log-time. */
  anchor: number;
  /** Log-time of the last read used. */
  anchorX: number;
  /** Weighted residual spread of the fit, in logit units. */
  residSd: number;
  /** Typical one-step jump between distinct reads, in logit units. */
  stepRms: number;
  /** Number of distinct reads the fit used. */
  n: number;
};

/**
 * Collapse consecutive reads that show the same page (same players tracked
 * and same rates): they carry no new information, and counting them would
 * let a frozen stretch dominate the fit. Keeps the latest of each run.
 */
function distinctReads(history: ReadIn[]): ReadIn[] {
  const out: ReadIn[] = [];
  for (const read of history) {
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      prev.players_tracked === read.players_tracked &&
      prev.rates.length === read.rates.length &&
      prev.rates.every((r, i) => r === read.rates[i])
    ) {
      out[out.length - 1] = read;
    } else {
      out.push(read);
    }
  }
  return out;
}

/**
 * Fit one trophy. `series` is its (time, players, rate) points, oldest
 * first, already collapsed. Returns null when there is too little to fit.
 */
function fitTrophy(series: Point[]): TrendFit | null {
  const usable = series.filter((p) => p.rate !== null);
  if (usable.length < 3) return null;

  const last = usable[usable.length - 1];
  // Only the recent past matters: the last 36 hours of reads, or all of
  // them when the history is shorter than that.
  const windowStart = last.hours - 36;
  let window = usable.filter((p) => p.hours >= windowStart);
  if (window.length < 3) window = usable;

  const lastX = logTime(last.hours);
  let sumW = 0;
  let sumWX = 0;
  let sumWY = 0;
  const rows: Array<{ x: number; y: number; w: number }> = [];
  for (const p of window) {
    const rate = p.rate as number;
    const earners = (clampPct(rate) / 100) * Math.max(1, p.players);
    // Delta-method variance of the log-odds from binomial sampling, plus a
    // floor for refresh lumpiness. Early reads from a few hundred tracked
    // players are far noisier than later ones from tens of thousands.
    const binVar =
      1 / Math.max(0.5, earners) +
      1 / Math.max(0.5, Math.max(1, p.players) - earners);
    const variance = binVar + 0.04;
    // Recency: a read halves in weight every 12 hours.
    const recency = Math.pow(0.5, Math.max(0, last.hours - p.hours) / 12);
    const w = recency / variance;
    rows.push({ x: logTime(p.hours), y: logitOf(rate), w });
    sumW += w;
    sumWX += w * logTime(p.hours);
    sumWY += w * logitOf(rate);
  }
  if (sumW <= 0 || rows.length < 3) return null;
  const meanX = sumWX / sumW;
  const meanY = sumWY / sumW;

  let sxx = 0;
  let sxy = 0;
  for (const r of rows) {
    sxx += r.w * (r.x - meanX) * (r.x - meanX);
    sxy += r.w * (r.x - meanX) * (r.y - meanY);
  }
  if (sxx <= 1e-12) return null; // no spread in time: slope unidentified
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  // Residual spread and a scale-corrected slope standard error.
  let chi2 = 0;
  for (const r of rows) {
    const resid = r.y - (intercept + slope * r.x);
    chi2 += r.w * resid * resid;
  }
  const dof = Math.max(1, rows.length - 2);
  const scale = Math.max(1, chi2 / dof);
  const slopeSe = Math.sqrt(scale / sxx);
  const residSd = Math.sqrt(Math.max(0, chi2 / sumW));

  // One-step jumps between distinct reads: how lumpy the page moves.
  let stepSq = 0;
  let steps = 0;
  for (let i = 1; i < usable.length; i++) {
    const a = usable[i - 1].rate as number;
    const b = usable[i].rate as number;
    const d = logitOf(b) - logitOf(a);
    stepSq += d * d;
    steps++;
  }
  const stepRms = steps > 0 ? Math.sqrt(stepSq / steps) : 0;

  return {
    slope,
    slopeSe,
    anchor: intercept + slope * lastX,
    anchorX: lastX,
    residSd: Math.min(0.6, residSd),
    stepRms,
    n: rows.length,
  };
}

// ---------------------------------------------------------------------------
// Forecasting one case
// ---------------------------------------------------------------------------

/** Tuning: how much the trend is trusted over the last read (0..1). */
const TREND_WEIGHT = 0.8;
/** Prior spread of a trophy's slope, in logit units per log-time unit. */
const SLOPE_PRIOR_SD = 0.6;
/** Random-walk width of the spread, in logit units per square-root day. */
const WALK_PER_SQRT_DAY = 0.3;
/** Hard cap on how far the median may move from the last read, logit units. */
const MAX_MOVE = 3;
/** Spread bounds, in logit units. */
const SPREAD_MIN = 0.5;
const SPREAD_MAX = 1.2;

function forecastCase(c: CaseIn): { trophies: Array<{ id: number; q: number[] }> } {
  const reads = distinctReads(c.history);
  const horizonDays = Math.max(0, c.horizon_minutes / 1440);
  const targetX = logTime(hoursSinceRelease(c.target));
  const zValues = c.levels.map((t) => normalQuantile(t));

  // Per-trophy series, then a fit per trophy.
  const fits = new Map<number, TrendFit>();
  const lastRate = new Map<number, number>();
  for (let j = 0; j < c.trophies.length; j++) {
    const series: Point[] = reads.map((r) => ({
      hours: hoursSinceRelease(r.at),
      players: r.players_tracked,
      rate: j < r.rates.length ? r.rates[j] : null,
    }));
    const fit = fitTrophy(series);
    if (fit !== null) fits.set(j, fit);
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i].rate !== null) {
        lastRate.set(j, series[i].rate as number);
        break;
      }
    }
    if (!lastRate.has(j)) lastRate.set(j, 1);
  }

  // Group means of the fitted slopes, for shrinkage: per tier, then all.
  const slopeStats = (indices: number[]): { mean: number; weight: number } => {
    let num = 0;
    let den = 0;
    for (const j of indices) {
      const f = fits.get(j);
      if (f === undefined) continue;
      const w = 1 / (f.slopeSe * f.slopeSe + 0.01);
      num += w * f.slope;
      den += w;
    }
    return { mean: den > 0 ? num / den : 0, weight: den };
  };
  const globalStats = slopeStats(c.trophies.map((_, j) => j));
  const tierStats = new Map<string, { mean: number; weight: number }>();
  for (const tier of new Set(c.trophies.map((t) => t.tier))) {
    const idx = c.trophies
      .map((t, j) => (t.tier === tier ? j : -1))
      .filter((j) => j >= 0);
    if (idx.length >= 3) tierStats.set(tier, slopeStats(idx));
  }
  // Typical one-step jump across all trophies, for trophies with no steps.
  const allSteps: number[] = [];
  for (const f of fits.values()) if (f.stepRms > 0) allSteps.push(f.stepRms);
  allSteps.sort((a, b) => a - b);
  const typicalStep =
    allSteps.length > 0 ? allSteps[Math.floor(allSteps.length / 2)] : 0;

  const rows: Array<{ id: number; q: number[] }> = [];
  for (let j = 0; j < c.trophies.length; j++) {
    const trophy = c.trophies[j];
    const last = lastRate.get(j) ?? 1;
    const lastLogit = logitOf(last);
    const fit = fits.get(j);

    let medianLogit: number;
    let spread: number;
    if (fit === undefined) {
      // No usable trend: hold the last rate, and say so with a wide band.
      medianLogit = lastLogit;
      spread = 1.0;
    } else {
      // Shrink the slope toward its tier's mean (or the global mean when
      // the tier is too small to speak for itself).
      const prior = tierStats.get(trophy.tier) ?? globalStats;
      const priorMean = prior.weight > 0 ? prior.mean : globalStats.mean;
      const priorVar = SLOPE_PRIOR_SD * SLOPE_PRIOR_SD;
      const likeVar = fit.slopeSe * fit.slopeSe;
      const slopeShrunk =
        (fit.slope / likeVar + priorMean / priorVar) /
        (1 / likeVar + 1 / priorVar);
      const slopePostSd = Math.sqrt(1 / (1 / likeVar + 1 / priorVar));

      const deltaX = targetX - fit.anchorX;
      const trendLogit = fit.anchor + slopeShrunk * deltaX;
      const blended = TREND_WEIGHT * trendLogit + (1 - TREND_WEIGHT) * lastLogit;
      medianLogit = lastLogit + clampNum(blended - lastLogit, -MAX_MOVE, MAX_MOVE);
      medianLogit = clampNum(medianLogit, logitOf(0.01), logitOf(99.99));

      const walk = WALK_PER_SQRT_DAY * Math.sqrt(horizonDays);
      const slopeUnc = slopePostSd * Math.abs(deltaX);
      const shock = 0.5 * (fit.stepRms > 0 ? fit.stepRms : typicalStep);
      spread = Math.sqrt(
        walk * walk + slopeUnc * slopeUnc + fit.residSd * fit.residSd + shock * shock,
      );
      spread = clampNum(spread, SPREAD_MIN, SPREAD_MAX);
    }

    const qs = zValues.map((z) => {
      const q = pctOf(medianLogit + z * spread);
      return round4(clampNum(q, 0.01, 99.99));
    });
    // Keep the row non-decreasing even after rounding.
    for (let k = 1; k < qs.length; k++) {
      if (qs[k] < qs[k - 1]) qs[k] = qs[k - 1];
    }
    rows.push({ id: trophy.id, q: qs });
  }
  return { trophies: rows };
}

// ---------------------------------------------------------------------------
// Driver: every case in, one forecast file per case out
// ---------------------------------------------------------------------------

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(outputDir, { recursive: true });
const caseFiles = readdirSync(inputDir)
  .filter((f) => f.endsWith('.in'))
  .sort();
if (caseFiles.length === 0) throw new Error(`no case files in ${inputDir}`);
for (const file of caseFiles) {
  const id = file.slice(0, -'.in'.length);
  const parsed = JSON.parse(readFileSync(joinPath(inputDir, file), 'utf8')) as CaseIn;
  const forecast = forecastCase(parsed);
  const text = `${JSON.stringify(forecast)}\n`;
  if (Buffer.byteLength(text, 'utf8') > 65_536) {
    throw new Error(`${id}.out would exceed 65,536 bytes`);
  }
  writeFileSync(joinPath(outputDir, `${id}.out`), text);
}
