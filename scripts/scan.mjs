// ============================================================
// 每日掃描 ＋ 模擬交易（規則與 Phase 4 回測完全相同，已凍結）
//   B5：突破 60～119 天整理區間（40% 內）＋ 突破日量能 ≥ 2 倍
//   C4：突破 250 天以上整理區間（40% 內）＋ 突破日量能 ≥ 1.5 倍
//   A4（只提醒）：大盤空方 ＋ 距 52 週高點 ≤ -40% ＋ 收盤突破 20 日高
// 模擬帳戶：B5、C4 各一本，各 10 格；另外兩本「閒置資金跟著大盤」做對照
//   隔天開盤進場；停損 = 整理區間低點（最多 -15%）；最長持有 250 個交易日；成本 0.6%
// 與回測唯一差異：資料跳空排除只能看「過去」（未來的跳空當天還不知道）
// ============================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { computeFeatures, marketEnv } from './features.mjs';

const DIR = 'data', OUT = 'public/daily';
mkdirSync(`${DIR}/paper`, { recursive: true }); mkdirSync(OUT, { recursive: true });
const IS_FROM = '2005-01-01', COOLDOWN = 60, SLOTS = 10, HORIZON = 250, COST = 0.006;
const SIGNALS = {
  B5: { name: '短整理放量突破', fn: x => x.brkBase40 && x.bLen40 < 120 && x.moneyRatio >= 2 },
  C4: { name: '長整理放量突破', fn: x => x.brkBase40 && x.bLen40 >= 250 && x.moneyRatio >= 1.5 },
  A4: { name: '崩盤反轉提醒', fn: x => x.env === '空方' && x.fH52 <= -0.4 && x.brk20, alertOnly: true },
};
const BOOKS = [
  { key: 'B5', sig: 'B5', idle: false }, { key: 'C4', sig: 'C4', idle: false },
  { key: 'B5i', sig: 'B5', idle: true }, { key: 'C4i', sig: 'C4', idle: true },
];

const readJSON = (p, def) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return def; } };
const readBars = p => {
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  const head = lines.shift().split(',');
  return lines.filter(Boolean).map(l => { const v = l.split(','); const o = {}; head.forEach((h, i) => (o[h] = h === 'date' ? v[i] : Number(v[i]))); return o; });
};
const r1 = x => Math.round(x * 1000) / 10, r2 = x => Math.round(x * 100) / 100;

const taiex = readBars(`${DIR}/index/TAIEX.csv`);
const cal = taiex.map(b => b.date), txClose = new Map(taiex.map(b => [b.date, b.close]));
const lastDate = cal.at(-1);
const env = marketEnv(taiex);
const universe = readJSON(`${DIR}/meta/universe.json`, { stocks: {} }).stocks;
const gapsBy = {};
for (const g of readJSON(`${DIR}/meta/gap-classes.json`, [])) if (g.cls !== '上市初期') (gapsBy[g.id] ??= []).push(g.date);

const cache = new Map();
function load(id) {
  if (cache.has(id)) return cache.get(id);
  const bars = readBars(`${DIR}/adjusted/${id}.csv`);
  const v = bars.length ? { bars, idx: new Map(bars.map((b, i) => [b.date, i])), f: null } : null;
  cache.set(id, v);
  return v;
}

// ---------- 1. 重播訊號（與回測相同的冷卻規則），取得每一天的訊號 ----------
const sigByDate = {}; // date -> [{sig, id, ...}]
const todayRows = [];
for (const [id, u] of Object.entries(universe)) {
  if (u.segs.at(-1)[1] < cal[Math.max(0, cal.length - 400)]) continue; // 最近一年多沒入選的不用重播
  const s = load(id);
  if (!s || s.bars.length < 300) continue;
  s.f = computeFeatures(s.bars, env);
  const gIdx = (gapsBy[id] || []).map(d => s.idx.get(d)).filter(x => x != null);
  const last = { B5: -Infinity, C4: -Infinity, A4: -Infinity };
  for (const [a, b] of u.segs) {
    const ia = s.idx.get(a), ib = s.idx.get(b);
    if (ia == null || ib == null) continue;
    for (let t = Math.max(ia, 250); t <= ib; t++) {
      const date = s.bars[t].date;
      if (date < IS_FROM) continue;
      if (gIdx.some(g => g > t - 250 && g <= t)) continue; // 只看過去的跳空
      const x = s.f[t];
      for (const [k, def] of Object.entries(SIGNALS)) {
        if (!def.fn(x) || t - last[k] < COOLDOWN) continue;
        last[k] = t;
        (sigByDate[date] ??= []).push({ sig: k, id, t, baseLow: x.baseLow, mr: x.moneyRatio });
        if (date === lastDate) todayRows.push({ sig: k, id, name: u.name, x, bar: s.bars[t] });
      }
    }
  }
}

// ---------- 2. 模擬帳戶 ----------
const state = readJSON(`${DIR}/paper/state.json`, null) ?? {
  startDate: lastDate, lastDate: null, books: Object.fromEntries(BOOKS.map(b => [b.key, { cash: 1, positions: [], pending: [], equity: 1 }])),
};
const trades = readJSON(`${DIR}/paper/trades.json`, []);
const history = readJSON(`${DIR}/paper/equity.json`, []);
const todo = state.lastDate ? cal.filter(d => d > state.lastDate) : [lastDate];

function processDay(d, prevD) {
  for (const B of BOOKS) {
    const bk = state.books[B.key];
    if (B.idle && prevD && txClose.get(prevD)) bk.cash *= txClose.get(d) / txClose.get(prevD);
    // 進場：前一個交易日的訊號，今天開盤買
    const cands = bk.pending.sort((a, b) => (b.mr || 0) - (a.mr || 0));
    for (const p of cands) {
      const s = load(p.id); if (!s) continue;
      const j = s.idx.get(d), t = s.idx.get(p.signalDate);
      if (j == null || t == null || j !== t + 1) { p.note = '隔天未交易，放棄'; continue; }
      const o = s.bars[j], prevC = s.bars[t].close, lim = (d < '2015-06-01' ? 0.07 : 0.10) - 0.002;
      if (o.open === o.high && o.high === o.low && o.open / prevC - 1 >= lim) { trades.push({ book: B.key, id: p.id, name: universe[p.id]?.name, signalDate: p.signalDate, entryDate: d, status: '漲停買不到' }); continue; }
      if (bk.positions.length >= SLOTS || bk.positions.some(x => x.id === p.id)) continue;
      const alloc = Math.min(bk.cash, bk.equity / SLOTS);
      if (alloc <= 1e-9) continue;
      const entry = o.open;
      const stop = p.baseLow < entry ? Math.max(p.baseLow, entry * 0.85) : entry * 0.85;
      bk.cash -= alloc;
      bk.positions.push({ id: p.id, signalDate: p.signalDate, entryDate: d, entryRaw: o.open / (o.factor || 1), stopRatio: stop / entry, alloc, value: alloc });
    }
    bk.pending = [];
    // 出場與結算
    let val = bk.cash;
    for (let k = bk.positions.length - 1; k >= 0; k--) {
      const p = bk.positions[k], s = load(p.id);
      const j = s?.idx.get(d), e = s?.idx.get(p.entryDate), t = s?.idx.get(p.signalDate);
      if (j == null || e == null) { val += p.value; continue; }
      const b = s.bars[j], eo = s.bars[e].open;
      let exit = null, reason = null;
      if (j > e && b.open / eo <= p.stopRatio) { exit = b.open / eo; reason = '停損（跳空）'; }
      else if (b.low / eo <= p.stopRatio) { exit = p.stopRatio; reason = '停損'; }
      else if (j >= t + HORIZON) { exit = b.close / eo; reason = '持有期滿'; }
      if (exit != null) {
        const ret = exit - 1 - COST;
        bk.cash += p.alloc * (1 + ret); val += p.alloc * (1 + ret);
        trades.push({ book: B.key, id: p.id, name: universe[p.id]?.name, signalDate: p.signalDate, entryDate: p.entryDate, exitDate: d, ret: r1(ret), reason });
        bk.positions.splice(k, 1);
      } else { p.value = p.alloc * (b.close / eo); p.ret = r1(b.close / eo - 1); p.lastRaw = b.close / (b.factor || 1); val += p.value; }
    }
    bk.equity = val;
    // 今天的新訊號 → 明天開盤進場
    for (const sgn of (sigByDate[d] || []).filter(x => x.sig === B.sig)) bk.pending.push({ id: sgn.id, signalDate: d, baseLow: sgn.baseLow, mr: sgn.mr });
  }
  const tx0 = txClose.get(state.startDate);
  history.push({ date: d, B5: r2(state.books.B5.equity * 100), C4: r2(state.books.C4.equity * 100),
    total: r2((state.books.B5.equity + state.books.C4.equity) * 50), totalIdle: r2((state.books.B5i.equity + state.books.C4i.equity) * 50),
    taiex: r2((txClose.get(d) / tx0) * 100) });
  state.lastDate = d;
}
let prev = state.lastDate;
for (const d of todo) { processDay(d, prev); prev = d; }

writeFileSync(`${DIR}/paper/state.json`, JSON.stringify(state));
writeFileSync(`${DIR}/paper/trades.json`, JSON.stringify(trades));
writeFileSync(`${DIR}/paper/equity.json`, JSON.stringify(history));

// ---------- 3. 手機頁面用的資料 ----------
const inU = Object.entries(universe).filter(([, u]) => u.segs.at(-1)[1] === lastDate).length;
const sigOut = todayRows.map(({ sig, id, name, x, bar }) => ({
  sig, sigName: SIGNALS[sig].name, id, name, close: r2(bar.close / (bar.factor || 1)),
  stopRef: r2(Math.max(x.baseLow, bar.close * 0.85) / (bar.factor || 1)), stopPct: r1(Math.max(x.baseLow, bar.close * 0.85) / bar.close - 1),
  baseDays: x.bLen40, moneyRatio: r2(x.moneyRatio), fromHigh52: r1(x.fH52), fromLow52: r1(x.fL52), ret60: r1(x.ret60),
}));
const books = Object.fromEntries(['B5', 'C4'].map(k => {
  const bk = state.books[k];
  return [k, {
    equity: r2(bk.equity * 100), cash: r1(bk.cash / bk.equity), 
    positions: bk.positions.map(p => ({ id: p.id, name: universe[p.id]?.name, entryDate: p.entryDate, entry: r2(p.entryRaw), last: r2(p.lastRaw ?? p.entryRaw), ret: p.ret ?? 0, stop: r2(p.entryRaw * p.stopRatio), stopPct: r1(p.stopRatio - 1) })),
    pending: bk.pending.map(p => ({ id: p.id, name: universe[p.id]?.name })),
  }];
}));
const done = trades.filter(t => t.ret != null);
const summary = k => { const ts = done.filter(t => t.book === k); const w = ts.filter(t => t.ret > 0).length; return { n: ts.length, win: ts.length ? r1(w / ts.length) : null, avg: ts.length ? r2(ts.reduce((a, t) => a + t.ret, 0) / ts.length) : null }; };
writeFileSync(`${OUT}/latest.json`, JSON.stringify({
  date: lastDate, env: env.get(lastDate) ?? '資料不足', universeCount: inU, startDate: state.startDate,
  signals: sigOut.filter(s => !SIGNALS[s.sig].alertOnly), alerts: sigOut.filter(s => SIGNALS[s.sig].alertOnly),
  books, stats: { B5: summary('B5'), C4: summary('C4') },
  recentTrades: trades.filter(t => t.book === 'B5' || t.book === 'C4').reverse().slice(0, 30), history,
  generatedAt: new Date().toISOString(),
}));

const md = [`# 每日掃描 ${lastDate}`, '', `大盤環境：${env.get(lastDate) ?? '—'}｜今日權值股 ${inU} 檔｜模擬起始日 ${state.startDate}`, '',
  '| 訊號 | 股票 | 收盤 | 參考停損 | 整理天數 | 量能倍數 |', '|---|---|---|---|---|---|',
  ...sigOut.map(s => `| ${s.sig} ${s.sigName} | ${s.id}${s.name} | ${s.close} | ${s.stopRef}（${s.stopPct}%） | ${s.baseDays} | ${s.moneyRatio} |`),
  sigOut.length ? '' : '| 今天沒有訊號 | | | | | |', '',
  `模擬帳戶（起始 100）：B5 ${books.B5.equity}｜C4 ${books.C4.equity}｜合計 ${history.at(-1)?.total}｜閒置資金跟大盤 ${history.at(-1)?.totalIdle}｜加權指數 ${history.at(-1)?.taiex}`];
const out = md.join('\n');
console.log(out);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n');
