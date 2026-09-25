// ============================================================
// Phase 2a / 2c：建立「每日權值股名單」＋ 資料品質檢查
// 只用已下載的資料，不需要 FinMind 請求
// 權值股定義（當天）：市值排名 ≤ 150 且 20日平均成交值排名 ≤ 300
//   市值 = 當天原始收盤價 × 當天「已知」的發行股數
//     發行股數來源 1：外資持股表（每日）
//     發行股數來源 2（補缺）：資產負債表股本 ÷ 10，只在季底 + 90 天後才視為已知
//   兩個來源都沒有的股票：以「20日均成交值前 150 名」代替（標記為替代規則）
//   20日均成交值 = 含當天在內的最近 20 個交易日平均（停牌日算 0）
// ============================================================
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const DIR = 'data';
const MCAP_TOP = 150, MONEY_TOP = 300, PROXY_MONEY_TOP = 150, MONEY_DAYS = 20;
const BAL_LAG_DAYS = 90;

const readJSON = (p, def) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return def; } };
const readCSV = p => {
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  const head = lines.shift().split(',');
  return lines.filter(Boolean).map(l => { const v = l.split(','); const o = {}; head.forEach((h, i) => (o[h] = h === 'date' ? v[i] : Number(v[i]))); return o; });
};
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---------- 交易日曆（以加權指數為準） ----------
const cal = readCSV(`${DIR}/index/TAIEX.csv`).map(r => r.date);
const D = cal.length;
const dIdx = new Map(cal.map((d, i) => [d, i]));
const { list } = readJSON(`${DIR}/meta/stocks.json`, { list: [] });
const byId = new Map(list.map(s => [s.id, s]));
const oldUniverse = readJSON(`${DIR}/meta/universe.json`, { stocks: {} }).stocks;

// ---------- 資產負債表股本：用校正組自動選欄位 ----------
const extra = readJSON(`${DIR}/extra-status.json`, null);
let balField = null;
const balCalib = [];
if (extra) {
  const calibIds = Object.keys(extra.bal || {}).filter(id => readCSV(`${DIR}/shares/${id}.csv`).length > 0);
  const byType = {};
  for (const id of calibIds) {
    const sh = readCSV(`${DIR}/shares/${id}.csv`);
    for (const r of readJSON(`${DIR}/balance/${id}.json`, [])) {
      if (/_per$/.test(r.type) || !(r.value > 0)) continue;
      const ref = [...sh].reverse().find(x => x.date <= r.date);
      if (ref) (byType[r.type] ??= []).push((r.value / 10) / ref.shares);
    }
  }
  for (const [type, arr] of Object.entries(byType)) {
    const s = [...arr].sort((a, b) => a - b);
    const med = s[s.length >> 1];
    const within = arr.filter(x => Math.abs(x - 1) < 0.05).length / arr.length;
    balCalib.push({ type, med: Math.round(med * 1000) / 1000, within: Math.round(within * 1000) / 10, n: arr.length });
  }
  balCalib.sort((a, b) => Math.abs(a.med - 1) - Math.abs(b.med - 1));
  if (balCalib.length && Math.abs(balCalib[0].med - 1) < 0.05) balField = balCalib[0].type;
}

// ---------- 每檔：市值、成交值、漲跌幅異常 ----------
const S = [];
const limitBreaks = [];
const lastCal = cal[D - 1];
for (const s of list) {
  const px = readCSV(`${DIR}/prices/${s.id}.csv`);
  if (!px.length) continue;
  let sh = readCSV(`${DIR}/shares/${s.id}.csv`), shSource = 'daily';
  if (!sh.length && balField) {
    // 季報股本：季底 + 90 天後才算「已知」
    const rows = readJSON(`${DIR}/balance/${s.id}.json`, []).filter(r => r.type === balField && r.value > 0)
      .map(r => ({ date: addDays(r.date, BAL_LAG_DAYS), shares: r.value / 10 })).sort((a, b) => a.date.localeCompare(b.date));
    if (rows.length) { sh = rows; shSource = 'balance'; }
  }
  if (!sh.length) shSource = 'none';
  const close = new Float64Array(D).fill(NaN), money = new Float64Array(D), mcap = new Float64Array(D).fill(NaN);
  for (const r of px) { const i = dIdx.get(r.date); if (i != null) { close[i] = r.close; money[i] = r.money; } }
  let k = -1;
  for (let i = 0; i < D; i++) {
    while (k + 1 < sh.length && sh[k + 1].date <= cal[i]) k++;
    if (k >= 0 && close[i] > 0) mcap[i] = close[i] * sh[k].shares;
  }
  const m20 = new Float64Array(D);
  let sum = 0;
  for (let i = 0; i < D; i++) { sum += money[i]; if (i >= MONEY_DAYS) sum -= money[i - MONEY_DAYS]; m20[i] = i >= MONEY_DAYS - 1 ? sum / MONEY_DAYS : NaN; }
  let prev = null;
  for (const r of px) {
    if (prev) {
      const lim = r.date < '2015-06-01' ? 0.07 : 0.10;
      const chg = r.close / prev.close - 1;
      if (Math.abs(chg) > lim + 0.005) limitBreaks.push({ id: s.id, date: r.date, prev: prev.close, close: r.close, chg: Math.round(chg * 1000) / 10 });
    }
    prev = r;
  }
  const last = px.at(-1).date;
  const delisted = addDays(last, 30) < lastCal ? last : null; // 以最後交易日判斷是否下市
  S.push({ id: s.id, name: s.name, delisted, shSource, mcap, m20, first: px[0].date, last, rows: px.length });
}

// ---------- 每日排名 → 權值股名單 ----------
const inU = S.map(() => new Uint8Array(D));
const viaProxy = S.map(() => 0);
const dailyCount = new Int32Array(D);
for (let i = 0; i < D; i++) {
  const mRank = new Map(), tRank = new Map();
  S.map((s, j) => [j, s.mcap[i]]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).forEach(([j], r) => mRank.set(j, r + 1));
  S.map((s, j) => [j, s.m20[i]]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).forEach(([j], r) => tRank.set(j, r + 1));
  S.forEach((s, j) => {
    const tr = tRank.get(j) ?? Infinity;
    let on = false;
    if (s.shSource !== 'none') on = (mRank.get(j) ?? Infinity) <= MCAP_TOP && tr <= MONEY_TOP;
    else if (tr <= PROXY_MONEY_TOP) { on = true; viaProxy[j]++; }
    if (on) { inU[j][i] = 1; dailyCount[i]++; }
  });
}

const universe = {};
S.forEach((s, j) => {
  const segs = [];
  let start = -1;
  for (let i = 0; i <= D; i++) {
    const on = i < D && inU[j][i];
    if (on && start < 0) start = i;
    if (!on && start >= 0) { segs.push([cal[start], cal[i - 1]]); start = -1; }
  }
  if (segs.length) universe[s.id] = { name: s.name, delisted: s.delisted, shSource: s.shSource, proxyDays: viaProxy[j], days: segs.reduce((a, [x, y]) => a + (dIdx.get(y) - dIdx.get(x) + 1), 0), segs };
});
writeFileSync(`${DIR}/meta/universe.json`, JSON.stringify({
  builtAt: new Date().toISOString(),
  rule: `市值前${MCAP_TOP}且20日均成交值前${MONEY_TOP}；無股數資料者以20日均成交值前${PROXY_MONEY_TOP}代替`,
  balField, calendar: [cal[0], cal[D - 1]], stocks: universe,
}));

// ---------- 報告 ----------
const md = ['# 權值股名單與資料品質', ''];
const uIds = Object.keys(universe);
const uDel = uIds.filter(id => universe[id].delisted);
const added = uIds.filter(id => !oldUniverse[id]);
const removed = Object.keys(oldUniverse).filter(id => !universe[id]);
md.push('## 名單概況', '', '| 項目 | 數值 |', '|---|---|',
  `| 定義 | 市值前 ${MCAP_TOP} 名且 20 日均成交值前 ${MONEY_TOP} 名；沒有股數資料的股票改用 20 日均成交值前 ${PROXY_MONEY_TOP} 名 |`,
  `| 股本補缺欄位 | ${balField ?? '無（校正不通過，不使用）'} |`,
  `| 曾經進入名單的股票 | ${uIds.length} 檔 |`,
  `| 其中已下市（以最後交易日判斷） | ${uDel.length} 檔 |`,
  `| 使用季報股本的 | ${uIds.filter(id => universe[id].shSource === 'balance').length} 檔 |`,
  `| 使用成交值替代規則的 | ${uIds.filter(id => universe[id].shSource === 'none').length} 檔 |`,
  `| 與上一版相比新增 | ${added.length} 檔${added.length ? '：' + added.slice(0, 60).map(id => `${id}${universe[id].name}`).join('、') : ''} |`,
  `| 與上一版相比移除 | ${removed.length} 檔${removed.length ? '：' + removed.slice(0, 30).join('、') : ''} |`);

if (balCalib.length) {
  md.push('', '## 季報股本校正（股本÷10 ÷ 實際發行股數）', '', '| 欄位 | 中位數 | 誤差5%內比例 | 樣本 |', '|---|---|---|---|',
    ...balCalib.map(c => `| ${c.type} | ${c.med} | ${c.within}% | ${c.n} |`));
}

md.push('', '## 已下市且曾入選權值股（前 60 檔）', '', uDel.slice(0, 60).map(id => `${id}${universe[id].name}(${universe[id].delisted})`).join('、') || '無');

md.push('', '## 每年平均名單大小', '', '| 年度 | 平均檔數 | 當年曾入選 |', '|---|---|---|');
for (const y of [...new Set(cal.map(d => d.slice(0, 4)))]) {
  const idx = cal.map((d, i) => [d, i]).filter(([d]) => d.startsWith(y)).map(([, i]) => i);
  const avg = Math.round(idx.reduce((a, i) => a + dailyCount[i], 0) / idx.length);
  const ever = S.filter((s, j) => idx.some(i => inU[j][i])).length;
  md.push(`| ${y} | ${avg} | ${ever} |`);
}

md.push('', '## 抽查：各時期市值前 10 名', '');
for (const target of ['2004-12-31', '2008-12-31', '2012-12-31', '2016-12-31', '2020-12-31', '2024-12-31', cal[D - 1]]) {
  let i = D - 1; while (i > 0 && cal[i] > target) i--;
  const top = S.map(s => [s, s.mcap[i]]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 10);
  md.push(`**${cal[i]}**：` + top.map(([s, v]) => `${s.id}${s.name}(${Math.round(v / 1e8).toLocaleString()}億)`).join('、'), '');
}
writeFileSync(`${DIR}/meta/limit-breaks.json`, JSON.stringify(limitBreaks));

const out = md.join('\n');
console.log(out);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n');
