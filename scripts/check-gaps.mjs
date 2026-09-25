// ============================================================
// Phase 2d：「無法解釋的跳空」分類與影響評估
// 分類：
//   上市初期：上市後前 5 個交易日（台股新股前 5 天不設漲跌幅限制）→ 真實價格，保留
//   連續異常：同一檔前後 10 個交易日內還有其他跳空 → 多半是不設漲跌幅的交易期間，
//            價格本身是真的，保留但標記
//   單一跳空：前後都沒有其他跳空 → 最可能是沒被還原的公司行動（減資等），
//            回測時避開跨越它的訊號
// ============================================================
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const DIR = 'data';
const WINDOW = 10, IMPACT = 250;
const readJSON = (p, def) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return def; } };
const dates = id => {
  const p = `${DIR}/adjusted/${id}.csv`;
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').slice(1).map(l => l.slice(0, 10));
};

const gaps = readJSON(`${DIR}/meta/unexplained-gaps.json`, []);
const universe = readJSON(`${DIR}/meta/universe.json`, { stocks: {} }).stocks;
const byStock = {};
for (const g of gaps) (byStock[g.id] ??= []).push(g);

const classified = [];
let uDays = 0, exIsolated = 0, exAll = 0;
const perStock = [];
for (const id of Object.keys(universe)) {
  const ds = dates(id);
  if (!ds.length) continue;
  const idx = new Map(ds.map((d, i) => [d, i]));
  const gs = (byStock[id] || []).map(g => ({ ...g, i: idx.get(g.date) })).filter(g => g.i != null);
  const isIpo = ds[0] > '2004-01-10';
  for (const g of gs) {
    let cls;
    if (isIpo && g.i <= 5) cls = '上市初期';
    else if (gs.some(o => o !== g && Math.abs(o.i - g.i) <= WINDOW)) cls = '連續異常';
    else cls = '單一跳空';
    const inU = universe[id].segs.some(([a, b]) => g.date >= a && g.date <= b);
    classified.push({ ...g, cls, inU });
  }
  // 影響評估：權值股名單內的每一天，前後 250 個交易日內有沒有跳空
  const iso = gs.filter(g => classified.find(c => c.id === id && c.date === g.date)?.cls === '單一跳空').map(g => g.i);
  const all = gs.filter(g => classified.find(c => c.id === id && c.date === g.date)?.cls !== '上市初期').map(g => g.i);
  let n = 0, e1 = 0, e2 = 0;
  for (const [a, b] of universe[id].segs) {
    const ia = idx.get(a), ib = idx.get(b);
    if (ia == null || ib == null) continue;
    for (let t = ia; t <= ib; t++) {
      n++;
      if (iso.some(g => g > t - IMPACT && g <= t + IMPACT)) e1++;
      if (all.some(g => g > t - IMPACT && g <= t + IMPACT)) e2++;
    }
  }
  uDays += n; exIsolated += e1; exAll += e2;
  if (gs.length) perStock.push({ id, name: universe[id].name, n: gs.length, inU: classified.filter(c => c.id === id && c.inU).length, uDays: n, e1 });
}

const count = cls => classified.filter(c => c.cls === cls).length;
const countU = cls => classified.filter(c => c.cls === cls && c.inU).length;
writeFileSync(`${DIR}/meta/gap-classes.json`, JSON.stringify(classified.map(({ id, date, chg, cls, inU }) => ({ id, date, chg, cls, inU }))));

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const md = ['# Phase 2d：無法解釋的跳空分類', '',
  '| 分類 | 全部 | 發生在權值股名單期間內 | 處理方式 |', '|---|---|---|---|',
  `| 上市初期（前 5 天無漲跌幅限制） | ${count('上市初期')} | ${countU('上市初期')} | 真實價格，保留 |`,
  `| 連續異常（前後 10 天內還有跳空） | ${count('連續異常')} | ${countU('連續異常')} | 多為無漲跌幅限制的交易期間，保留並標記 |`,
  `| 單一跳空（前後都沒有其他跳空） | ${count('單一跳空')} | ${countU('單一跳空')} | 疑似未還原的公司行動，回測避開 |`,
  `| 合計 | ${classified.length} | ${classified.filter(c => c.inU).length} | |`,
  '', '## 對回測的影響', '', '| 項目 | 數值 |', '|---|---|',
  `| 權值股名單總天數（股票 × 交易日） | ${uDays.toLocaleString()} |`,
  `| 只避開「單一跳空」前後 250 天 | 排除 ${exIsolated.toLocaleString()} 天（${pct(exIsolated, uDays)}%） |`,
  `| 若連「連續異常」也避開 | 排除 ${exAll.toLocaleString()} 天（${pct(exAll, uDays)}%） |`,
  '', '## 跳空最多的股票（前 20 檔）', '', '| 股票 | 跳空數 | 其中在名單期間 | 名單天數 | 因單一跳空排除天數 |', '|---|---|---|---|---|',
  ...perStock.sort((a, b) => b.n - a.n).slice(0, 20).map(s => `| ${s.id}${s.name} | ${s.n} | ${s.inU} | ${s.uDays} | ${s.e1} |`),
  '', '## 單一跳空，且發生在名單期間內（依幅度排序，前 40 筆）', '', '| 股票 | 日期 | 漲跌% |', '|---|---|---|',
  ...classified.filter(c => c.cls === '單一跳空' && c.inU).sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg)).slice(0, 40)
    .map(c => `| ${c.id}${universe[c.id].name} | ${c.date} | ${c.chg} |`)];

const out = md.join('\n');
console.log(out);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n');
