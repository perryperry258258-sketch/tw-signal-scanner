// ============================================================
// 快速特徵引擎（逐日滾動計算，一次算完整段歷史）
// 規則：第 t 天的每一個特徵，只能用 bars[0..t] 的資料。
//      Phase 3 會用「擾動未來資料」測試，以及和舊引擎逐筆比對來驗證。
// bars: [{date, open, high, low, close, volume, money}]（還原股價）
// ============================================================
import { CONFIG as C } from '../lib/config.js';

const weekKey = s => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const monthKey = s => s.slice(0, 7);

// 週／月 5MA、20MA（live 模式：含當週／當月未完成K棒，與舊引擎相同）
function periodMA(bars, keyFn, withCross) {
  if (C.MA_MODE !== 'live') throw new Error('快速引擎目前只支援 MA_MODE=live');
  const n = bars.length;
  const pIdx = new Int32Array(n);
  const done = []; // 已完成期間的收盤價
  let key = null, p = -1;
  for (let i = 0; i < n; i++) {
    const k = keyFn(bars[i].date);
    if (k !== key) { if (p >= 0) done.push(bars[i - 1].close); key = k; p++; }
    pIdx[i] = p;
  }
  const ma5 = new Float64Array(n).fill(NaN), ma20 = new Float64Array(n).fill(NaN), cross = new Uint8Array(n);
  const val = (k, w, cur) => (k < w ? done[k] : cur);
  const maAt = (k, len, w, cur) => { if (k + 1 < len) return NaN; let s = 0; for (let q = k - len + 1; q <= k; q++) s += val(q, w, cur); return s / len; };
  for (let i = 0; i < n; i++) {
    const w = pIdx[i], cur = bars[i].close;
    ma5[i] = maAt(w, 5, w, cur); ma20[i] = maAt(w, 20, w, cur);
    if (withCross) {
      // 最近 WEEKLY_CROSS_WITHIN 根內（含本根）是否發生 5MA 由下往上穿越 20MA
      for (let q = w; q >= Math.max(1, w - C.WEEKLY_CROSS_WITHIN + 1); q--) {
        const a20 = maAt(q, 20, w, cur), b20 = maAt(q - 1, 20, w, cur);
        if (isNaN(a20) || isNaN(b20)) break;
        const a = maAt(q, 5, w, cur) - a20, b = maAt(q - 1, 5, w, cur) - b20;
        if (a > 0 && b <= 0) { cross[i] = 1; break; }
      }
    }
  }
  return { ma5, ma20, cross };
}

// 大盤環境（加權指數）：週5>週20、收盤>週20、月5>月20，3 分 = 多方、0 分 = 空方
export function marketEnv(idxBars) {
  const wk = periodMA(idxBars, weekKey, false), mo = periodMA(idxBars, monthKey, false);
  const env = new Map();
  idxBars.forEach((b, i) => {
    if (isNaN(wk.ma20[i]) || isNaN(mo.ma20[i])) return;
    const s = (wk.ma5[i] > wk.ma20[i]) + (b.close > wk.ma20[i]) + (mo.ma5[i] > mo.ma20[i]);
    env.set(b.date, s === 3 ? '多方' : s === 0 ? '空方' : '震盪');
  });
  return env;
}

// 滑動視窗最大／最小（單調佇列，O(n)）
// out[i] = a[i-N+1..i] 的最大值；partial=true 時允許不滿 N 天，否則不滿 N 天為 NaN
function sliding(a, N, partial, isMax) {
  const n = a.length, out = new Float64Array(n).fill(NaN), dq = new Int32Array(n);
  let h = 0, t = 0;
  for (let i = 0; i < n; i++) {
    while (t > h && (isMax ? a[dq[t - 1]] <= a[i] : a[dq[t - 1]] >= a[i])) t--;
    dq[t++] = i;
    while (dq[h] <= i - N) h++;
    if (partial || i >= N - 1) out[i] = a[dq[h]];
  }
  return out;
}
// 「前 N 天」（不含當天）的最大值：out[d] = max(a[d-N..d-1])
function priorMax(a, N) { const s = sliding(a, N, false, true), out = new Float64Array(a.length).fill(NaN); for (let d = N; d < a.length; d++) out[d] = s[d - 1]; return out; }
function rangeMax(a, from, to) { if (from < 0 || to < from) return NaN; let m = -Infinity; for (let i = from; i <= to; i++) if (a[i] > m) m = a[i]; return m; }
function rangeMin(a, from, to) { if (from < 0 || to < from) return NaN; let m = Infinity; for (let i = from; i <= to; i++) if (a[i] < m) m = a[i]; return m; }

// 最長整理區間：以 e 為結尾、最高/最低 - 1 ≤ R 的最長區間（雙指標，O(n)）
function baseWindows(H, L, R) {
  const n = H.length, len = new Int32Array(n), hi = new Float64Array(n), lo = new Float64Array(n);
  const dMax = [], dMin = [];
  let s = 0, hMax = 0, hMin = 0; // deque 頭指標
  for (let e = 0; e < n; e++) {
    while (dMax.length > hMax && H[dMax[dMax.length - 1]] <= H[e]) dMax.pop();
    dMax.push(e);
    while (dMin.length > hMin && L[dMin[dMin.length - 1]] >= L[e]) dMin.pop();
    dMin.push(e);
    while (H[dMax[hMax]] / L[dMin[hMin]] - 1 > R) {
      s++;
      if (dMax[hMax] < s) hMax++;
      if (dMin[hMin] < s) hMin++;
    }
    len[e] = e - s + 1; hi[e] = H[dMax[hMax]]; lo[e] = L[dMin[hMin]];
  }
  return { len, hi, lo };
}

export function computeFeatures(bars, envMap) {
  const n = bars.length;
  const H = bars.map(b => b.high), L = bars.map(b => b.low), Cl = bars.map(b => b.close), V = bars.map(b => b.volume || 0), M = bars.map(b => b.money || 0);
  const pre = a => { const p = new Float64Array(a.length + 1); for (let i = 0; i < a.length; i++) p[i + 1] = p[i] + a[i]; return p; };
  const PV = pre(V), PM = pre(M);
  const avg = (P, from, to) => (from < 0 || to < from ? NaN : (P[to + 1] - P[from]) / (to - from + 1));

  const wk = periodMA(bars, weekKey, true), mo = periodMA(bars, monthKey, false);
  const W = C.BREAKOUT_WINDOWS, minN = Math.min(...W);

  // 每天的「收盤突破前高」等級（取突破的最大天數那條），供最近突破事件使用
  const PRIOR = Object.fromEntries(W.map(N => [N, priorMax(H, N)]));
  const brLevel = new Float64Array(n).fill(NaN);
  for (let j = 0; j < n; j++) for (const N of W) { const p = PRIOR[N][j]; if (!isNaN(p) && Cl[j] > p) brLevel[j] = p; }
  const HI1Y = priorMax(H, 250), HI2Y = priorMax(H, 500), HI3Y = priorMax(H, 750);
  const H52 = sliding(H, C.YEAR_BARS, true, true), L52 = sliding(L, C.YEAR_BARS, true, false);
  const L20P = (() => { const s = sliding(L, 20, false, false), o = new Float64Array(n).fill(NaN); for (let d = 20; d < n; d++) o[d] = s[d - 1]; return o; })();

  // 波段低點（左右各 K 根），只標記「形狀」；是否已被確認由當天決定
  const K = C.SWING_K;
  const fractal = new Uint8Array(n);
  for (let i = K; i < n - K; i++) {
    let ok = true;
    for (let k = 1; k <= K; k++) if (!(L[i] < L[i - k] && L[i] <= L[i + k])) { ok = false; break; }
    fractal[i] = ok ? 1 : 0;
  }

  const base40 = baseWindows(H, L, 0.40), base30 = baseWindows(H, L, 0.30);
  const TR = new Float64Array(n);
  for (let i = 1; i < n; i++) TR[i] = (Math.max(H[i], Cl[i - 1]) - Math.min(L[i], Cl[i - 1])) / Cl[i - 1];
  const PTR = pre(TR);

  const out = new Array(n);
  for (let d = 0; d < n; d++) {
    const c = Cl[d];
    // ① ② 週線剛黃金交叉、月線多頭
    const c1 = isNaN(wk.ma20[d]) ? null : !!(wk.cross[d] && wk.ma5[d] > wk.ma20[d]);
    const c2 = isNaN(mo.ma20[d]) ? null : mo.ma5[d] > mo.ma20[d];
    // ③ 收盤突破前高
    const prior = {}; for (const N of W) prior[N] = PRIOR[N][d];
    const broke = W.filter(N => !isNaN(prior[N]) && c > prior[N]);
    const c3 = isNaN(prior[minN]) ? null : broke.length > 0;
    // ⑥ ⑦ 最近突破事件
    let ev = null;
    for (let j = d; j >= Math.max(0, d - C.BREAKOUT_LOOKBACK + 1); j--) {
      if (!isNaN(brLevel[j])) { const va = avg(PV, j - C.VOL_AVG_DAYS, j - 1); ev = { level: brLevel[j], vr: va ? V[j] / va : null }; break; }
    }
    const c6 = ev ? ev.vr != null && !isNaN(ev.vr) && ev.vr >= C.VOL_LOW : false;
    const ext = ev ? c / ev.level - 1 : null;
    const c7 = ev ? ext >= 0 && ext <= C.CHASE_PCT : false;
    // ④ 前低結構
    let piv = -1, runMax = rangeMax(H, d - K + 1, d);
    for (let i = d - K; i >= Math.max(K, d - C.SWING_LOOKBACK); i--) {
      if (H[i + 1] > runMax) runMax = H[i + 1];
      if (!fractal[i]) continue;
      if (runMax / L[i] - 1 < C.SWING_MIN_REBOUND) continue;
      piv = i; break;
    }
    let failed = false;
    if (piv >= 0) for (let j = piv + 1; j <= d; j++) if (Cl[j] < L[piv]) { failed = true; break; }
    const c4 = piv >= 0 ? !failed : null;
    // ⑤ 52 週位置
    const h52 = H52[d], l52 = L52[d];
    const fH52 = c / h52 - 1, fL52 = c / l52 - 1;
    const c5 = n < C.YEAR_BARS || d + 1 < C.YEAR_BARS ? null : fL52 >= C.LOW_ESCAPE_MIN && fH52 <= C.HIGH_NEAR_MAX;
    const conds = [c1, c2, c3, c4, c5, c6, c7];
    const met = conds.filter(x => x === true).length;
    const grade = met >= C.GRADE_A ? 'A' : met >= C.GRADE_B ? 'B' : '觀察';

    // 新特徵（整理區間、量能、多年新高）
    const e = d - 1;
    const bLen40 = e >= 0 ? base40.len[e] : 0, bHi40 = e >= 0 ? base40.hi[e] : NaN, bLo40 = e >= 0 ? base40.lo[e] : NaN;
    const bLen30 = e >= 0 ? base30.len[e] : 0, bHi30 = e >= 0 ? base30.hi[e] : NaN;
    const hi1y = HI1Y[d], hi2y = HI2Y[d], hi3y = HI3Y[d];
    const m20 = avg(PM, d - 20, d - 1), m250 = avg(PM, d - 250, d - 1);
    out[d] = {
      date: bars[d].date, c1, c2, c3, c4, c5, c6, c7, met, grade,
      env: envMap?.get(bars[d].date) ?? null,
      bLen40, bLen30,
      brk20: c3 === true,
      brkBase40: bLen40 >= 60 && c > bHi40,
      brkBase30: bLen30 >= 60 && c > bHi30,
      newHigh1y: !isNaN(hi1y) && c > hi1y, newHigh2y: !isNaN(hi2y) && c > hi2y, newHigh3y: !isNaN(hi3y) && c > hi3y,
      volContract: d >= 120 ? avg(PTR, d - 19, d) / avg(PTR, d - 119, d) : NaN,
      dryUp: m20 / m250,
      moneyRatio: M[d] / m20,
      fH52, fL52,
      ret60: d >= 60 ? c / Cl[d - 60] - 1 : NaN,
      ret120: d >= 120 ? c / Cl[d - 120] - 1 : NaN,
      baseLow: bLen40 >= 20 ? bLo40 : L20P[d],
    };
  }
  return out;
}

// 結果：隔天開盤進場，停損 = max(整理區間低點, 進場價 × 85%)，追蹤 250 個交易日
// 同一天同時碰到停損與目標 → 保守視為先停損
export const TARGETS = [0.5, 1.0, 2.0];
export function outcomeAt(bars, t, baseLow, horizon = 250, calendarEnd = null) {
  const n = bars.length;
  if (t + 1 >= n) return { status: 'censored' };
  const prevC = bars[t].close, o = bars[t + 1];
  const lim = (o.date < '2015-06-01' ? 0.07 : 0.10) - 0.002;
  if (o.open === o.high && o.high === o.low && o.open / prevC - 1 >= lim) return { status: 'unfilled' };
  const entry = o.open;
  const stop = baseLow < entry ? Math.max(baseLow, entry * 0.85) : entry * 0.85;
  const hit = TARGETS.map(() => null);
  let mfe = 0, exit = null, reason = null, days = 0;
  const end = Math.min(n - 1, t + horizon);
  for (let j = t + 1; j <= end; j++) {
    const b = bars[j]; days = j - t;
    if (j > t + 1 && b.open <= stop) { exit = b.open; reason = 'stop'; break; }
    if (b.low <= stop) { exit = stop; reason = 'stop'; break; }
    const g = b.high / entry - 1;
    if (g > mfe) mfe = g;
    TARGETS.forEach((x, k) => { if (hit[k] == null && g >= x) hit[k] = days; });
  }
  if (!reason) {
    exit = bars[end].close;
    if (end === t + horizon) reason = 'time';
    else if (calendarEnd && bars[n - 1].date < calendarEnd) reason = 'delisted';
    else return { status: 'censored', mfe, hit };
  }
  return { status: 'done', entry, stop, stopPct: stop / entry - 1, exitRet: exit / entry - 1 - 0.006, mfe, hit, reason, days };
}
