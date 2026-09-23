import { CONSTITUENTS, MARKET_SYMBOLS } from '../../../lib/constituents.js';
import { CONFIG } from '../../../lib/config.js';
import { fetchDaily, taipeiNow, addDays } from '../../../lib/yahoo.js';
import { runSymbol, buildMarketMap, HORIZONS } from '../../../lib/backtest.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// 批次回測：/api/backtest?symbols=2330,2317,2454&from=2023-01-01&to=2026-09-23
// 回傳：days = 每個交易日的精簡資料（算統計用）；signals = A/B 日的完整欄位（下載CSV用）
export async function GET(req) {
  const sp = new URL(req.url).searchParams;
  const symbols = (sp.get('symbols') || '').split(',').map(s => s.trim()).filter(s => /^\d{4,6}$/.test(s)).slice(0, 8);
  if (!symbols.length) return Response.json({ error: 'symbols 例如 2330,2317' }, { status: 400 });
  const to = sp.get('to') || taipeiNow().date;
  const from = sp.get('from') || '2023-01-01';
  const fetchFrom = addDays(from, -CONFIG.WARMUP_DAYS);

  const [twii, etf] = await Promise.all([
    fetchDaily(MARKET_SYMBOLS.TWII, fetchFrom, to).catch(() => null),
    fetchDaily(MARKET_SYMBOLS.ETF0050, fetchFrom, to).catch(() => null),
  ]);
  const marketMap = buildMarketMap(twii?.bars, etf?.bars, from);

  const days = [], signals = [], errors = [];
  for (const code of symbols) {
    try {
      const { bars } = await fetchDaily(`${code}.TW`, fetchFrom, to);
      const name = CONSTITUENTS.find(c => c[0] === code)?.[1] || '';
      const rows = runSymbol({ symbol: code, name, bars, marketMap, from, to });
      for (const r of rows) {
        days.push([r.symbol, r.signalDate, r.grade, r.isNewSignal ? 1 : 0, r.etf0050Env, ...HORIZONS.flatMap(N => [r[`mfe${N}`], r[`mae${N}`]])]);
        if (r.grade !== '觀察') signals.push(r);
      }
    } catch (e) {
      errors.push(`${code}: ${e.message || e}`);
    }
  }
  return Response.json({ from, to, symbols, days, signals, errors });
}
