import { CONFIG as C } from './config.js';

// ============================================================
// 防未來函數的核心原則：
// evaluateStock(bars) 只看傳進來的 bars，最後一根 = 「當天」。
// 回測時對每一天都用 bars.slice(0, i+1) 重算，所以任何一天
// 在結構上都不可能看到之後的資料。
// ============================================================

const r2 = x => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const pct = x => (x == null || !isFinite(x) ? null : Math.round(x * 10000) / 100); // 0.0523 → 5.23

function maxRange(a, from, to) {
  if (from < 0 || to < from) return null;
  let m = -Infinity;
  for (let i = from; i <= to; i++) if (a[i] > m) m = a[i];
  return m;
}
function minRange(a, from, to) {
  if (from < 0 || to < from) return null;
  let m = Infinity;
  for (let i = from; i <= to; i++) if (a[i] < m) m = a[i];
  return m;
}
function avgRange(a, from, to) {
  if (from < 0 || to < from) return null;
  let s = 0;
  for (let i = from; i <= to; i++) s += a[i];
  return s / (to - from + 1);
}
function smaAt(a, end, n) {
  if (end + 1 < n) return null;
  return avgRange(a, end - n + 1, end);
}

export function sliceTo(bars, date) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return bars.slice(0, ans + 1);
}

// ---------- 週 / 月 K 重組 ----------
function weekKey(s) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // 該週週一
  return d.toISOString().slice(0, 10);
}
const monthKey = s => s.slice(0, 7);

function resample(bars, keyFn) {
  const out = [];
  for (const b of bars) {
    const k = keyFn(b.date);
    const last = out[out.length - 1];
    if (last && last.key === k) { last.close = b.close; last.lastDate = b.date; }
    else out.push({ key: k, close: b.close, lastDate: b.date });
  }
  return out;
}

// 只用「當天以前」就能判斷的完成條件：週五 = 週K完成；該月之後已無平日 = 月K完成
function periodComplete(asOf, type) {
  const d = new Date(asOf + 'T00:00:00Z');
  if (type === 'W') return d.getUTCDay() === 5;
  const t = new Date(d);
  for (;;) {
    t.setUTCDate(t.getUTCDate() + 1);
    if (t.getUTCMonth() !== d.getUTCMonth()) return true;
    const w = t.getUTCDay();
    if (w >= 1 && w <= 5) return false;
  }
}

function maSeries(bars, keyFn, type) {
  let g = resample(bars, keyFn);
  if (C.MA_MODE === 'confirmed' && !periodComplete(bars[bars.length - 1].date, type)) g = g.slice(0, -1);
  const closes = g.map(x => x.close);
  return {
    g,
    ma5: closes.map((_, i) => smaAt(closes, i, 5)),
    ma20: closes.map((_, i) => smaAt(closes, i, 20)),
  };
}

// 找最近一次交叉；withinBars = null 代表不限範圍
function lastCross(s, dir, withinBars) {
  const L = s.g.length;
  const stop = withinBars ? Math.max(1, L - withinBars) : 1;
  for (let i = L - 1; i >= stop; i--) {
    if (s.ma20[i] == null || s.ma20[i - 1] == null) break;
    const a = s.ma5[i] - s.ma20[i], b = s.ma5[i - 1] - s.ma20[i - 1];
    if (dir === 'up' ? a > 0 && b <= 0 : a < 0 && b >= 0) {
      return { date: s.g[i].lastDate, barsAgo: L - 1 - i };
    }
  }
  return null;
}

function volLabel(r) {
  if (r == null) return null;
  if (r < C.VOL_LOW) return '無量突破';
  if (r >= C.VOL_HIGH) return '放量突破';
  return '正常量';
}

// ============================================================
// 市場環境
// ============================================================
function marketOne(bars) {
  if (!bars || bars.length < 30) return null;
  const close = bars[bars.length - 1].close;
  const wk = maSeries(bars, weekKey, 'W'), mo = maSeries(bars, monthKey, 'M');
  const w5 = wk.ma5.at(-1), w20 = wk.ma20.at(-1), m5 = mo.ma5.at(-1), m20 = mo.ma20.at(-1);
  if (w20 == null || m20 == null) return { date: bars.at(-1).date, score: null };
  const score = (w5 > w20 ? 1 : 0) + (close > w20 ? 1 : 0) + (m5 > m20 ? 1 : 0);
  return { date: bars.at(-1).date, close: r2(close), wMA5: r2(w5), wMA20: r2(w20), mMA5: r2(m5), mMA20: r2(m20), score };
}

// 加權指數 + 0050 各 3 分（週5>週20、收盤>週20、月5>月20），合計 0~6
export function evaluateMarket(twiiBars, etfBars) {
  const a = marketOne(twiiBars), b = marketOne(etfBars);
  if (a?.score == null || b?.score == null) return { label: '資料不足', score: null, TWII: a, ETF0050: b };
  const score = a.score + b.score;
  const label = score >= 5 ? '多方' : score <= 1 ? '空方' : '震盪';
  return { label, score, TWII: a, ETF0050: b };
}

// ============================================================
// 個股評估（只看 bars，最後一根 = 當天）
// ============================================================
export function evaluateStock(bars) {
  const n = bars.length, d = n - 1, t = bars[d];
  const H = bars.map(b => b.high), Lo = bars.map(b => b.low), Cl = bars.map(b => b.close), V = bars.map(b => b.volume || 0);
  const why = [];

  // ① 週線剛黃金交叉
  const wk = maSeries(bars, weekKey, 'W');
  const w5 = wk.ma5.at(-1), w20 = wk.ma20.at(-1);
  const wCross = w20 != null ? lastCross(wk, 'up', C.WEEKLY_CROSS_WITHIN) : null;
  const c1 = w20 == null ? null : !!(wCross && w5 > w20);
  why.push(c1 == null ? '①資料不足' : c1
    ? `①週線黃金交叉（${wCross.date}，${wCross.barsAgo === 0 ? '本週' : wCross.barsAgo + '週前'}）`
    : `①✗週線${w5 > w20 ? '多頭但非近' + C.WEEKLY_CROSS_WITHIN + '週交叉' : '5MA<20MA'}`);

  // ② 月線沒有死亡交叉
  const mo = maSeries(bars, monthKey, 'M');
  const m5 = mo.ma5.at(-1), m20 = mo.ma20.at(-1);
  const mDeath = m20 != null ? lastCross(mo, 'down', null) : null;
  const c2 = m20 == null ? null : m5 > m20;
  why.push(c2 == null ? '②資料不足' : c2 ? '②月線5MA>20MA' : `②✗月線5MA<20MA${mDeath ? '（死叉 ' + mDeath.date + '）' : ''}`);

  // ③ 收盤突破前高（前高 = 前 N 日最高價，不含今日）
  const W = C.BREAKOUT_WINDOWS, minN = Math.min(...W);
  const prior = {};
  for (const N of W) prior[N] = maxRange(H, d - N, d - 1);
  const broke = W.filter(N => prior[N] != null && t.close > prior[N]);
  const c3 = prior[minN] == null ? null : broke.length > 0;
  const breakoutType = broke.length ? `收盤突破${Math.max(...broke)}日高` : '未突破';
  why.push(c3 == null ? '③資料不足' : c3 ? `③${breakoutType}` : '③✗收盤未突破20日高');

  // 最近一次突破事件（含今日往回 BREAKOUT_LOOKBACK 天）
  let ev = null;
  for (let j = d; j >= Math.max(0, d - C.BREAKOUT_LOOKBACK + 1) && !ev; j--) {
    let level = null, win = null;
    for (const N of W) {
      const p = maxRange(H, j - N, j - 1);
      if (p != null && Cl[j] > p) { level = p; win = N; } // 取突破的最大天數那條
    }
    if (level != null) {
      const va = avgRange(V, j - C.VOL_AVG_DAYS, j - 1);
      ev = { date: bars[j].date, level, window: win, volRatio: va ? V[j] / va : null, daysAgo: d - j };
    }
  }

  // ④ 前低結構（左右各 K 根確認 → 低點要到 K 天後才「已知」）
  const K = C.SWING_K;
  let piv = null;
  for (let i = d - K; i >= Math.max(K, d - C.SWING_LOOKBACK) && !piv; i--) {
    let ok = true;
    for (let k = 1; k <= K; k++) if (!(Lo[i] < Lo[i - k] && Lo[i] <= Lo[i + k])) { ok = false; break; }
    if (!ok) continue;
    if (maxRange(H, i + 1, d) / Lo[i] - 1 < C.SWING_MIN_REBOUND) continue;
    piv = { date: bars[i].date, index: i, price: Lo[i] };
  }
  let failDate = null;
  if (piv) for (let j = piv.index + 1; j <= d; j++) if (Cl[j] < piv.price) { failDate = bars[j].date; break; }
  const c4 = piv ? !failDate : null;
  const stopRef = piv ? piv.price * (1 - C.STOP_BUFFER) : null;
  why.push(c4 == null ? '④找不到明確波段低點' : c4
    ? `④前低 ${r2(piv.price)}（${piv.date}）未跌破`
    : `④✗結構失效：${failDate} 收盤跌破前低 ${r2(piv.price)}`);

  // ⑤ 價格位置
  const yb = Math.min(C.YEAR_BARS, n);
  const h52 = maxRange(H, d - yb + 1, d), l52 = minRange(Lo, d - yb + 1, d);
  const fH52 = t.close / h52 - 1, fL52 = t.close / l52 - 1;
  const h20 = maxRange(H, Math.max(0, d - 19), d), h60 = maxRange(H, Math.max(0, d - 59), d);
  const c5 = n < C.YEAR_BARS ? null : fL52 >= C.LOW_ESCAPE_MIN && fH52 <= C.HIGH_NEAR_MAX;
  const positionTag = c5 == null ? '資料不足' : c5 ? '脫離低點但尚未接近52週高點'
    : fH52 > C.HIGH_NEAR_MAX ? '接近52週高點' : '仍在52週低點區';
  why.push(c5 ? `⑤${positionTag}` : `⑤✗${positionTag}`);

  // ⑥ 成交量（均量不含今日）
  const va20 = avgRange(V, d - C.VOL_AVG_DAYS, d - 1);
  const volRatio = va20 ? V[d] / va20 : null;
  const evVolLabel = ev ? volLabel(ev.volRatio) : '無突破';
  const c6 = ev ? ev.volRatio != null && ev.volRatio >= C.VOL_LOW : false;
  why.push(c6 ? `⑥突破日${evVolLabel}（${r2(ev.volRatio)}倍）` : `⑥✗${ev ? evVolLabel : '近' + C.BREAKOUT_LOOKBACK + '日無突破'}`);

  // ⑦ 突破幅度
  const ext = ev ? t.close / ev.level - 1 : null;
  const chaseFlag = ext == null ? null : ext > C.CHASE_PCT ? '可能追高' : ext < 0 ? '跌回突破價之下' : '正常';
  const c7 = ev ? ext >= 0 && ext <= C.CHASE_PCT : false;
  why.push(c7 ? `⑦距突破價 +${pct(ext)}%` : `⑦✗${ev ? chaseFlag + '（' + pct(ext) + '%）' : '無突破'}`);

  const conds = [c1, c2, c3, c4, c5, c6, c7];
  const met = conds.filter(x => x === true).length;
  const grade = met >= C.GRADE_A ? 'A' : met >= C.GRADE_B ? 'B' : '觀察';

  return {
    date: t.date,
    close: r2(t.close), rawClose: r2(t.rawClose),
    wMA5: r2(w5), wMA20: r2(w20), mMA5: r2(m5), mMA20: r2(m20),
    weeklyCrossDate: wCross?.date ?? null,
    monthlyDeathCrossDate: mDeath?.date ?? null,
    prior20H: r2(prior[20]), prior40H: r2(prior[40]), prior60H: r2(prior[60]),
    breakoutType,
    breakoutDate: ev?.date ?? null,
    breakoutPrice: r2(ev?.level),
    breakoutExtPct: pct(ext),
    chaseFlag,
    volume: Math.round(V[d]), volAvg20: Math.round(va20 || 0), volRatio: r2(volRatio),
    breakoutVolRatio: r2(ev?.volRatio), breakoutVolLabel: evVolLabel,
    swingLowDate: piv?.date ?? null, swingLow: r2(piv?.price),
    distToSwingLowPct: piv ? pct(t.close / piv.price - 1) : null,
    structureFailed: piv ? !!failDate : null, structureFailDate: failDate,
    stopRef: r2(stopRef),
    high52: r2(h52), low52: r2(l52), fromHigh52Pct: pct(fH52), fromLow52Pct: pct(fL52),
    fromHigh20Pct: pct(t.close / h20 - 1), fromHigh60Pct: pct(t.close / h60 - 1),
    positionTag,
    c1, c2, c3, c4, c5, c6, c7,
    conditionsMet: met, grade,
    reasons: why.join('；'),
    maMode: C.MA_MODE, adjusted: C.ADJUSTED,
  };
}

// ============================================================
// CSV
// ============================================================
export const CSV_COLUMNS = [
  'symbol', 'name', 'date', 'marketEnv', 'marketScore', 'grade', 'conditionsMet',
  'close', 'rawClose', 'wMA5', 'wMA20', 'mMA5', 'mMA20', 'weeklyCrossDate', 'monthlyDeathCrossDate',
  'prior20H', 'prior40H', 'prior60H', 'breakoutType', 'breakoutDate', 'breakoutPrice', 'breakoutExtPct', 'chaseFlag',
  'volume', 'volAvg20', 'volRatio', 'breakoutVolRatio', 'breakoutVolLabel',
  'swingLowDate', 'swingLow', 'distToSwingLowPct', 'structureFailed', 'structureFailDate', 'stopRef',
  'high52', 'low52', 'fromHigh52Pct', 'fromLow52Pct', 'fromHigh20Pct', 'fromHigh60Pct', 'positionTag',
  'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'reasons', 'maMode', 'adjusted',
];

export function toCSV(rows) {
  const esc = v => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\uFEFF' + [CSV_COLUMNS.join(','), ...rows.map(r => CSV_COLUMNS.map(c => esc(r[c])).join(','))].join('\n');
}
