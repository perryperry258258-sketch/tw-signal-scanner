// ============================================================
// Phase 2b：補抓資料（可中斷、自動續傳）
// 1. 除權息結果：所有曾入選權值股的股票 ＋ 沒有發行股數的股票（用來算還原股價）
// 2. 資產負債表的股本：沒有發行股數的股票（補算市值），
//    另抽 20 檔「有發行股數」的股票當校正組，確認換算方式正確
// 注意：絕對不印出 token
// ============================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, appendFileSync } from 'node:fs';

const TOKEN = process.env.FINMIND_TOKEN || '';
const API = 'https://api.finmindtrade.com/api/v4/data';
const START = '2004-01-01';
const MAX_PER_RUN = 580, MAX_MINUTES = 45;
const DIR = 'data';
const t0 = Date.now();
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
for (const d of ['dividends', 'balance']) mkdirSync(`${DIR}/${d}`, { recursive: true });

const readJSON = (p, def) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return def; } };
const writeAtomic = (p, s) => { writeFileSync(p + '.tmp', s); renameSync(p + '.tmp', p); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readCSV = p => {
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  const head = lines.shift().split(',');
  return lines.filter(Boolean).map(l => { const v = l.split(','); const o = {}; head.forEach((h, i) => (o[h] = h === 'date' ? v[i] : Number(v[i]))); return o; });
};

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
async function getBudget() {
  try {
    const r = await fetch('https://api.web.finmindtrade.com/v2/user_info', { headers: { Authorization: `Bearer ${TOKEN}` } });
    const j = await r.json();
    return Math.max(0, Math.min(MAX_PER_RUN, (j.api_request_limit ?? 600) - (j.user_count ?? 0) - 10));
  } catch { return 300; }
}

// ---------- 工作清單 ----------
const main0 = readJSON(`${DIR}/status.json`, { stocks: {} });
const universe = readJSON(`${DIR}/meta/universe.json`, { stocks: {} }).stocks;
const noShares = Object.entries(main0.stocks).filter(([, s]) => s.pr > 0 && !(s.sr > 0)).map(([id]) => id);
const uIds = Object.keys(universe);
const calib = uIds.filter(id => main0.stocks[id]?.sr > 0).sort((a, b) => universe[b].days - universe[a].days).slice(0, 20);
const divIds = [...new Set([...uIds, ...noShares])].sort();
const balIds = [...new Set([...noShares, ...calib])].sort();

const st = readJSON(`${DIR}/extra-status.json`, { runs: 0, div: {}, bal: {} });
const saveSt = () => writeAtomic(`${DIR}/extra-status.json`, JSON.stringify(st));
const CAP_RE = /OrdinaryShare|CapitalStock|ShareCapital|股本/i;
let stopReason = '全部完成';
const log = [];

async function run() {
  if (!TOKEN) { stopReason = '讀不到 FINMIND_TOKEN'; return; }
  budget = await getBudget();
  if (budget <= 0) { stopReason = '本小時額度已用完，下一輪再繼續'; return; }
  for (const id of divIds) {
    const s = (st.div[id] ??= { done: false, err: 0 });
    if (s.done || s.err >= 3) continue;
    try {
      const rows = await q('TaiwanStockDividendResult', { data_id: id, start_date: START, end_date: today });
      writeAtomic(`${DIR}/dividends/${id}.json`, JSON.stringify(rows));
      Object.assign(s, { done: true, n: rows.length });
    } catch (e) { if (e instanceof StopRun) throw e; s.err++; log.push(`${id} 除權息失敗：${e.message}`); }
    saveSt();
  }
  for (const id of balIds) {
    const s = (st.bal[id] ??= { done: false, err: 0 });
    if (s.done || s.err >= 3) continue;
    try {
      const rows = await q('TaiwanStockBalanceSheet', { data_id: id, start_date: START, end_date: today });
      const keep = rows.filter(r => CAP_RE.test(`${r.type ?? ''} ${r.origin_name ?? ''}`));
      writeAtomic(`${DIR}/balance/${id}.json`, JSON.stringify(keep));
      Object.assign(s, { done: true, n: keep.length, all: rows.length });
    } catch (e) { if (e instanceof StopRun) throw e; s.err++; log.push(`${id} 資產負債表失敗：${e.message}`); }
    saveSt();
  }
}

try { await run(); } catch (e) { stopReason = e instanceof StopRun ? e.message : `錯誤：${e.message}`; }

const cnt = o => Object.values(o).filter(s => s.done || s.err >= 3).length;
const divDone = divIds.filter(id => st.div[id]?.done || st.div[id]?.err >= 3).length;
const balDone = balIds.filter(id => st.bal[id]?.done || st.bal[id]?.err >= 3).length;
const complete = divDone === divIds.length && balDone === balIds.length;
st.runs++; st.lastRun = new Date().toISOString(); st.complete = complete;
saveSt();

const failed = [...divIds.filter(id => !st.div[id]?.done && st.div[id]?.err >= 3), ...balIds.filter(id => !st.bal[id]?.done && st.bal[id]?.err >= 3)];
const md = ['# Phase 2b 補抓資料進度', '', '| 項目 | 數值 |', '|---|---|',
  `| 第幾輪 | ${st.runs} |`,
  `| 本輪使用請求 | ${used} |`,
  `| 本輪結束原因 | ${stopReason} |`,
  `| 除權息結果 | ${divDone} / ${divIds.length} |`,
  `| 資產負債表股本 | ${balDone} / ${balIds.length}（含校正組 ${calib.length} 檔） |`,
  `| 預估剩餘 | ${complete ? '已全部完成 ✅' : `約 ${Math.ceil((divIds.length - divDone + balIds.length - balDone) / MAX_PER_RUN)} 小時`} |`,
  `| 失敗 | ${failed.length}${failed.length ? '：' + failed.join(', ') : ''} |`];
if (log.length) md.push('', '## 本輪錯誤', '', ...log.slice(0, 30).map(x => `- ${x}`));

if (complete) {
  // 除權息涵蓋率
  const withDiv = divIds.filter(id => st.div[id]?.n > 0).length;
  md.push('', '## 完整性檢查', '', '| 項目 | 數值 |', '|---|---|',
    `| 有除權息紀錄的股票 | ${withDiv} / ${divIds.length} |`,
    `| 除權息總筆數 | ${divIds.reduce((a, id) => a + (st.div[id]?.n || 0), 0)} |`);

  // 股本欄位：列出找到哪些類型，並用校正組比對「股本 ÷ 10」與實際發行股數
  const typeStat = {};
  for (const id of balIds) for (const r of readJSON(`${DIR}/balance/${id}.json`, [])) {
    const k = `${r.type}｜${r.origin_name ?? ''}`;
    typeStat[k] ??= { stocks: new Set(), rows: 0 }; typeStat[k].stocks.add(id); typeStat[k].rows++;
  }
  const calibRes = {};
  for (const id of calib) {
    const sh = readCSV(`${DIR}/shares/${id}.csv`);
    for (const r of readJSON(`${DIR}/balance/${id}.json`, [])) {
      const k = `${r.type}｜${r.origin_name ?? ''}`;
      const ref = [...sh].reverse().find(x => x.date <= r.date);
      if (!ref || !(r.value > 0)) continue;
      (calibRes[k] ??= []).push((r.value / 10) / ref.shares);
    }
  }
  const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[s.length >> 1] * 1000) / 1000 : null; };
  md.push('', '## 資產負債表中的股本欄位（校正：股本÷10 與實際發行股數的比值，接近 1 代表換算正確）', '',
    '| 欄位 | 股票數 | 筆數 | 校正比值中位數 | 校正樣本 |', '|---|---|---|---|---|',
    ...Object.entries(typeStat).map(([k, v]) => `| ${k} | ${v.stocks.size} | ${v.rows} | ${med(calibRes[k] || []) ?? '—'} | ${(calibRes[k] || []).length} |`));
  const noBal = noShares.filter(id => !(st.bal[id]?.n > 0));
  md.push('', `沒有發行股數、也找不到股本的股票：${noBal.length} 檔${noBal.length ? '：' + noBal.slice(0, 40).join(', ') : ''}`);
  writeFileSync(`${DIR}/EXTRA_COMPLETE`, st.lastRun + '\n');
}

const out = md.join('\n');
console.log(out);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n');
