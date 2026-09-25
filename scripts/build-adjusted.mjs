// ============================================================
// Phase 2c：還原股價（只做曾入選權值股的股票）
// 1. 除權息：因子 = 除權息參考價 ÷ 前一日收盤價
// 2. 分割、變更面額：因子 = 變更後參考價 ÷ 變更前價格
// 3. 仍超過漲跌停的跳空 → 若發行股數同時大幅改變（減資、增資），
//    因子 = 舊股數 ÷ 新股數
// 4. 以上都解釋不了的跳空 → 列為「無法解釋」，回測時避開
// 還原方式：事件日之前的所有價格乘上因子（向後還原），
//          同一段期間內的漲跌比例完全不變，不會產生未來函數
// ============================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';

const DIR = 'data';
mkdirSync(`${DIR}/adjusted`, { recursive: true });
const readJSON = (p, def) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return def; } };
const readCSV = p => {
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  const head = lines.shift().split(',');
  return lines.filter(Boolean).map(l => { const v = l.split(','); const o = {}; head.forEach((h, i) => (o[h] = h === 'date' ? v[i] : Number(v[i]))); return o; });
};
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const r4 = x => Math.round(x * 10000) / 10000;
const limitOf = date => (date < '2015-06-01' ? 0.07 : 0.10) + 0.005;

const universe = readJSON(`${DIR}/meta/universe.json`, { stocks: {} }).stocks;
const ids = Object.keys(universe).sort();

// 分割、變更面額：欄位名稱不固定，自動找「變更前」與「變更後」價格
const corpRows = [...readJSON(`${DIR}/meta/splits.json`, []).map(r => ({ ...r, _t: '分割' })), ...readJSON(`${DIR}/meta/parvalue.json`, []).map(r => ({ ...r, _t: '變更面額' }))];
const pickNum = (r, re) => { const k = Object.keys(r).find(k => re.test(k) && typeof r[k] === 'number' && r[k] > 0); return k ? r[k] : null; };
const corpByStock = {};
let corpSkipped = 0;
for (const r of corpRows) {
  const before = pickNum(r, /before/i), after = pickNum(r, /after.*(ref|price|close)|after/i);
  if (!before || !after || !r.stock_id || !r.date) { corpSkipped++; continue; }
  (corpByStock[r.stock_id] ??= []).push({ date: r.date, f: after / before, type: r._t });
}

const stats = { stocks: 0, divEvents: 0, divMismatch: 0, corpEvents: 0, shareEvents: 0, rawBreaks: 0, afterDiv: 0, afterShares: 0 };
const unexplained = [], allEvents = {};
const samples = {};

function applyEvents(px, events) {
  const ev = [...events].sort((a, b) => a.date.localeCompare(b.date));
  const out = new Array(px.length);
  let cum = 1, e = ev.length - 1;
  for (let i = px.length - 1; i >= 0; i--) {
    out[i] = cum;
    // 事件日 > 前一天日期 且 ≤ 這一天日期 → 前一天起要乘上因子
    while (e >= 0 && i > 0 && ev[e].date > px[i - 1].date && ev[e].date <= px[i].date) { cum *= ev[e].f; e--; }
    while (e >= 0 && i === 0 && ev[e].date > px[0].date) e--;
  }
  return out;
}
function breaks(px, fac) {
  const res = [];
  for (let i = 1; i < px.length; i++) {
    const chg = (px[i].close * fac[i]) / (px[i - 1].close * fac[i - 1]) - 1;
    if (Math.abs(chg) > limitOf(px[i].date)) res.push({ i, chg });
  }
  return res;
}

for (const id of ids) {
  const px = readCSV(`${DIR}/prices/${id}.csv`);
  if (px.length < 2) continue;
  stats.stocks++;
  const pIdx = new Map(px.map((r, i) => [r.date, i]));
  const events = [];

  // 1. 除權息
  for (const r of readJSON(`${DIR}/dividends/${id}.json`, [])) {
    const before = r.before_price, after = r.after_price || r.reference_price;
    if (!(before > 0) || !(after > 0) || Math.abs(after / before - 1) < 1e-9) continue;
    events.push({ date: r.date, f: after / before, type: '除權息' });
    stats.divEvents++;
    // 檢查：除權息前價格應等於事件日前一個交易日的收盤價
    let j = pIdx.get(r.date);
    if (j == null) j = px.findIndex(x => x.date > r.date);
    const prev = j > 0 ? px[j - 1] : null;
    if (prev && Math.abs(before / prev.close - 1) > 0.01) stats.divMismatch++;
  }
  // 2. 分割、變更面額
  for (const c of corpByStock[id] || []) { events.push(c); stats.corpEvents++; }

  stats.rawBreaks += breaks(px, px.map(() => 1)).length;
  let fac = applyEvents(px, events);
  let br = breaks(px, fac);
  stats.afterDiv += br.length;

  // 3. 發行股數大幅改變的跳空（減資、增資）
  const sh = readCSV(`${DIR}/shares/${id}.csv`);
  const sharesAt = d => { let v = null; for (const x of sh) { if (x.date <= d) v = x.shares; else break; } return v; };
  if (sh.length) {
    for (const b of br) {
      const oldS = sharesAt(addDays(px[b.i - 1].date, -60)), newS = sharesAt(addDays(px[b.i].date, 60));
      if (!oldS || !newS) continue;
      const rs = newS / oldS;
      if (Math.abs(rs - 1) > 0.05 && Math.abs((1 + b.chg) * rs - 1) < 0.10) {
        events.push({ date: px[b.i].date, f: 1 / rs, type: rs < 1 ? '減資' : '增資' });
        stats.shareEvents++;
      }
    }
    fac = applyEvents(px, events);
    br = breaks(px, fac);
  }
  stats.afterShares += br.length;
  for (const b of br) unexplained.push({ id, name: universe[id].name, date: px[b.i].date, prev: px[b.i - 1].close, close: px[b.i].close, chg: Math.round(b.chg * 1000) / 10 });

  allEvents[id] = events.map(e => ({ ...e, f: r4(e.f) }));
  const lines = ['date,open,high,low,close,volume,money,rawClose,factor',
    ...px.map((r, i) => `${r.date},${r4(r.open * fac[i])},${r4(r.high * fac[i])},${r4(r.low * fac[i])},${r4(r.close * fac[i])},${r.volume},${r.money},${r.close},${r4(fac[i])}`)];
  writeFileSync(`${DIR}/adjusted/${id}.csv`, lines.join('\n') + '\n');
  if (['2330', '1227', '2317'].includes(id)) samples[id] = { first: px[0], firstFac: fac[0], events: events.length, px, fac };
}

writeFileSync(`${DIR}/meta/adjust-events.json`, JSON.stringify(allEvents));
writeFileSync(`${DIR}/meta/unexplained-gaps.json`, JSON.stringify(unexplained));

// ---------- 報告 ----------
const md = ['# Phase 2c：還原股價', '',
  '## 處理結果', '', '| 項目 | 數值 |', '|---|---|',
  `| 處理股票數 | ${stats.stocks} |`,
  `| 除權息事件 | ${stats.divEvents} 筆（除權息前價格與前一日收盤差距 >1%：${stats.divMismatch} 筆） |`,
  `| 分割／變更面額事件 | ${stats.corpEvents} 筆（欄位無法辨識而略過：${corpSkipped} 筆） |`,
  `| 以發行股數辨識的減資／增資 | ${stats.shareEvents} 筆 |`,
  '', '## 超過漲跌停的跳空：逐步減少情形', '', '| 階段 | 筆數 |', '|---|---|',
  `| 原始股價 | ${stats.rawBreaks} |`,
  `| 加入除權息、分割、變更面額後 | ${stats.afterDiv} |`,
  `| 再加入減資／增資後（無法解釋） | ${stats.afterShares} |`];

if (unexplained.length) {
  md.push('', `## 無法解釋的跳空（共 ${unexplained.length} 筆，回測時會避開這些日期前後的訊號）`, '', '| 股票 | 日期 | 前收 | 收盤 | 漲跌% |', '|---|---|---|---|---|',
    ...unexplained.slice(0, 50).map(u => `| ${u.id}${u.name} | ${u.date} | ${u.prev} | ${u.close} | ${u.chg} |`));
  if (unexplained.length > 50) md.push(`| … 另有 ${unexplained.length - 50} 筆 | | | | |`);
}

md.push('', '## 抽查', '');
for (const [id, s] of Object.entries(samples)) {
  md.push(`**${id} ${universe[id].name}**：事件 ${s.events} 筆；${s.first.date} 原始收盤 ${s.first.close} → 還原後 ${r4(s.first.close * s.firstFac)}（因子 ${r4(s.firstFac)}）`);
  if (id === '1227') {
    const i = s.px.findIndex(x => x.date === '2012-07-17');
    if (i > 0) md.push(`　2012-07-17 除權日：原始 ${Math.round((s.px[i].close / s.px[i - 1].close - 1) * 1000) / 10}% → 還原後 ${Math.round((s.px[i].close * s.fac[i] / (s.px[i - 1].close * s.fac[i - 1]) - 1) * 1000) / 10}%`);
  }
  md.push('');
}

const out = md.join('\n');
console.log(out);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n');
