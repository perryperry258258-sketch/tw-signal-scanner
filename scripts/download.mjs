// ============================================================
// 全市場資料下載（可中斷、自動續傳）
// 每次執行只用本小時剩餘的 FinMind 額度，下載完一部分就存檔，
// 下一小時由排程自動接著下載，直到全部完成。
// 下載內容：上市櫃普通股（含 2004 年後下市）的原始日K、發行股數，
//          加權指數、0050，以及分割、變更面額資料
// 注意：絕對不印出 token
// ============================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, appendFileSync } from 'node:fs';

const TOKEN = process.env.FINMIND_TOKEN || '';
const API = 'https://api.finmindtrade.com/api/v4/data';
const START = '2004-01-01';     // 全市場完整資料約從 2004 年開始
const MAX_PER_RUN = 580;        // 每輪最多請求數（上限 600/小時，留緩衝）
const MAX_MINUTES = 45;         // 每輪最多執行時間
const DIR = 'data';
const t0 = Date.now();
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

for (const d of ['prices', 'shares', 'meta', 'index']) mkdirSync(`${DIR}/${d}`, { recursive: true });

const readJSON = (p, def) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return def; } };
const writeAtomic = (p, s) => { writeFileSync(p + '.tmp', s); renameSync(p + '.tmp', p); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

class StopRun extends Error {}
let used = 0, budget = 0;

async function q(dataset, params = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (used >= budget) throw new StopRun('本輪額度已用完');
    if ((Date.now() - t0) / 60000 > MAX_MINUTES) throw new StopRun('本輪時間已到');
    used++;
    const u = new URL(API);
    u.searchParams.set('dataset', dataset);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    try {
      const res = await fetch(u, { headers: { Authorization: `Bearer ${TOKEN}` } });
      const text = await res.text();
      let j = null;
      try { j = JSON.parse(text); } catch {}
      const msg = j?.msg || `HTTP ${res.status}`;
      if (res.status === 402 || j?.status === 402 || /upper limit/i.test(msg)) throw new StopRun(`FinMind 額度上限：${msg}`);
      if (res.ok && j && Array.isArray(j.data)) return j.data;
      if (attempt === 3) throw new Error(msg);
    } catch (e) {
      if (e instanceof StopRun) throw e;
      if (attempt === 3) throw e;
    }
    await sleep(2000 * attempt);
  }
}

// ---------- 額度 ----------
async function getBudget() {
  try {
    const r = await fetch('https://api.web.finmindtrade.com/v2/user_info', { headers: { Authorization: `Bearer ${TOKEN}` } });
    const j = await r.json();
    const left = (j.api_request_limit ?? 600) - (j.user_count ?? 0) - 10;
    return Math.max(0, Math.min(MAX_PER_RUN, left));
  } catch {
    return 300;
  }
}

// ---------- 股票清單（第一次執行時建立，之後固定） ----------
const EXCLUDE_INDUSTRY = /ETF|ETN|受益|存託|指數|Index|大盤|所有證券/i;
async function buildStockList() {
  const info = await q('TaiwanStockInfo');
  const del = await q('TaiwanStockDelisting');
  const map = new Map();
  for (const r of info) {
    if (!/^[1-9]\d{3}$/.test(r.stock_id)) continue;
    if (!['twse', 'tpex'].includes(r.type)) continue;          // 不含興櫃
    if (EXCLUDE_INDUSTRY.test(r.industry_category || '')) continue;
    if (!map.has(r.stock_id)) map.set(r.stock_id, { id: r.stock_id, name: r.stock_name, market: r.type, industry: r.industry_category, delisted: null });
  }
  for (const r of del) {
    if (!/^[1-9]\d{3}$/.test(r.stock_id) || r.date < START) continue;
    if (map.has(r.stock_id)) continue;                          // 下櫃轉上市等仍在交易的，用現有資料
    map.set(r.stock_id, { id: r.stock_id, name: r.stock_name, market: 'delisted', industry: null, delisted: r.date });
  }
  const list = [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  writeAtomic(`${DIR}/meta/stocks.json`, JSON.stringify({ builtAt: today, count: list.length, list }, null, 1));
  return list;
}

// ---------- 下載工作 ----------
async function fetchPrice(id, file) {
  const data = await q('TaiwanStockPrice', { data_id: id, start_date: START, end_date: today });
  const rows = data.filter(r => r.close > 0 && r.open > 0).sort((a, b) => a.date.localeCompare(b.date));
  const lines = ['date,open,high,low,close,volume,money',
    ...rows.map(r => `${r.date},${r.open},${r.max},${r.min},${r.close},${r.Trading_Volume},${r.Trading_money}`)];
  writeAtomic(file, lines.join('\n') + '\n');
  return { rows: rows.length, first: rows[0]?.date ?? null, last: rows.at(-1)?.date ?? null };
}

async function fetchShares(id) {
  const data = await q('TaiwanStockShareholding', { data_id: id, start_date: START, end_date: today });
  const rows = data.filter(r => r.NumberOfSharesIssued > 0).sort((a, b) => a.date.localeCompare(b.date));
  const lines = ['date,shares'];
  let last = null;
  for (const r of rows) if (r.NumberOfSharesIssued !== last) { lines.push(`${r.date},${r.NumberOfSharesIssued}`); last = r.NumberOfSharesIssued; }
  writeAtomic(`${DIR}/shares/${id}.csv`, lines.join('\n') + '\n');
  return { rows: rows.length, changes: lines.length - 1 };
}

// ---------- 主程式 ----------
const status = readJSON(`${DIR}/status.json`, { createdAt: today, runs: 0, global: {}, stocks: {}, complete: false });
let stopReason = '全部完成';
const log = [];

async function main() {
  if (!TOKEN) { stopReason = '讀不到 FINMIND_TOKEN'; return; }
  budget = await getBudget();
  if (budget <= 0) { stopReason = '本小時額度已用完，下一輪再繼續'; return; }

  let list = readJSON(`${DIR}/meta/stocks.json`, null)?.list;
  if (!list) list = await buildStockList();
  for (const s of list) status.stocks[s.id] ??= { p: null, s: null, pe: 0, se: 0 };

  // 全域資料
  const G = status.global;
  if (!G.taiex) { const r = await fetchPrice('TAIEX', `${DIR}/index/TAIEX.csv`); G.taiex = r; }
  if (!G.etf0050) { const r = await fetchPrice('0050', `${DIR}/index/0050.csv`); G.etf0050 = r; }
  if (!G.splits) { writeAtomic(`${DIR}/meta/splits.json`, JSON.stringify(await q('TaiwanStockSplitPrice', { start_date: '2000-01-01' }))); G.splits = today; }
  if (!G.parValue) { writeAtomic(`${DIR}/meta/parvalue.json`, JSON.stringify(await q('TaiwanStockParValueChange', { start_date: '2000-01-01' }))); G.parValue = today; }
  saveStatus();

  for (const s of list) {
    const st = status.stocks[s.id];
    if (!st.p && st.pe < 3) {
      try { const r = await fetchPrice(s.id, `${DIR}/prices/${s.id}.csv`); Object.assign(st, { p: today, pr: r.rows, pf: r.first, pl: r.last }); }
      catch (e) { if (e instanceof StopRun) throw e; st.pe++; log.push(`${s.id} 股價失敗：${e.message}`); }
    }
    if (!st.s && st.se < 3) {
      try { const r = await fetchShares(s.id); Object.assign(st, { s: today, sr: r.rows, sc: r.changes }); }
      catch (e) { if (e instanceof StopRun) throw e; st.se++; log.push(`${s.id} 股數失敗：${e.message}`); }
    }
    saveStatus();
  }
}

function saveStatus() { writeAtomic(`${DIR}/status.json`, JSON.stringify(status)); }

try { await main(); }
catch (e) { stopReason = e instanceof StopRun ? e.message : `錯誤：${e.message}`; }

// ---------- 進度報告 ----------
const all = Object.entries(status.stocks);
const pDone = all.filter(([, s]) => s.p || s.pe >= 3).length;
const sDone = all.filter(([, s]) => s.s || s.se >= 3).length;
const failed = all.filter(([, s]) => (!s.p && s.pe >= 3) || (!s.s && s.se >= 3)).map(([id]) => id);
const total = all.length;
const complete = total > 0 && pDone === total && sDone === total && ['taiex', 'etf0050', 'splits', 'parValue'].every(k => status.global[k]);
status.runs++; status.lastRun = new Date().toISOString(); status.complete = complete;
saveStatus();

const remaining = (total - pDone) + (total - sDone);
const md = [
  `# 全市場資料下載進度`,
  '',
  `| 項目 | 數值 |`,
  `|---|---|`,
  `| 第幾輪 | ${status.runs} |`,
  `| 本輪使用請求 | ${used} |`,
  `| 本輪結束原因 | ${stopReason} |`,
  `| 股票總數（含下市） | ${total} |`,
  `| 股價完成 | ${pDone} / ${total}（${total ? Math.round(pDone / total * 100) : 0}%） |`,
  `| 發行股數完成 | ${sDone} / ${total}（${total ? Math.round(sDone / total * 100) : 0}%） |`,
  `| 預估剩餘 | ${complete ? '已全部完成 ✅' : `約 ${Math.ceil(remaining / MAX_PER_RUN)} 小時（排程每小時自動執行）`} |`,
  `| 失敗檔數 | ${failed.length}${failed.length ? '：' + failed.slice(0, 30).join(', ') : ''} |`,
  '',
  log.length ? '## 本輪錯誤\n\n' + log.slice(0, 30).map(x => `- ${x}`).join('\n') : '',
];

if (complete) {
  const withData = all.filter(([, s]) => s.pr > 0);
  const from2004 = withData.filter(([, s]) => s.pf && s.pf <= '2004-12-31').length;
  const noShares = all.filter(([, s]) => s.pr > 0 && !(s.sr > 0)).map(([id]) => id);
  const delisted = (readJSON(`${DIR}/meta/stocks.json`, { list: [] }).list || []).filter(x => x.delisted).length;
  md.push('', '## 完整性檢查', '', '| 項目 | 數值 |', '|---|---|',
    `| 有股價資料的股票 | ${withData.length} / ${total} |`,
    `| 其中已下市 | ${delisted} |`,
    `| 資料從 2004 年就開始的 | ${from2004} |`,
    `| 總日K筆數 | ${withData.reduce((a, [, s]) => a + s.pr, 0).toLocaleString()} |`,
    `| 有股價但沒有發行股數 | ${noShares.length}${noShares.length ? '：' + noShares.slice(0, 30).join(', ') : ''} |`,
    `| 加權指數 | ${status.global.taiex?.first} ～ ${status.global.taiex?.last} |`,
    `| 0050 | ${status.global.etf0050?.first} ～ ${status.global.etf0050?.last} |`);
  writeFileSync(`${DIR}/COMPLETE`, status.lastRun + '\n');
}

const out = md.join('\n');
console.log(out);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n');
