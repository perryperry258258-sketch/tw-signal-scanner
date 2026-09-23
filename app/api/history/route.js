import { CONSTITUENTS, MARKET_SYMBOLS } from '../../../lib/constituents.js';
import { CONFIG } from '../../../lib/config.js';
import { fetchDaily, taipeiNow, addDays } from '../../../lib/yahoo.js';
import { runSymbol, buildMarketMap, BACKTEST_COLUMNS, toCSVCols } from '../../../lib/backtest.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// 單一股票逐日回測資料（含未來 5/10/20/40/60 日最高漲幅、最低跌幅）
// GET /api/history?symbol=2330&from=2023-01-01&to=2026-09-22
// 選填：&minGrade=B（只輸出 A/B）、&format=json
export async function GET(req) {
  const sp = new URL(req.url).searchParams;
  const symbol = (sp.get('symbol') || '').trim();
  if (!/^\d{4,6}$/.test(symbol)) return Response.json({ error: 'symbol 例如 2330' }, { status: 400 });
  const to = sp.get('to') || taipeiNow().date;
  const from = sp.get('from') || addDays(to, -365);
  const minGrade = sp.get('minGrade');
  const fetchFrom = addDays(from, -CONFIG.WARMUP_DAYS);
  const name = CONSTITUENTS.find(c => c[0] === symbol)?.[1] || '';

  let stock, twii, etf;
  try {
    [stock, twii, etf] = await Promise.all([
      fetchDaily(`${symbol}.TW`, fetchFrom, to),
      fetchDaily(MARKET_SYMBOLS.TWII, fetchFrom, to).catch(() => null),
      fetchDaily(MARKET_SYMBOLS.ETF0050, fetchFrom, to).catch(() => null),
    ]);
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 502 });
  }

  const marketMap = buildMarketMap(twii?.bars, etf?.bars, from);
  let rows = runSymbol({ symbol, name, bars: stock.bars, marketMap, from, to });
  if (minGrade === 'A') rows = rows.filter(r => r.grade === 'A');
  if (minGrade === 'B') rows = rows.filter(r => r.grade !== '觀察');

  if (sp.get('format') === 'json') return Response.json({ symbol, name, from, to, count: rows.length, rows });
  return new Response(toCSVCols(rows, BACKTEST_COLUMNS), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="history_${symbol}_${from}_${to}.csv"`,
    },
  });
}
