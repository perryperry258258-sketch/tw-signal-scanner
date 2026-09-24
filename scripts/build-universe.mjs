// ============================================================
// Phase 2a：建立「每日權值股名單」＋ 資料品質檢查
// 只用已下載的資料，不需要 FinMind 請求
// 權值股定義（當天）：市值排名 ≤ 150 且 20日平均成交值排名 ≤ 300
//   市值 = 當天原始收盤價 × 當天以前最新的發行股數（不使用未來股數）
//   20日均成交值 = 含當天在內的最近 20 個交易日平均（停牌日算 0）
// ============================================================
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const DIR = 'data';
const MCAP_TOP = 150, MONEY_TOP = 300, MONEY_DAYS = 20;

const readCSV = p => {
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  const head = lines.shift().split(',');
  return lines.filter(Boolean).map(l => { const v = l.split(','); const o = {}; head.forEach((h, i) => (o[h] = h === 'date' ? v[i] : Number(v[i]))); return o; });
};

// ---------- 交易日曆（以加權指數為準） ----------
const cal = readCSV(`${DIR}/index/TAIEX.csv`).map(r => r.date);
const D = cal.length;
const dIdx = new Map(cal.map((d, i) => [d, i]));
const { list } = JSON.parse(readFileSync(`${DIR}/meta/stocks.json`, 'utf8'));
const byId = new Map(list.map(s => [s.id, s]));

// ---------- 每檔：市值、成交值、漲跌幅異常 ----------
const S = [];
const limitBreaks = []; // 單日漲跌超過漲跌停限制（可能是減資、分割、資料錯誤）
for (const s of list) {
  const px = readCSV(`${DIR}/prices/${s.id}.csv`);
  if (!px.length) continue;
  const sh = readCSV(`${DIR}/shares/${s.id}.csv`);
  const close = new Float64Array(D).fill(NaN), money = new Float64Array(D), mcap = new Float64Array(D).fill(NaN);
  for (const r of px) { const i = dIdx.get(r.date); if (i != null) { close[i] = r.close; money[i] = r.money; } }
  // 發行股數：只用「當天或之前」最新的一筆
  let k = -1;
  for (let i = 0; i < D; i++) {
    while (k + 1 < sh.length && sh[k + 1].date <= cal[i]) k++;
    if (k >= 0 && close[i] > 0) mcap[i] = close[i] * sh[k].shares;
  }
  // 20日均成交值（含當天，只看過去）
  const m20 = new Float64Array(D);
  let sum = 0;
  for (let i = 0; i < D; i++) { sum += money[i]; if (i >= MONEY_DAYS) sum -= money[i - MONEY_DAYS]; m20[i] = i >= MONEY_DAYS - 1 ? sum / MONEY_DAYS : NaN; }
  // 超過漲跌停的單日變動（前一個有交易的日子 → 當天）
  let prev = null;
  for (const r of px) {
    if (prev) {
      const lim = r.date < '2015-06-01' ? 0.07 : 0.10;
      const chg = r.close / prev.close - 1;
      if (Math.abs(chg) > lim + 0.005) limitBreaks.push({ id: s.id, date: r.date, prev: prev.close, close: r.close, chg: Math.round(chg * 1000) / 10 });
    }
    prev = r;
  }
  S.push({ id: s.id, name: s.name, delisted: s.delisted, hasShares: sh.length > 0, mcap, m20, first: px[0].date, last: px.at(-1).date, rows: px.length });
}

// ---------- 每日排名 → 權值股名單 ----------
const inU = S.map(() => new Uint8Array(D));
const bestMoneyRank = S.map(() => Infinity);
const dailyCount = new Int32Array(D);
for (let i = 0; i < D; i++) {
  const mRank = new Map(), tRank = new Map();
  S.map((s, j) => [j, s.mcap[i]]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).forEach(([j], r) => mRank.set(j, r + 1));
  S.map((s, j) => [j, s.m20[i]]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).forEach(([j], r) => tRank.set(j, r + 1));
  for (const [j, tr] of tRank) if (tr < bestMoneyRank[j]) bestMoneyRank[j] = tr;
  for (const [j, mr] of mRank) {
    if (mr <= MCAP_TOP && (tRank.get(j) ?? Infinity) <= MONEY_TOP) { inU[j][i] = 1; dailyCount[i]++; }
  }
}

// 名單存成「每檔在名單內的日期區間」
const universe = {};
S.forEach((s, j) => {
  const segs = [];
  let start = -1;
  for (let i = 0; i <= D; i++) {
    const on = i < D && inU[j][i];
    if (on && start < 0) start = i;
    if (!on && start >= 0) { segs.push([cal[start], cal[i - 1]]); start = -1; }
  }
  if (segs.length) universe[s.id] = { name: s.name, delisted: s.delisted, days: segs.reduce((a, [x, y]) => a + (dIdx.get(y) - dIdx.get(x) + 1), 0), segs };
});
writeFileSync(`${DIR}/meta/universe.json`, JSON.stringify({ builtAt: new Date().toISOString(), rule: `市值前${MCAP_TOP}且20日均成交值前${MONEY_TOP}`, calendar: [cal[0], cal[D - 1]], stocks: universe }));

// ---------- 報告 ----------
const md = ['# Phase 2a：權值股名單與資料品質', ''];
const uIds = Object.keys(universe);
const uDel = uIds.filter(id => universe[id].delisted);
md.push('## 名單概況', '', '| 項目 | 數值 |', '|---|---|',
  `| 定義 | 市值前 ${MCAP_TOP} 名，且 20 日均成交值前 ${MONEY_TOP} 名（每天重新計算） |`,
  `| 曾經進入名單的股票 | ${uIds.length} 檔 |`,
  `| 其中已下市 | ${uDel.length} 檔${uDel.length ? '：' + uDel.slice(0, 40).map(id => `${id}${universe[id].name}`).join('、') : ''} |`);

md.push('', '## 每年平均名單大小', '', '| 年度 | 平均檔數 | 當年曾入選 |', '|---|---|---|');
const years = [...new Set(cal.map(d => d.slice(0, 4)))];
for (const y of years) {
  const idx = cal.map((d, i) => [d, i]).filter(([d]) => d.startsWith(y)).map(([, i]) => i);
  const avg = Math.round(idx.reduce((a, i) => a + dailyCount[i], 0) / idx.length);
  const ever = S.filter((s, j) => idx.some(i => inU[j][i])).length;
  md.push(`| ${y} | ${avg} | ${ever} |`);
}

md.push('', '## 抽查：各時期市值前 10 名（請確認是否合理）', '');
for (const target of ['2004-12-31', '2008-12-31', '2012-12-31', '2016-12-31', '2020-12-31', '2024-12-31', cal[D - 1]]) {
  let i = D - 1; while (i > 0 && cal[i] > target) i--;
  const top = S.map(s => [s, s.mcap[i]]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 10);
  md.push(`**${cal[i]}**：` + top.map(([s, v]) => `${s.id}${s.name}(${Math.round(v / 1e8).toLocaleString()}億)`).join('、'), '');
}

md.push('## 抽查：已知的大型下市／合併股票', '', '| 代號 | 在清單中 | 股價期間 | 有股數 | 曾入選權值股 |', '|---|---|---|---|---|');
for (const [id, label] of [['2311', '日月光（舊）'], ['2325', '矽品'], ['3474', '華亞科'], ['2448', '晶電'], ['2888', '新光金']]) {
  const s = S.find(x => x.id === id);
  md.push(`| ${id} ${label} | ${byId.has(id) ? '✅' : '❌'} | ${s ? `${s.first}～${s.last}` : '—'} | ${s ? (s.hasShares ? '✅' : '❌') : '—'} | ${universe[id] ? `✅ ${universe[id].days} 天` : '❌'} |`);
}

const noShareLiquid = S.map((s, j) => [s, bestMoneyRank[j]]).filter(([s, r]) => !s.hasShares && r <= MONEY_TOP);
md.push('', '## 沒有發行股數、但成交值曾進前 300 名的股票', '',
  noShareLiquid.length
    ? `共 ${noShareLiquid.length} 檔（這些可能被漏掉，需要補股本資料）：` + noShareLiquid.map(([s, r]) => `${s.id}${s.name}(最佳第${r}名)`).join('、')
    : '無 ✅（沒有股數的股票都是成交量很小的，不影響權值股名單）');

const uBreaks = limitBreaks.filter(b => universe[b.id]);
md.push('', '## 超過漲跌停的單日變動（可能是減資、分割或資料錯誤）', '',
  `全市場 ${limitBreaks.length} 筆，其中曾入選權值股的股票 ${uBreaks.length} 筆。下一階段會逐筆比對除權息、分割、減資資料。`, '');
if (uBreaks.length) {
  md.push('| 代號 | 日期 | 前收 | 收盤 | 漲跌% |', '|---|---|---|---|---|');
  for (const b of uBreaks.slice(0, 40)) md.push(`| ${b.id}${byId.get(b.id)?.name ?? ''} | ${b.date} | ${b.prev} | ${b.close} | ${b.chg} |`);
  if (uBreaks.length > 40) md.push(`| … 另有 ${uBreaks.length - 40} 筆 | | | | |`);
}
writeFileSync(`${DIR}/meta/limit-breaks.json`, JSON.stringify(limitBreaks));

const out = md.join('\n');
console.log(out);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n');
