import { CONSTITUENTS, CONSTITUENTS_UPDATED, MARKET_SYMBOLS } from '../../../lib/constituents.js';
import { CONFIG } from '../../../lib/config.js';
import { fetchDaily, mapLimit, taipeiNow, addDays } from '../../../lib/yahoo.js';
import { evaluateStock, evaluateMarket, sliceTo, toCSV } from '../../../lib/engine.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET /api/scan                 → 今天（最新收盤）
// GET /api/scan?date=2025-03-12 → 用「當時已知資料」重跑那一天
// 加 &format=csv 下載
export async function GET(req) {
  const sp = new URL(req.url).searchParams;
  const date = sp.get('date');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: 'date 格式要 YYYY-MM-DD' }, { status: 400 });
  const toDate = date || taipeiNow().date;
  const fromDate = addDays(toDate, -CONFIG.WARMUP_DAYS);

  const [twii, etf] = await Promise.all([
    fetchDaily(MARKET_SYMBOLS.TWII, fromDate, toDate).catch(() => null),
    fetchDaily(MARKET_SYMBOLS.ETF0050, fromDate, toDate).catch(() => null),
  ]);

  const results = await mapLimit(CONSTITUENTS, 8, async ([code, name]) => {
    const { bars } = await fetchDaily(`${code}.TW`, fromDate, toDate);
    if (bars.length < 60) throw new Error('資料太少');
    const row = evaluateStock(bars);
    const env = evaluateMarket(twii && sliceTo(twii.bars, row.date), etf && sliceTo(etf.bars, row.date));
    return { symbol: code, name, marketEnv: env.label, marketScore: env.score, ...row };
  });

  const rows = results.filter(r => r.ok).map(r => r.value);
  const errors = results.map((r, i) => (r.ok ? null : `${CONSTITUENTS[i][0]} ${CONSTITUENTS[i][1]}: ${r.error}`)).filter(Boolean);
  const order = { A: 0, B: 1, '觀察': 2 };
  rows.sort((a, b) => order[a.grade] - order[b.grade] || b.conditionsMet - a.conditionsMet || a.symbol.localeCompare(b.symbol));

  const asOf = rows.reduce((m, r) => (r.date > m ? r.date : m), '');
  const market = evaluateMarket(twii && sliceTo(twii.bars, asOf || toDate), etf && sliceTo(etf.bars, asOf || toDate));

  if (sp.get('format') === 'csv') {
    return new Response(toCSV(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="scan_${asOf || toDate}.csv"`,
      },
    });
  }

  return Response.json({
    requestedDate: toDate, asOf, market,
    droppedIntraday: !!(twii?.droppedIntraday),
    constituentsUpdated: CONSTITUENTS_UPDATED, constituentsCount: CONSTITUENTS.length,
    config: CONFIG, rows, errors,
  });
}
