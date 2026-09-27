// ============================================================
// 每日／每週資料更新（FinMind，增量）
// MODE=daily ：只更新「候選池」（約 300～400 檔權值股候選）＋ 持倉股的股價、除權息
// MODE=weekly：更新全部上市櫃股票的股價與發行股數（可中斷、下一小時續傳），
//              並刷新股票清單（新上市）與候選池的除權息
// 注意：絕對不印出 token
// ============================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, appendFileSync } from 'node:fs';

const MODE = process.env.MODE || 'daily';
const TOKEN = process.env.FINMIND_TOKEN || '';
const API = 'https://api.finmindtrade.com/api/v4/data';
const MAX_PER_RUN = 580, MAX_MINUTES = 45;
const DIR = 'data';
const t0 = Date.now();
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
for (const d of ['prices', 'shares', 'dividends', 'meta', 'index']) mkdirSync(`${DIR}/${d}`, { recursive: true });

const readJSON = (p, def) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return def; } };
const writeAtomic = (p, s) => { writeFileSync(p + '.tmp', s); renameSync(p + '.tmp', p); };
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lastLine = p => { if (!existsSync(p)) return null; const t = readFileSync(p, 'utf8').trim().split('\n'); return t.length > 1 ? t[t.length - 1].split(',') : null; };

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
      if (/upper limit/i.test(msg)) throw new StopRun(`FinMind 額度上限：${msg}`);
      if (res.ok && j && Array.isArray(j.data)) return j.data;
      if (attempt === 3 || res.status === 402 || j?.status === 402) throw new Error(msg);
    } catch (e) {
      if (e instanceof StopRun) throw e;
      if (attempt === 3 || /level|sponsor/i.test(e.message)) throw e;
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

// ---------- 增量更新 ----------
async function updatePrice(id, file) {
  const last = lastLine(file);
  const from = last ? addDays(last[0], 1) : '2004-01-01';
  if (from > today) return 0;
  const data = await q('TaiwanStockPrice', { data_id: id, start_date: from, end_date: today });
  const rows = data.filter(r => r.close > 0 && r.open > 0 && (!last || r.date > last[0])).sort((a, b) => a.date.localeCompare(b.date));
  const lines = rows.map(r => `${r.date},${r.open},${r.max},${r.min},${r.close},${r.Trading_Volume},${r.Trading_money}`);
  if (!existsSync(file)) writeAtomic(file, ['date,open,high,low,close,volume,money', ...lines].join('\n') + '\n');
  else if (lines.length) appendFileSync(file, lines.join('\n') + '\n');
  return rows.length;
}
async function updateShares(id, since) {
  const file = `${DIR}/shares/${id}.csv`;
  const last = lastLine(file);
  const data = await q('TaiwanStockShareholding', { data_id: id, start_date: since, end_date: today });
  const rows = data.filter(r => r.NumberOfSharesIssued > 0 && (!last || r.date > last[0])).sort((a, b) => a.date.localeCompare(b.date));
  let prev = last ? Number(last[1]) : null;
  const lines = [];
  for (const r of rows) if (r.NumberOfSharesIssued !== prev) { lines.push(`${r.date},${r.NumberOfSharesIssued}`); prev = r.NumberOfSharesIssued; }
  if (!existsSync(file)) writeAtomic(file, ['date,shares', ...lines].join('\n') + '\n');
  else if (lines.length) appendFileSync(file, lines.join('\n') + '\n');
  return lines.length;
}
function mergeDividends(id, rows) {
  const file = `${DIR}/dividends/${id}.json`;
  const cur = readJSON(file, []);
  const have = new Set(cur.map(r => r.date));
  const add = rows.filter(r => !have.has(r.date));
  if (add.length) writeAtomic(file, JSON.stringify([...cur, ...add].sort((a, b) => a.date.localeCompare(b.date))));
  return add.length;
}

// ---------- 候選池 ----------
const paper = readJSON(`${DIR}/paper/state.json`, null);
const held = new Set();
if (paper) for (const b of Object.values(paper.books || {})) { for (const p of b.positions || []) held.add(p.id); for (const p of b.pending || []) held.add(p.id); }
let pool = readJSON(`${DIR}/meta/pool.json`, null)?.ids;
if (!pool) {
  const u = readJSON(`${DIR}/meta/universe.json`, { stocks: {}, calendar: [null, null] });
  const recent = addDays(u.calendar[1] || today, -400);
  pool = Object.entries(u.stocks).filter(([, s]) => s.segs.at(-1)[1] >= recent).map(([id]) => id);
}
const targets = [...new Set([...held, ...pool])].sort();

const log = [];
let stopReason = '完成', newRows = 0, divAdded = 0, justDone = false;
const st = readJSON(`${DIR}/update-status.json`, { daily: {}, weekly: {} });

async function daily() {
  const s = (st.daily = { date: today, done: st.daily?.date === today ? st.daily.done || [] : [] });
  const tx = await updatePrice('TAIEX', `${DIR}/index/TAIEX.csv`);
  await updatePrice('0050', `${DIR}/index/0050.csv`);
  newRows += tx;
  const txLast = lastLine(`${DIR}/index/TAIEX.csv`)?.[0];
  for (const id of targets) {
    if (s.done.includes(id)) continue;
    try {
      newRows += await updatePrice(id, `${DIR}/prices/${id}.csv`);
      if ((lastLine(`${DIR}/prices/${id}.csv`)?.[0] ?? '') >= txLast) s.done.push(id); // 已更新到最新交易日才算完成
    } catch (e) { if (e instanceof StopRun) throw e; log.push(`${id} 股價：${e.message}`); }
  }
  // 除權息：先試全市場一次抓；不支援就只抓持倉股
  try {
    const rows = await q('TaiwanStockDividendResult', { start_date: addDays(today, -30), end_date: today });
    const by = {};
    for (const r of rows) (by[r.stock_id] ??= []).push(r);
    for (const [id, rs] of Object.entries(by)) divAdded += mergeDividends(id, rs);
  } catch (e) {
    if (e instanceof StopRun) throw e;
    log.push(`全市場除權息不支援，改抓持倉股（${e.message.slice(0, 60)}）`);
    for (const id of held) {
      try { divAdded += mergeDividends(id, await q('TaiwanStockDividendResult', { data_id: id, start_date: addDays(today, -60), end_date: today })); }
      catch (e2) { if (e2 instanceof StopRun) throw e2; }
    }
  }
}

function weekKey(d) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); }
async function weekly() {
  const wk = weekKey(today);
  if (st.weekly?.week !== wk) st.weekly = { week: wk, p: [], s: [], d: [], info: false, complete: false };
  const W = st.weekly;
  if (W.complete) { stopReason = '本週已完成'; return; }
  const meta = readJSON(`${DIR}/meta/stocks.json`, { list: [] });
  if (!W.info) {
    const info = await q('TaiwanStockInfo');
    const have = new Set(meta.list.map(s => s.id));
    for (const r of info) {
      if (!/^[1-9]\d{3}$/.test(r.stock_id) || !['twse', 'tpex'].includes(r.type) || have.has(r.stock_id)) continue;
      if (/ETF|ETN|受益|存託|指數|Index|大盤|所有證券/i.test(r.industry_category || '')) continue;
      meta.list.push({ id: r.stock_id, name: r.stock_name, market: r.type, industry: r.industry_category, delisted: null });
      have.add(r.stock_id); log.push(`新增股票 ${r.stock_id}${r.stock_name}`);
    }
    meta.list.sort((a, b) => a.id.localeCompare(b.id));
    writeAtomic(`${DIR}/meta/stocks.json`, JSON.stringify({ ...meta, count: meta.list.length }, null, 1));
    W.info = true;
  }
  const alive = meta.list.filter(s => { const l = lastLine(`${DIR}/prices/${s.id}.csv`); return !l || l[0] >= addDays(today, -90); }).map(s => s.id);
  await updatePrice('TAIEX', `${DIR}/index/TAIEX.csv`);
  for (const id of alive) {
    if (!W.p.includes(id)) {
      try { newRows += await updatePrice(id, `${DIR}/prices/${id}.csv`); W.p.push(id); }
      catch (e) { if (e instanceof StopRun) throw e; W.p.push(id); log.push(`${id} 股價：${e.message}`); }
    }
    if (!W.s.includes(id)) {
      const l = lastLine(`${DIR}/shares/${id}.csv`);
      try { await updateShares(id, l ? addDays(l[0], 1) : '2004-01-01'); W.s.push(id); }
      catch (e) { if (e instanceof StopRun) throw e; W.s.push(id); log.push(`${id} 股數：${e.message}`); }
    }
    writeAtomic(`${DIR}/update-status.json`, JSON.stringify(st));
  }
  for (const id of targets) {
    if (W.d.includes(id)) continue;
    try { divAdded += mergeDividends(id, await q('TaiwanStockDividendResult', { data_id: id, start_date: addDays(today, -400), end_date: today })); W.d.push(id); }
    catch (e) { if (e instanceof StopRun) throw e; W.d.push(id); }
    writeAtomic(`${DIR}/update-status.json`, JSON.stringify(st));
  }
  W.complete = true;
  W.total = alive.length;
  justDone = true;
}

try {
  if (!TOKEN) stopReason = '讀不到 FINMIND_TOKEN';
  else {
    budget = await getBudget();
    if (budget <= 0) stopReason = '本小時額度已用完';
    else if (MODE === 'weekly') await weekly(); else await daily();
  }
} catch (e) { stopReason = e instanceof StopRun ? e.message : `錯誤：${e.message}`; }
writeAtomic(`${DIR}/update-status.json`, JSON.stringify(st));

const taiexLast = lastLine(`${DIR}/index/TAIEX.csv`)?.[0];
const md = [`# 資料更新（${MODE === 'weekly' ? '每週全市場' : '每日候選池'}）`, '', '| 項目 | 數值 |', '|---|---|',
  `| 本輪使用請求 | ${used} |`, `| 結束原因 | ${stopReason} |`, `| 加權指數最新日期 | ${taiexLast} |`,
  `| 新增日K筆數 | ${newRows} |`, `| 新增除權息筆數 | ${divAdded} |`,
  MODE === 'weekly' ? `| 本週進度 | 股價 ${st.weekly.p?.length ?? 0}、股數 ${st.weekly.s?.length ?? 0}、除權息 ${st.weekly.d?.length ?? 0}${st.weekly.complete ? '（完成 ✅）' : ''} |` : `| 候選池＋持倉 | ${targets.length} 檔，完成 ${st.daily.done?.length ?? 0} 檔 |`];
if (log.length) md.push('', '## 訊息', '', ...log.slice(0, 40).map(x => `- ${x}`));
const out = md.join('\n');
console.log(out);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n');
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `newdata=${newRows > 0 || divAdded > 0 ? 'true' : 'false'}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `weeklyjustdone=${justDone ? 'true' : 'false'}\n`);
}
