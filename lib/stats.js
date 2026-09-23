// 統計摘要（瀏覽器端與伺服器端共用）
// 未來欄位只在這裡被「讀取做統計」，不會回頭影響任何訊號
export const HORIZONS = [5, 10, 20, 40, 60];
export const UP_LEVELS = [3, 5, 8, 10, 15];
export const DOWN_LEVELS = [3, 5, 8];
export const HIT_HORIZONS = [20, 60];

const mean = a => (a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 100) / 100 : null);
const rate = (hit, n) => (n ? Math.round((hit / n) * 1000) / 10 : null);

// items: [{ grade, isNewSignal, etf0050Env, mfe5..mfe60, mae5..mae60 }]
export function summarize(items) {
  const s = { count: items.length, avgMfe: {}, avgMae: {}, n: {}, up: {}, down: {} };
  for (const N of HORIZONS) {
    const mf = items.map(x => x[`mfe${N}`]).filter(v => v != null);
    const ma = items.map(x => x[`mae${N}`]).filter(v => v != null);
    s.avgMfe[N] = mean(mf); s.avgMae[N] = mean(ma); s.n[N] = mf.length;
  }
  for (const H of HIT_HORIZONS) {
    const valid = items.filter(x => x[`mfe${H}`] != null);
    s.up[H] = {}; s.down[H] = {};
    for (const L of UP_LEVELS) s.up[H][L] = rate(valid.filter(x => x[`mfe${H}`] >= L).length, valid.length);
    for (const L of DOWN_LEVELS) s.down[H][L] = rate(valid.filter(x => x[`mae${H}`] <= -L).length, valid.length);
  }
  return s;
}

// mode: 'new' = 只算新訊號（觀察→B/A、B→A 的第一天）；'daily' = 每個 A/B 日都算
export function buildReport(allDays, mode) {
  const isSig = x => x.grade !== '觀察' && (mode === 'daily' || x.isNewSignal);
  const sig = allDays.filter(isSig);
  const g = {
    '全部訊號': sig,
    'A級': sig.filter(x => x.grade === 'A'),
    'B級': sig.filter(x => x.grade === 'B'),
    '基準：所有交易日': allDays,
  };
  const byGroup = Object.fromEntries(Object.entries(g).map(([k, v]) => [k, summarize(v)]));
  const byEnv = {};
  for (const env of ['多方', '震盪', '空方']) {
    byEnv[env] = {
      '全部訊號': summarize(sig.filter(x => x.etf0050Env === env)),
      'A級': summarize(sig.filter(x => x.etf0050Env === env && x.grade === 'A')),
      'B級': summarize(sig.filter(x => x.etf0050Env === env && x.grade === 'B')),
      '基準：所有交易日': summarize(allDays.filter(x => x.etf0050Env === env)),
    };
  }
  return { mode, totalDays: allDays.length, byGroup, byEnv };
}
