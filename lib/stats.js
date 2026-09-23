// 統計摘要（瀏覽器端與伺服器端共用）
// 未來欄位只在這裡被「讀取做統計」，不會回頭影響任何訊號
export const HORIZONS = [5, 10, 20, 40, 60];
export const UP_LEVELS = [3, 5, 8, 10, 15];
export const DOWN_LEVELS = [3, 5, 8];
export const HIT_HORIZONS = [20, 60];
export const COND_NAMES = ['①週線交叉', '②月線多頭', '③收盤突破', '④前低完好', '⑤脫低未近高', '⑥突破量能', '⑦未追高'];
export const ENVS = ['多方', '震盪', '空方'];

const r2 = x => Math.round(x * 100) / 100;
const mean = a => (a.length ? r2(a.reduce((s, x) => s + x, 0) / a.length) : null);
const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return r2(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};
const rate = (hit, n) => (n ? Math.round((hit / n) * 1000) / 10 : null);

// items: [{ grade, isNewSignal, etf0050Env, conds, mfeN, maeN, retN }]
export function summarize(items) {
  const s = { count: items.length, avgMfe: {}, avgMae: {}, avgRet: {}, medRet: {}, win: {}, n: {}, up: {}, down: {} };
  for (const N of HORIZONS) {
    const mf = [], ma = [], rt = [];
    for (const x of items) {
      if (x[`mfe${N}`] != null) mf.push(x[`mfe${N}`]);
      if (x[`mae${N}`] != null) ma.push(x[`mae${N}`]);
      if (x[`ret${N}`] != null) rt.push(x[`ret${N}`]);
    }
    s.avgMfe[N] = mean(mf); s.avgMae[N] = mean(ma);
    s.avgRet[N] = mean(rt); s.medRet[N] = median(rt);
    s.win[N] = rate(rt.filter(v => v > 0).length, rt.length); // 收盤報酬 > 0 的比例
    s.n[N] = mf.length;
  }
  for (const H of HIT_HORIZONS) {
    const valid = items.filter(x => x[`mfe${H}`] != null);
    s.up[H] = {}; s.down[H] = {};
    for (const L of UP_LEVELS) s.up[H][L] = rate(valid.filter(x => x[`mfe${H}`] >= L).length, valid.length);
    for (const L of DOWN_LEVELS) s.down[H][L] = rate(valid.filter(x => x[`mae${H}`] <= -L).length, valid.length);
  }
  return s;
}

// 精簡版：診斷表用
export function lite(items) {
  const s = summarize(items);
  return {
    n: s.count, r20: s.avgRet[20], r60: s.avgRet[60], med60: s.medRet[60], win60: s.win[60],
    mfe60: s.avgMfe[60], mae60: s.avgMae[60], up10: s.up[60][10], dn8: s.down[60][8],
  };
}

const isMet = (x, k) => x.conds && x.conds[k] === '1';

// mode: 'new' = 只算新訊號（觀察→B/A、B→A 的第一天）；'daily' = 每個 A/B 日都算
export function buildReport(allDays, mode) {
  const isSig = x => x.grade !== '觀察' && (mode === 'daily' || x.isNewSignal);
  const sig = allDays.filter(isSig);
  const groupsOf = (sigs, days) => ({
    '全部訊號': sigs,
    'A級': sigs.filter(x => x.grade === 'A'),
    'B級': sigs.filter(x => x.grade === 'B'),
    '基準：所有交易日': days,
  });

  const byGroup = Object.fromEntries(Object.entries(groupsOf(sig, allDays)).map(([k, v]) => [k, summarize(v)]));

  const byEnv = {};
  for (const env of ENVS) {
    const g = groupsOf(sig.filter(x => x.etf0050Env === env), allDays.filter(x => x.etf0050Env === env));
    byEnv[env] = Object.fromEntries(Object.entries(g).map(([k, v]) => [k, summarize(v)]));
  }

  // ⑩a 單一條件：所有交易日中，該條件成立 vs 不成立
  const condAll = COND_NAMES.map((name, k) => ({
    name, yes: lite(allDays.filter(x => isMet(x, k))), no: lite(allDays.filter(x => !isMet(x, k))),
  }));

  // ⑩b 訊號中：該條件成立 vs 不成立（分環境）
  const condInSig = {};
  for (const env of ['全部', '多方', '震盪']) {
    const pool = env === '全部' ? sig : sig.filter(x => x.etf0050Env === env);
    condInSig[env] = COND_NAMES.map((name, k) => ({
      name, yes: lite(pool.filter(x => isMet(x, k))), no: lite(pool.filter(x => !isMet(x, k))),
    }));
  }

  // ⑩c A級依「缺哪一項」分組（A級最多缺 1 項）
  const aMissing = {};
  for (const env of ['全部', '多方', '震盪']) {
    const pool = sig.filter(x => x.grade === 'A' && (env === '全部' || x.etf0050Env === env));
    const buckets = new Map([['7項全符合', []], ...COND_NAMES.map(n => ['缺' + n, []])]);
    for (const x of pool) {
      const miss = COND_NAMES.findIndex((_, k) => !isMet(x, k));
      buckets.get(miss < 0 ? '7項全符合' : '缺' + COND_NAMES[miss]).push(x);
    }
    aMissing[env] = [...buckets].map(([name, v]) => ({ name, ...lite(v) }));
  }

  // ⑪ 分年度
  const years = [...new Set(allDays.map(x => x.date.slice(0, 4)))].sort();
  const byYear = years.map(y => {
    const g = groupsOf(sig.filter(x => x.date.startsWith(y)), allDays.filter(x => x.date.startsWith(y)));
    return { year: y, groups: Object.fromEntries(Object.entries(g).map(([k, v]) => [k, lite(v)])) };
  });

  return { mode, totalDays: allDays.length, byGroup, byEnv, condAll, condInSig, aMissing, byYear };
    }
