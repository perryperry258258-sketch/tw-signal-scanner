import { CONFIG as C } from './config.js';
import { evaluateStock } from './engine.js';
import { signalAt, forwardAt, rebase } from './backtest.js';

// ============================================================
// Look-ahead Bias Check
// 每個測試回傳 { id, name, pass, checked, failures[] }
// ============================================================

const TOL = 0.011; // 兩位小數四捨五入容許誤差
const eq = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= TOL);
const r2 = x => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);

// 選測試日：平均分散 + 最後一天
export function pickTestIndices(bars, count = 10) {
  const lo = Math.max(C.YEAR_BARS + 5, Math.floor(bars.length * 0.4));
  const hi = bars.length - 61; // 保留 60 天未來資料，擾動測試才有意義
  const out = [];
  if (hi > lo) for (let k = 0; k < count; k++) out.push(Math.round(lo + ((hi - lo) * k) / (count - 1)));
  return out;
}

// 把 i 之後的資料全部亂改（價格、成交量都大幅變動）
function perturbAfter(bars, i) {
  return bars.map((b, j) => {
    if (j <= i) return b;
    const f = 1 + 0.5 * Math.sin(j * 1.7);
    return { ...b, open: b.open * f, high: b.high * f * 1.3, low: b.low * f * 0.6, close: b.close * f, rawClose: b.rawClose * f, volume: b.volume * 7 + 12345 };
  });
}

// ---------- 獨立重算（刻意用不同寫法，避免跟引擎犯同一個錯） ----------
const dayNum = s => Math.floor(Date.parse(s + 'T00:00:00Z') / 86400000);
const weekIdx = s => Math.floor((dayNum(s) + 3) / 7); // 1970-01-01 是週四 → 週一起算的週序號

function naivePeriodMA(bars, keyFn) {
  const closes = [];
  let lastKey = null;
  for (const b of bars) {
    const k = keyFn(b.date);
    if (k === lastKey) closes[closes.length - 1] = b.close; else { closes.push(b.close); lastKey = k; }
  }
  const ma = n => (closes.length >= n ? closes.slice(-n).reduce((s, x) => s + x, 0) / n : null);
  return { ma5: ma(5), ma20: ma(20) };
}

const naiveMax = (arr) => arr.reduce((m, x) => (x > m ? x : m), -Infinity);
const naiveMin = (arr) => arr.reduce((m, x) => (x < m ? x : m), Infinity);

export function runChecks(symbol, bars) {
  const idx = pickTestIndices(bars);
  const T = {
    perturb: { id: 'T1', name: '訊號不受未來資料影響（把當天之後的資料全部亂改，當天訊號必須完全相同）', checked: 0, failures: [] },
    ma: { id: 'T2', name: 'MA 計算只用當天以前資料（週/月 5MA、20MA 獨立重算比對）', checked: 0, failures: [] },
    highs: { id: 'T3', name: '前高只用前 N 日（不含當天、不含未來）', checked: 0, failures: [] },
    lows: { id: 'T4', name: '前低需在當天以前被確認（右側 K 根也在當天以前）', checked: 0, failures: [] },
    y52: { id: 'T5', name: '52週高低點只用當天以前 250 日', checked: 0, failures: [] },
    vol: { id: 'T6', name: '20日均量只用當天以前 20 日', checked: 0, failures: [] },
    grade: { id: 'T7', name: '訊號等級只由當天及以前的條件決定', checked: 0, failures: [] },
    fwd: { id: 'T8', name: '未來績效欄位只來自未來資料，且與訊號計算分離', checked: 0, failures: [] },
    rebase: { id: 'T9', name: '還原權息基準化不改變任何條件結果', checked: 0, failures: [] },
  };
  const fail = (t, date, msg) => t.failures.length < 5 && t.failures.push(`${symbol} ${date}：${msg}`);

  for (const i of idx) {
    const date = bars[i].date;
    const sig = signalAt(bars, i);
    const view = rebase(bars.slice(0, i + 1)); // 當天看到的資料
    const d = view.length - 1;

    // T1 擾動未來
    const sig2 = signalAt(perturbAfter(bars, i), i);
    T.perturb.checked++;
    for (const k of Object.keys(sig)) {
      if (JSON.stringify(sig[k]) !== JSON.stringify(sig2[k])) { fail(T.perturb, date, `欄位 ${k} 改變`); break; }
    }

    // T2 MA
    if (C.MA_MODE === 'live') {
      const w = naivePeriodMA(view, weekIdx), m = naivePeriodMA(view, s => s.slice(0, 7));
      T.ma.checked++;
      if (!eq(r2(w.ma5), sig.wMA5) || !eq(r2(w.ma20), sig.wMA20)) fail(T.ma, date, `週MA 引擎 ${sig.wMA5}/${sig.wMA20} vs 重算 ${r2(w.ma5)}/${r2(w.ma20)}`);
      if (!eq(r2(m.ma5), sig.mMA5) || !eq(r2(m.ma20), sig.mMA20)) fail(T.ma, date, `月MA 引擎 ${sig.mMA5}/${sig.mMA20} vs 重算 ${r2(m.ma5)}/${r2(m.ma20)}`);
    }

    // T3 前高
    T.highs.checked++;
    for (const N of [20, 40, 60]) {
      const ref = r2(naiveMax(view.slice(d - N, d).map(b => b.high)));
      if (!eq(ref, sig[`prior${N}H`])) fail(T.highs, date, `${N}日前高 引擎 ${sig[`prior${N}H`]} vs 重算 ${ref}`);
    }
    if (sig.breakoutDate && sig.breakoutDate > date) fail(T.highs, date, `突破日期 ${sig.breakoutDate} 在未來`);

    // T4 前低
    T.lows.checked++;
    if (sig.swingLowDate) {
      const j = view.findIndex(b => b.date === sig.swingLowDate);
      if (j < 0) fail(T.lows, date, `前低日期 ${sig.swingLowDate} 不在當天以前的資料中`);
      else if (j > d - C.SWING_K) fail(T.lows, date, `前低 ${sig.swingLowDate} 尚未被右側 ${C.SWING_K} 根確認`);
      else {
        const L = view[j].low;
        const left = view.slice(j - C.SWING_K, j).map(b => b.low), right = view.slice(j + 1, j + 1 + C.SWING_K).map(b => b.low);
        if (!(L < naiveMin(left) && L <= naiveMin(right))) fail(T.lows, date, `前低 ${sig.swingLowDate} 不是有效波段低點`);
        if (!eq(r2(L), sig.swingLow)) fail(T.lows, date, `前低價 引擎 ${sig.swingLow} vs 重算 ${r2(L)}`);
        const broke = view.slice(j + 1).some(b => b.close < L);
        if (broke !== sig.structureFailed) fail(T.lows, date, `結構失效判斷不一致`);
      }
    }
    if (sig.structureFailDate && sig.structureFailDate > date) fail(T.lows, date, `結構失效日期在未來`);

    // T5 52週
    T.y52.checked++;
    const win = view.slice(Math.max(0, d - C.YEAR_BARS + 1));
    const h52 = r2(naiveMax(win.map(b => b.high))), l52 = r2(naiveMin(win.map(b => b.low)));
    if (!eq(h52, sig.high52) || !eq(l52, sig.low52)) fail(T.y52, date, `52週 引擎 ${sig.high52}/${sig.low52} vs 重算 ${h52}/${l52}`);

    // T6 均量
    T.vol.checked++;
    const va = Math.round(view.slice(d - C.VOL_AVG_DAYS, d).reduce((s, b) => s + b.volume, 0) / C.VOL_AVG_DAYS);
    if (Math.abs(va - sig.volAvg20) > 1) fail(T.vol, date, `均量 引擎 ${sig.volAvg20} vs 重算 ${va}`);

    // T7 等級
    T.grade.checked++;
    const met = [sig.c1, sig.c2, sig.c3, sig.c4, sig.c5, sig.c6, sig.c7].filter(x => x === true).length;
    const g = met >= C.GRADE_A ? 'A' : met >= C.GRADE_B ? 'B' : '觀察';
    if (met !== sig.conditionsMet || g !== sig.grade) fail(T.grade, date, `等級重算不一致`);
    if (sig.grade !== sig2.grade) fail(T.grade, date, `未來資料改變後等級改變`);

    // T8 未來欄位
    T.fwd.checked++;
    const f1 = forwardAt(bars, i), f2 = forwardAt(perturbAfter(bars, i), i);
    if (JSON.stringify(f1) === JSON.stringify(f2)) fail(T.fwd, date, `未來欄位沒有隨未來資料變化（計算基準可能錯誤）`);
    if (Object.keys(f1).some(k => k in sig)) fail(T.fwd, date, `未來欄位混進訊號欄位`);
    const hasFwdOnly = evaluateStock(view); // 只給當天以前資料時，引擎輸出不可能有未來欄位
    if (Object.keys(hasFwdOnly).some(k => /^m[fa]e\d+$/.test(k))) fail(T.fwd, date, `引擎輸出含未來欄位`);

    // T9 基準化
    T.rebase.checked++;
    const raw = evaluateStock(bars.slice(0, i + 1));
    for (const k of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'grade', 'breakoutType', 'weeklyCrossDate', 'swingLowDate', 'breakoutDate', 'positionTag']) {
      if (raw[k] !== sig[k]) { fail(T.rebase, date, `欄位 ${k} 因基準化改變`); break; }
    }
  }

  return Object.values(T).map(t => ({ ...t, pass: t.checked > 0 && t.failures.length === 0, skipped: t.checked === 0 }));
}

// 資料來源測試：只抓到當天的資料 vs 抓完整資料再切到當天，訊號必須相同
export function compareSourceTruncation(symbol, date, truncatedBars, fullBars) {
  const i = fullBars.findIndex(b => b.date === date);
  const a = truncatedBars.length ? evaluateStock(rebase(truncatedBars)) : null;
  const b = i >= 0 ? evaluateStock(rebase(fullBars.slice(0, i + 1))) : null;
  if (!a || !b || a.date !== b.date) return { ok: false, msg: `${symbol} ${date}：資料日期對不上` };
  const keys = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'grade', 'breakoutType', 'weeklyCrossDate', 'swingLowDate'];
  const diff = keys.filter(k => a[k] !== b[k]);
  return diff.length ? { ok: false, msg: `${symbol} ${date}：${diff.join(',')} 不同` } : { ok: true };
}
