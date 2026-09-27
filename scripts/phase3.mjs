// ============================================================
// Phase 3：快速引擎驗證 ＋ 飆股解剖（只看樣本內 2005～2016）
// 1. 驗證：快速引擎 vs 舊引擎逐筆比對；擾動未來資料測試
// 2. 權值股名單內的每一天：計算特徵，並模擬「隔天開盤進場、結構停損、追蹤 250 日」
// 3. 報告只顯示 2005～2016（樣本內）；2017 之後（樣本外）先封存，最後才驗證
// ============================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { evaluateStock } from '../lib/engine.js';
import { computeFeatures, outcomeAt, marketEnv } from './features.mjs';

const DIR = 'data';
const IS_FROM = '2005-01-01', IS_TO = '2016-12-31', OOS_FROM = '2017-01-01';
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

const taiex = readBars(`${DIR}/index/TAIEX.csv`);
const calEnd = taiex.at(-1).date;
const env = marketEnv(taiex);
const universe = readJSON(`${DIR}/meta/universe.json`, { stocks: {} }).stocks;
const gapCls = readJSON(`${DIR}/meta/gap-classes.json`, []);
const gapsBy = {};
for (const g of gapCls) if (g.cls !== '上市初期') (gapsBy[g.id] ??= []).push(g.date);
const ids = Object.keys(universe).sort();

// ============================================================
// 1. 驗證
// ============================================================
const COND = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'grade'];
let cmpN = 0, cmpBad = 0; const cmpEx = [];
let ptN = 0, ptBad = 0, ptFwdSame = 0; const ptEx = [];
const sampleIds = ids.filter((_, k) => k % Math.max(1, Math.floor(ids.length / 20)) === 0).slice(0, 20);
for (const [si, id] of sampleIds.entries()) {
  const bars = readBars(`${DIR}/adjusted/${id}.csv`);
  if (bars.length < 400) continue;
  const fast = computeFeatures(bars, env);
  for (let k = 0; k < 15; k++) {
    const i = Math.round(60 + ((bars.length - 61) * k) / 14);
    const old = evaluateStock(bars.slice(0, i + 1));
    cmpN++;
    const diff = COND.filter(c => old[c] !== fast[i][c]);
    if (diff.length) { cmpBad++; if (cmpEx.length < 10) cmpEx.push(`${id} ${bars[i].date}：${diff.map(c => `${c} 舊=${old[c]} 新=${fast[i][c]}`).join('，')}`); }
  }
  if (si < 6) {
    for (let k = 1; k <= 4; k++) {
      const t = Math.round((bars.length * k) / 5);
      if (t + 260 >= bars.length) continue;
      const pert = bars.map((b, j) => (j <= t ? b : { ...b, open: b.open * 1.7, high: b.high * 2.1, low: b.low * 0.4, close: b.close * 1.9, volume: b.volume * 9, money: b.money * 9 }));
      const f2 = computeFeatures(pert, env);
      ptN++;
      const a = JSON.stringify(fast[t]), b = JSON.stringify(f2[t]);
      if (a !== b) { ptBad++; if (ptEx.length < 5) ptEx.push(`${id} ${bars[t].date}`); }
      const o1 = outcomeAt(bars, t, fast[t].baseLow, 250, calEnd), o2 = outcomeAt(pert, t, f2[t].baseLow, 250, calEnd);
      if (JSON.stringify(o1) === JSON.stringify(o2)) ptFwdSame++;
    }
  }
}
const pass1 = cmpN > 0 && cmpBad === 0, pass2 = ptN > 0 && ptBad === 0, pass3 = ptN > 0 && ptFwdSame === 0;
say('# Phase 3：快速引擎驗證 ＋ 飆股解剖（樣本內 2005～2016）', '');
say('## ① 快速引擎驗證', '', '| 檢查 | 結果 | 說明 |', '|---|---|---|');
say(`| 新舊引擎逐筆比對（7項條件＋等級） | ${pass1 ? '✅ PASS' : '❌ FAIL'} | ${cmpN} 筆，不一致 ${cmpBad} 筆 |`);
say(`| 擾動未來資料，當天特徵不變 | ${pass2 ? '✅ PASS' : '❌ FAIL'} | ${ptN} 筆，改變 ${ptBad} 筆 |`);
say(`| 擾動未來資料，未來結果會改變（確認結果只來自未來） | ${pass3 ? '✅ PASS' : '❌ FAIL'} | ${ptN} 筆，沒變 ${ptFwdSame} 筆 |`);
if (cmpEx.length) say('', '不一致範例：', ...cmpEx.map(x => `- ${x}`));
if (ptEx.length) say('', '擾動後改變的範例：', ...ptEx.map(x => `- ${x}`));

// ============================================================
// 2. 逐日特徵 ＋ 結果
// ============================================================
const rows = [];
let excludedGap = 0;
for (const id of ids) {
  const bars = readBars(`${DIR}/adjusted/${id}.csv`);
  if (bars.length < 300) continue;
  const f = computeFeatures(bars, env);
  const idx = new Map(bars.map((b, i) => [b.date, i]));
  const gIdx = (gapsBy[id] || []).map(d => idx.get(d)).filter(x => x != null);
  for (const [a, b] of universe[id].segs) {
    const ia = idx.get(a), ib = idx.get(b);
    if (ia == null || ib == null) continue;
    for (let t = Math.max(ia, 250); t <= ib; t++) {
      const date = bars[t].date;
      if (date < IS_FROM) continue;
      if (gIdx.some(g => g > t - 250 && g <= t + 250)) { excludedGap++; continue; }
      const o = outcomeAt(bars, t, f[t].baseLow, 250, calEnd);
      const x = f[t];
      rows.push({
        id, date, t, period: date <= IS_TO ? 'IS' : 'OOS',
        grade: x.grade, met: x.met, env: x.env, brk20: x.brk20, brkBase40: x.brkBase40, brkBase30: x.brkBase30, bLen40: x.bLen40,
        nh1: x.newHigh1y, nh2: x.newHigh2y, nh3: x.newHigh3y, vc: x.volContract, dry: x.dryUp, mr: x.moneyRatio,
        fH52: x.fH52, fL52: x.fL52, ret60: x.ret60, c: [x.c1, x.c2, x.c3, x.c4, x.c5, x.c6, x.c7],
        status: o.status, stopPct: o.stopPct, exitRet: o.exitRet, mfe: o.mfe, reason: o.reason,
        h50: o.hit?.[0] != null, h100: o.hit?.[1] != null, h200: o.hit?.[2] != null,
      });
    }
  }
}

// 全部資料存檔（含樣本外，供最後驗證使用）
const cols = ['id', 'date', 'period', 'grade', 'met', 'env', 'brk20', 'brkBase40', 'brkBase30', 'bLen40', 'nh1', 'nh2', 'nh3', 'vc', 'dry', 'mr', 'fH52', 'fL52', 'ret60', 'status', 'stopPct', 'exitRet', 'mfe', 'reason', 'h50', 'h100', 'h200'];
const fmt = v => (typeof v === 'number' ? (isFinite(v) ? Math.round(v * 10000) / 10000 : '') : v === true ? 1 : v === false ? 0 : v ?? '');
const csv = [cols.join(',') + ',conds', ...rows.map(r => cols.map(c => fmt(r[c])).join(',') + ',' + r.c.map(v => (v === true ? 1 : v === false ? 0 : '-')).join(''))].join('\n');
writeFileSync(`${DIR}/research/days.csv.gz`, gzipSync(csv));

// ============================================================
// 3. 樣本內統計
// ============================================================
const IS = rows.filter(r => r.period === 'IS');
const done = IS.filter(r => r.status === 'done');
const pctf = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
function stat(rs) {
  const n = rs.length;
  if (!n) return null;
  const ex = rs.map(r => r.exitRet);
  return {
    n, p50: pctf(rs.filter(r => r.h50).length, n), p100: pctf(rs.filter(r => r.h100).length, n), p200: pctf(rs.filter(r => r.h200).length, n),
    stop: pctf(rs.filter(r => r.reason === 'stop').length, n),
    avg: Math.round((ex.reduce((a, b) => a + b, 0) / n) * 1000) / 10, med: Math.round(med(ex) * 1000) / 10,
  };
}
const base = stat(done);
say('', '## ② 樣本', '', '| 項目 | 數值 |', '|---|---|',
  `| 樣本內權值股天數（2005～2016） | ${IS.length.toLocaleString()} |`,
  `| 因資料跳空排除 | ${excludedGap.toLocaleString()}（全期間） |`,
  `| 隔天開盤漲停買不到 | ${IS.filter(r => r.status === 'unfilled').length.toLocaleString()} |`,
  `| 有完整結果、納入統計 | ${done.length.toLocaleString()} |`,
  `| 樣本外（2017 之後）天數 | ${rows.filter(r => r.period === 'OOS').length.toLocaleString()}（封存，不列入本報告） |`);

say('', '## ③ 基準：權值股隨便哪一天買進', '',
  '規則：隔天開盤買進；停損 = 整理區間低點，但最多 -15%；追蹤 250 個交易日。同一天同時碰到目標與停損，一律算先停損。報酬已扣交易成本 0.6%。', '',
  '| 250日內先達 +50% | 先達 +100% | 先達 +200% | 先停損 | 平均報酬 | 中位報酬 |', '|---|---|---|---|---|---|',
  `| ${base.p50}% | ${base.p100}% | ${base.p200}% | ${base.stop}% | ${base.avg}% | ${base.med}% |`);

// 飆股案例：同一檔 250 日內只取一次，依最大漲幅排序
const eps = [];
const byStock = {};
for (const r of done.filter(r => r.h100)) (byStock[r.id] ??= []).push(r);
for (const [id, rs] of Object.entries(byStock)) {
  rs.sort((a, b) => b.mfe - a.mfe);
  const taken = [];
  for (const r of rs) if (!taken.some(x => Math.abs(x.t - r.t) < 250)) taken.push(r);
  eps.push(...taken);
}
eps.sort((a, b) => b.mfe - a.mfe);
say('', `## ④ 樣本內飆股案例（先達 +100% 才停損以前，共 ${eps.length} 段，列前 30）`, '',
  '| 股票 | 最佳進場日 | 最大漲幅 | 大盤 | 當天舊策略等級 | 突破整理區間 | 整理天數 |', '|---|---|---|---|---|---|---|',
  ...eps.slice(0, 30).map(r => `| ${r.id}${universe[r.id].name} | ${r.date} | +${Math.round(r.mfe * 100)}% | ${r.env ?? '—'} | ${r.grade} | ${r.brkBase40 ? '是' : '否'} | ${r.bLen40} |`));

// 條件分組
const groups = [
  ['舊策略等級', [['A級', r => r.grade === 'A'], ['B級', r => r.grade === 'B'], ['觀察', r => r.grade === '觀察']]],
  ['大盤環境（加權指數）', [['多方', r => r.env === '多方'], ['震盪', r => r.env === '震盪'], ['空方', r => r.env === '空方']]],
  ['收盤突破 20 日高', [['是', r => r.brk20], ['否', r => !r.brk20]]],
  ['突破整理區間（40% 內、≥60 天）', [['是', r => r.brkBase40], ['否', r => !r.brkBase40]]],
  ['突破整理區間：整理天數', [['60～119 天', r => r.brkBase40 && r.bLen40 < 120], ['120～249 天', r => r.brkBase40 && r.bLen40 >= 120 && r.bLen40 < 250], ['250～499 天', r => r.brkBase40 && r.bLen40 >= 250 && r.bLen40 < 500], ['500 天以上', r => r.brkBase40 && r.bLen40 >= 500]]],
  ['突破較窄的整理區間（30% 內、≥60 天）', [['是', r => r.brkBase30]]],
  ['收盤創新高', [['3 年新高', r => r.nh3], ['2 年新高（非 3 年）', r => r.nh2 && !r.nh3], ['1 年新高（非 2 年）', r => r.nh1 && !r.nh2], ['沒有創 1 年新高', r => !r.nh1]]],
  ['波動收縮（20日÷120日振幅）', [['< 0.7', r => r.vc < 0.7], ['0.7～0.9', r => r.vc >= 0.7 && r.vc < 0.9], ['0.9～1.1', r => r.vc >= 0.9 && r.vc < 1.1], ['≥ 1.1', r => r.vc >= 1.1]]],
  ['量縮（前20日÷前250日成交值）', [['< 0.6', r => r.dry < 0.6], ['0.6～0.9', r => r.dry >= 0.6 && r.dry < 0.9], ['0.9～1.3', r => r.dry >= 0.9 && r.dry < 1.3], ['≥ 1.3', r => r.dry >= 1.3]]],
  ['突破日量能（只看收盤突破20日高）', [['< 1 倍', r => r.brk20 && r.mr < 1], ['1～2 倍', r => r.brk20 && r.mr >= 1 && r.mr < 2], ['2～3 倍', r => r.brk20 && r.mr >= 2 && r.mr < 3], ['≥ 3 倍', r => r.brk20 && r.mr >= 3]]],
  ['距 52 週低點', [['< 15%', r => r.fL52 < 0.15], ['15～40%', r => r.fL52 >= 0.15 && r.fL52 < 0.4], ['40～80%', r => r.fL52 >= 0.4 && r.fL52 < 0.8], ['≥ 80%', r => r.fL52 >= 0.8]]],
  ['距 52 週高點', [['-5% 以內', r => r.fH52 >= -0.05], ['-5～-15%', r => r.fH52 < -0.05 && r.fH52 >= -0.15], ['-15～-30%', r => r.fH52 < -0.15 && r.fH52 >= -0.3], ['-30% 以下', r => r.fH52 < -0.3]]],
  ['近 60 日漲幅', [['< 0%', r => r.ret60 < 0], ['0～20%', r => r.ret60 >= 0 && r.ret60 < 0.2], ['20～50%', r => r.ret60 >= 0.2 && r.ret60 < 0.5], ['≥ 50%', r => r.ret60 >= 0.5]]],
  ['停損距離', [['0～-5%', r => r.stopPct >= -0.05], ['-5～-10%', r => r.stopPct < -0.05 && r.stopPct >= -0.1], ['-10～-15%', r => r.stopPct < -0.1]]],
  ['事先設定的組合（假設）', [
    ['突破整理區間 ＋ 2 年新高', r => r.brkBase40 && r.nh2],
    ['突破整理區間 ＋ 大盤多方', r => r.brkBase40 && r.env === '多方'],
    ['突破整理區間 ＋ 突破日量能 ≥ 2 倍', r => r.brkBase40 && r.mr >= 2],
    ['突破整理區間 ＋ 舊策略 B 級以上', r => r.brkBase40 && r.grade !== '觀察'],
    ['3 年新高 ＋ 大盤多方', r => r.nh3 && r.env === '多方'],
  ]],
];
say('', '## ⑤ 條件分析（樣本內）', '',
  '倍率 = 該條件的「先達 +100%」機率 ÷ 基準機率。大於 1 代表比隨便買好。注意：同一段行情會連續很多天符合條件，天數不是獨立事件。', '');
for (const [title, bs] of groups) {
  say(`**${title}**`, '', '| 條件 | 天數 | +50% | +100% | +200% | 先停損 | 平均報酬 | 倍率 |', '|---|---|---|---|---|---|---|---|');
  for (const [name, fn] of bs) {
    const s = stat(done.filter(fn));
    if (!s) { say(`| ${name} | 0 | — | — | — | — | — | — |`); continue; }
    say(`| ${name} | ${s.n.toLocaleString()} | ${s.p50}% | ${s.p100}% | ${s.p200}% | ${s.stop}% | ${s.avg}% | ${base.p100 ? Math.round((s.p100 / base.p100) * 100) / 100 : '—'} |`);
  }
  say('');
}
say('## ⑥ 樣本外（2017 之後）', '', '已計算並封存，**本報告不顯示**。等條件在樣本內確定後，只打開一次做最終驗證。');

const out = md.join('\n');
console.log(out);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n');
