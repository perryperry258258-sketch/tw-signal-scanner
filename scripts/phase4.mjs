// ============================================================
// Phase 4：三類訊號比較，找報酬最高的方法
// 規則（所有訊號共用，事先固定）：
//   進場：訊號隔天開盤；停損：整理區間低點，最多 -15%；最長持有 250 個交易日
//   去重：同一檔股票、同一種訊號，60 個交易日內只算第一次
//   組合模擬：10 格資金，每筆用當時總資產的 1/10；格子滿了就放棄新訊號
//   同一天多個訊號：突破日量能較大的優先
// 挑選規則（事先寫死，不看樣本外）：
//   每一類中，樣本內事件數 ≥ 30 的變化版裡，選「樣本內組合年化報酬」最高者
//   只有被選中的版本才打開樣本外（2017 之後）驗證一次
// ============================================================
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { computeFeatures, outcomeAt, marketEnv } from './features.mjs';

const DIR = 'data';
const IS_FROM = '2005-01-01', IS_TO = '2016-12-31', OOS_FROM = '2017-01-01';
const COOLDOWN = 60, SLOTS = 10, HORIZON = 250, MIN_EVENTS = 30;
mkdirSync(`${DIR}/research`, { recursive: true });
const readJSON = (p, def) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return def; } };
const readBars = p => {
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  const head = lines.shift().split(',');
  return lines.filter(Boolean).map(l => { const v = l.split(','); const o = {}; head.forEach((h, i) => (o[h] = h === 'date' ? v[i] : Number(v[i]))); return o; });
};
const md = [];
const say = (...s) => md.push(...s);

// ---------- 訊號定義（事先固定） ----------
const VARIANTS = [
  ['A', 'A1', '大盤空方＋距高點≤-30%＋收盤突破20日高', x => x.env === '空方' && x.fH52 <= -0.3 && x.brk20],
  ['A', 'A2', 'A1＋突破日量能≥1.5倍', x => x.env === '空方' && x.fH52 <= -0.3 && x.brk20 && x.moneyRatio >= 1.5],
  ['A', 'A3', '距高點≤-30%＋收盤突破20日高（不限大盤）', x => x.fH52 <= -0.3 && x.brk20],
  ['A', 'A4', '大盤空方＋距高點≤-40%＋收盤突破20日高', x => x.env === '空方' && x.fH52 <= -0.4 && x.brk20],
  ['B', 'B1', '1～2年新高＋量能≥2倍＋近60日漲≥20%', x => x.newHigh1y && !x.newHigh3y && x.moneyRatio >= 2 && x.ret60 >= 0.2],
  ['B', 'B2', '1～2年新高＋量能≥2倍', x => x.newHigh1y && !x.newHigh3y && x.moneyRatio >= 2],
  ['B', 'B3', '1年以上新高（含3年）＋量能≥2倍＋近60日漲≥20%', x => x.newHigh1y && x.moneyRatio >= 2 && x.ret60 >= 0.2],
  ['B', 'B4', '近60日漲≥50%＋收盤突破20日高', x => x.ret60 >= 0.5 && x.brk20],
  ['B', 'B5', '突破60～119天整理區間＋量能≥2倍', x => x.brkBase40 && x.bLen40 < 120 && x.moneyRatio >= 2],
  ['C', 'C1', '突破250天以上整理區間（40%內）', x => x.brkBase40 && x.bLen40 >= 250],
  ['C', 'C2', '突破120天以上整理區間（40%內）', x => x.brkBase40 && x.bLen40 >= 120],
  ['C', 'C3', '突破250天以上整理區間（30%內）', x => x.brkBase30 && x.bLen30 >= 250],
  ['C', 'C4', 'C1＋突破日量能≥1.5倍', x => x.brkBase40 && x.bLen40 >= 250 && x.moneyRatio >= 1.5],
  ['O', 'O1', '舊策略 B 級以上（對照組）', x => x.grade !== '觀察'],
];

// ---------- 資料 ----------
const taiex = readBars(`${DIR}/index/TAIEX.csv`);
const calEnd = taiex.at(-1).date;
const env = marketEnv(taiex);
const universe = readJSON(`${DIR}/meta/universe.json`, { stocks: {} }).stocks;
const gapCls = readJSON(`${DIR}/meta/gap-classes.json`, []);
const gapsBy = {};
for (const g of gapCls) if (g.cls !== '上市初期') (gapsBy[g.id] ??= []).push(g.date);

// ---------- 找出所有訊號 ----------
const events = Object.fromEntries(VARIANTS.map(v => [v[1], []]));
let unfilled = 0;
for (const id of Object.keys(universe).sort()) {
  const bars = readBars(`${DIR}/adjusted/${id}.csv`);
  if (bars.length < 300) continue;
  const f = computeFeatures(bars, env);
  const idx = new Map(bars.map((b, i) => [b.date, i]));
  const gIdx = (gapsBy[id] || []).map(d => idx.get(d)).filter(x => x != null);
  const last = Object.fromEntries(VARIANTS.map(v => [v[1], -Infinity]));
  for (const [a, b] of universe[id].segs) {
    const ia = idx.get(a), ib = idx.get(b);
    if (ia == null || ib == null) continue;
    for (let t = Math.max(ia, 250); t <= ib; t++) {
      if (bars[t].date < IS_FROM) continue;
      if (gIdx.some(g => g > t - 250 && g <= t + 250)) continue;
      const x = f[t];
      for (const [, key, , fn] of VARIANTS) {
        if (!fn(x) || t - last[key] < COOLDOWN) continue;
        last[key] = t;
        const o = outcomeAt(bars, t, x.baseLow, HORIZON, calEnd);
        if (o.status === 'unfilled') { unfilled++; continue; }
        let days, ret, censored = false;
        const entry = bars[t + 1]?.open;
        if (!entry) continue;
        if (o.status === 'done') { days = o.days; ret = o.exitRet; }
        else { days = bars.length - 1 - t; ret = bars.at(-1).close / entry - 1 - 0.006; censored = true; }
        // 每日持有價值（相對進場價），供組合每日結算
        const path = [];
        for (let j = t + 1; j <= t + days; j++) path.push([bars[j].date, bars[j].close / entry]);
        events[key].push({
          id, date: bars[t].date, entryDate: bars[t + 1].date, exitDate: bars[t + days].date,
          period: bars[t].date <= IS_TO ? 'IS' : 'OOS', ret, censored, reason: o.reason ?? 'open',
          h50: o.hit?.[0] != null, h100: o.hit?.[1] != null, h200: o.hit?.[2] != null, mfe: o.mfe ?? 0, mr: x.moneyRatio, path,
        });
      }
    }
  }
}

// ---------- 統計 ----------
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const r1 = x => (x == null || !isFinite(x) ? null : Math.round(x * 1000) / 10);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
function tradeStats(evs) {
  const d = evs.filter(e => !e.censored);
  const n = d.length;
  if (!n) return { n: 0 };
  const rets = d.map(e => e.ret);
  const win = rets.filter(r => r > 0), loss = rets.filter(r => r <= 0);
  const pf = loss.length ? win.reduce((a, b) => a + b, 0) / -loss.reduce((a, b) => a + b, 0) : Infinity;
  const weeks = new Set(d.map(e => e.date.slice(0, 4) + '-' + Math.floor((new Date(e.date).getTime() / 86400000 + 3) / 7))).size;
  return {
    n, weeks, p100: pct(d.filter(e => e.h100).length, n), p200: pct(d.filter(e => e.h200).length, n),
    stop: pct(d.filter(e => e.reason === 'stop').length, n), win: pct(win.length, n),
    avg: r1(rets.reduce((a, b) => a + b, 0) / n), med: r1(median(rets)), pf: isFinite(pf) ? Math.round(pf * 100) / 100 : '∞',
  };
}

// 組合模擬：10 格、每日以收盤價結算
function portfolio(evs, from, to) {
  const days = taiex.map(b => b.date).filter(d => d >= from && d <= to);
  const byEntry = {};
  for (const e of evs) if (e.entryDate >= from && e.entryDate <= to) (byEntry[e.entryDate] ??= []).push(e);
  let cash = 1, peak = 1, mdd = 0, taken = 0, exposure = 0;
  const open = [];
  let equity = 1;
  for (const d of days) {
    // 出場（依出場日）
    for (let k = open.length - 1; k >= 0; k--) {
      const p = open[k];
      if (p.e.exitDate <= d && !(p.e.censored && p.e.exitDate >= to)) { cash += p.alloc * (1 + p.e.ret); open.splice(k, 1); }
    }
    // 進場（開盤，用前一日總資產的 1/10）
    const cands = (byEntry[d] || []).sort((a, b) => (b.mr || 0) - (a.mr || 0));
    for (const e of cands) {
      if (open.length >= SLOTS) break;
      if (open.some(p => p.e.id === e.id)) continue;
      const alloc = Math.min(cash, equity / SLOTS);
      if (alloc <= 1e-9) break;
      cash -= alloc; open.push({ e, alloc, k: 0, v: 1 }); taken++;
    }
    // 每日結算
    let val = cash;
    for (const p of open) {
      while (p.k < p.e.path.length && p.e.path[p.k][0] <= d) { p.v = p.e.path[p.k][1]; p.k++; }
      val += p.alloc * p.v;
    }
    equity = val;
    exposure += open.length / SLOTS;
    if (equity > peak) peak = equity;
    mdd = Math.min(mdd, equity / peak - 1);
  }
  const years = days.length / 250;
  return { cagr: r1(Math.pow(equity, 1 / years) - 1), mdd: r1(mdd), total: r1(equity - 1), taken, exposure: r1(exposure / days.length) };
}
function bench(from, to) {
  const s = taiex.filter(b => b.date >= from && b.date <= to);
  let peak = 0, mdd = 0;
  for (const b of s) { peak = Math.max(peak, b.close); mdd = Math.min(mdd, b.close / peak - 1); }
  const years = s.length / 250;
  return { cagr: r1(Math.pow(s.at(-1).close / s[0].close, 1 / years) - 1), mdd: r1(mdd), total: r1(s.at(-1).close / s[0].close - 1) };
}

// ---------- 樣本內：全部變化版 ----------
const res = {};
for (const [fam, key, desc] of VARIANTS) {
  const isEv = events[key].filter(e => e.period === 'IS');
  res[key] = { fam, key, desc, t: tradeStats(isEv), p: portfolio(isEv, IS_FROM, IS_TO) };
}
const bIS = bench(IS_FROM, IS_TO);

say('# Phase 4：三類訊號比較（找報酬最高的方法）', '',
  '## ① 共同規則', '',
  '- 訊號隔天開盤進場；停損 = 整理區間低點（最多 -15%）；最長持有 250 個交易日；報酬已扣成本 0.6%',
  `- 同一檔、同一種訊號，${COOLDOWN} 個交易日內只算第一次`,
  `- 組合：${SLOTS} 格資金，每筆投入當時總資產的 1/${SLOTS}，格子滿了就放棄；同日多個訊號，突破日量能大的優先`,
  `- 挑選規則（事先寫死）：每類中樣本內事件 ≥ ${MIN_EVENTS} 筆的版本，選「樣本內組合年化報酬」最高者`,
  `- 隔天開盤漲停買不到：${unfilled} 次（已排除）`, '');

say('## ② 樣本內（2005～2016）全部版本', '',
  '| 版本 | 事件 | 訊號週數 | 翻倍率 | 先停損 | 勝率 | 平均報酬 | 中位報酬 | 獲利因子 | 組合年化 | 最大回檔 | 平均持倉 |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of Object.values(res)) {
  const t = r.t, p = r.p;
  say(`| ${r.key} | ${t.n} | ${t.weeks ?? 0} | ${t.p100 ?? '—'}% | ${t.stop ?? '—'}% | ${t.win ?? '—'}% | ${t.avg ?? '—'}% | ${t.med ?? '—'}% | ${t.pf ?? '—'} | ${p.cagr}% | ${p.mdd}% | ${p.exposure}% |`);
}
say(`| 加權指數（買進持有，不含股利） | — | — | — | — | — | — | — | — | ${bIS.cagr}% | ${bIS.mdd}% | 100% |`, '');
say('各版本定義：', '', ...VARIANTS.map(v => `- **${v[1]}**：${v[2]}`), '');

// ---------- 挑選 ----------
const picks = ['A', 'B', 'C'].map(fam => {
  const cands = Object.values(res).filter(r => r.fam === fam && r.t.n >= MIN_EVENTS);
  cands.sort((a, b) => b.p.cagr - a.p.cagr);
  return cands[0] ? cands[0].key : null;
}).filter(Boolean);
say('## ③ 依規則選出的各類代表', '', ...(picks.length ? picks.map(k => `- **${k}**：${res[k].desc}（樣本內組合年化 ${res[k].p.cagr}%）`) : ['- 沒有任何版本達到事件數門檻']), '');

// ---------- 分年度（樣本內） ----------
say('## ④ 選出版本的分年度表現（樣本內）', '');
for (const k of [...picks, 'O1']) {
  const isEv = events[k].filter(e => e.period === 'IS' && !e.censored);
  const years = [...new Set(isEv.map(e => e.date.slice(0, 4)))].sort();
  say(`**${k}**`, '', '| 年度 | 事件 | 翻倍率 | 平均報酬 | 勝率 |', '|---|---|---|---|---|');
  for (const y of years) {
    const s = tradeStats(isEv.filter(e => e.date.startsWith(y)));
    say(`| ${y} | ${s.n} | ${s.p100}% | ${s.avg}% | ${s.win}% |`);
  }
  const pos = years.filter(y => tradeStats(isEv.filter(e => e.date.startsWith(y))).avg > 0).length;
  say('', `平均報酬為正的年份：${pos} / ${years.length}`, '');
  const top = [...isEv].sort((a, b) => b.ret - a.ret).slice(0, 5);
  say('報酬最高的 5 筆：' + top.map(e => `${e.id}${universe[e.id].name}(${e.date}, ${r1(e.ret)}%)`).join('、'), '');
}

// ---------- 樣本外：只驗證選出的版本 ----------
const bOOS = bench(OOS_FROM, calEnd);
say(`## ⑤ 樣本外一次性驗證（${OOS_FROM}～${calEnd}）`, '',
  '只打開被選中的版本與對照組。**這是唯一一次查看樣本外**；之後若依這些數字修改規則，樣本外就不再是乾淨的驗證。', '',
  '| 版本 | 事件 | 翻倍率 | 先停損 | 勝率 | 平均報酬 | 中位報酬 | 組合年化 | 最大回檔 | 樣本內年化（對照） |',
  '|---|---|---|---|---|---|---|---|---|---|');
for (const k of [...picks, 'O1']) {
  const oo = events[k].filter(e => e.period === 'OOS');
  const t = tradeStats(oo), p = portfolio(oo, OOS_FROM, calEnd);
  say(`| ${k} | ${t.n} | ${t.p100 ?? '—'}% | ${t.stop ?? '—'}% | ${t.win ?? '—'}% | ${t.avg ?? '—'}% | ${t.med ?? '—'}% | ${p.cagr}% | ${p.mdd}% | ${res[k].p.cagr}% |`);
}
say(`| 加權指數（買進持有，不含股利） | — | — | — | — | — | — | ${bOOS.cagr}% | ${bOOS.mdd}% | ${bIS.cagr}% |`, '',
  '註：樣本外最後一年內的訊號尚未走完 250 天，逐筆統計不含它們，組合模擬則以最後一天收盤價結算。');

// 存檔
writeFileSync(`${DIR}/research/phase4-events.json`, JSON.stringify(Object.fromEntries(Object.entries(events).map(([k, v]) => [k, v.map(({ path, ...e }) => e)]))));
const out = md.join('\n');
console.log(out);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n');
