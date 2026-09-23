import { evaluateStock, evaluateMarket, sliceTo, CSV_COLUMNS } from './engine.js';

// ============================================================
// 回測管線
// 規則：先用 bars[0..i] 算出「當天訊號」，
//       再「另外」用 bars[i+1..] 算未來績效欄位。
//       未來欄位只附加在結果上，從不回傳給訊號計算。
// ============================================================

export const HORIZONS = [5, 10, 20, 40, 60];
const GRADE_RANK = { '觀察': 0, B: 1, A: 2 };
const r2 = x => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);

// 還原權息價的「當日基準化」：把 bars[0..d] 整段乘上同一個係數，讓當天價格 = 當天真實收盤價
// 目的：前低、停損價等「價格位置」與當時看到的一致，不含之後才發生的除權息調整
// 所有條件都是比例/比大小，乘同一個係數不會改變任何條件結果（Look-ahead 檢查會驗證）
export function rebase(slice) {
  const last = slice[slice.length - 1];
  const k = last.rawClose / last.close;
  if (!isFinite(k) || Math.abs(k - 1) < 1e-12) return slice;
  return slice.map(b => ({ ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k }));
}

// 當天訊號：只用 bars[0..i]
export function signalAt(bars, i) {
  return evaluateStock(rebase(bars.slice(0, i + 1)));
}

// 未來績效：只用 bars[i+1..i+N]，以 i 當天收盤為基準（還原權息價，含股利）
export function forwardAt(bars, i) {
  const out = {};
  const base = bars[i].close;
  for (const N of HORIZONS) {
    if (i + N >= bars.length) { out[`mfe${N}`] = null; out[`mae${N}`] = null; out[`ret${N}`] = null; continue; }
    let hi = -Infinity, lo = Infinity;
    for (let j = i + 1; j <= i + N; j++) {
      if (bars[j].high > hi) hi = bars[j].high;
      if (bars[j].low < lo) lo = bars[j].low;
    }
    out[`mfe${N}`] = r2((hi / base - 1) * 100);             // 未來N日最高漲幅 %
    out[`mae${N}`] = r2((lo / base - 1) * 100);             // 未來N日最低跌幅 %
    out[`ret${N}`] = r2((bars[i + N].close / base - 1) * 100); // 第N日收盤報酬 %
  }
  return out;
}

export function etfEnvLabel(score) {
  if (score == null) return '資料不足';
  return score === 3 ? '多方' : score === 0 ? '空方' : '震盪';
}

// 預先算好每一天的市場環境（每天只用當天以前的指數資料）
export function buildMarketMap(twiiBars, etfBars, fromDate) {
  const map = new Map();
  if (!etfBars) return map;
  for (const b of etfBars) {
    if (b.date < fromDate) continue;
    const env = evaluateMarket(twiiBars && sliceTo(twiiBars, b.date), sliceTo(etfBars, b.date));
    map.set(b.date, { marketEnv: env.label, marketScore: env.score, etf0050Env: etfEnvLabel(env.ETF0050?.score ?? null) });
  }
  return map;
}

function marketFor(map, date) {
  if (map.has(date)) return map.get(date);
  let best = null; // 若該日 0050 沒資料，取之前最近一天
  for (const [d, v] of map) { if (d <= date) best = v; else break; }
  return best || { marketEnv: '資料不足', marketScore: null, etf0050Env: '資料不足' };
}

// 單一股票逐日回測
export function runSymbol({ symbol, name, bars, marketMap, from, to }) {
  const rows = [];
  let prevGrade = null;
  for (let i = 0; i < bars.length; i++) {
    const date = bars[i].date;
    if (date > to) break;
    if (i < 60) continue;
    const inRange = date >= from;
    const nextInRange = i + 1 < bars.length && bars[i + 1].date >= from;
    if (!inRange && !nextInRange) continue; // 只多算起始日前一天，用來判斷「新訊號」
    const sig = signalAt(bars, i);
    if (!inRange) { prevGrade = sig.grade; continue; }
    const isNewSignal = sig.grade !== '觀察' && (prevGrade == null || GRADE_RANK[sig.grade] > GRADE_RANK[prevGrade]);
    prevGrade = sig.grade;
    const fwd = forwardAt(bars, i); // ← 訊號已經算完才計算未來欄位
    rows.push({
      symbol, name, signalDate: date, signalPrice: sig.rawClose, isNewSignal,
      ...marketFor(marketMap, date), ...sig, ...fwd,
    });
  }
  return rows;
}

export const FWD_COLUMNS = HORIZONS.flatMap(N => [`mfe${N}`, `mae${N}`, `ret${N}`]);
export const BACKTEST_COLUMNS = [
  'signalDate', 'signalPrice', 'isNewSignal', 'etf0050Env',
  ...CSV_COLUMNS, ...FWD_COLUMNS,
];

export function toCSVCols(rows, cols) {
  const esc = v => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\uFEFF' + [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}
