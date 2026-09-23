import { CONSTITUENTS, MARKET_SYMBOLS } from '../../../lib/constituents.js';
import { CONFIG } from '../../../lib/config.js';
import { fetchDaily, taipeiNow, addDays } from '../../../lib/yahoo.js';
import { evaluateStock, evaluateMarket, sliceTo, toCSV } from '../../../lib/engine.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// 回測用：逐日重算，每一天都只用「那天以前」的資料
// GET /api/history?symbol=2330&from=2023-01-01&to=2026-09-22
// 選填：&minGrade=B（只輸出 A/B）、&format=json
export async function GET(req) {
  const sp = new URL(req.url).searchParams;
  const symbol = (sp.get('symbol') || '').trim();
  if (!/^\d{4,6}$/.test(symbol)) return Response.json({ error: 'symbol 例如 2330' }, { status: 400 });
  const today = taipeiNow().date;
  const to = sp.get('to') || today;
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

  const bars = stock.bars;
  const rows = [];
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date < from || i < 60) continue;
    const row = evaluateStock(bars.slice(0, i + 1)); // 只給到當天為止
    if (minGrade === 'A' && row.grade !== 'A') continue;
    if (minGrade === 'B' && row.grade === '觀察') continue;
    const env = evaluateMarket(twii && sliceTo(twii.bars, row.date), etf && sliceTo(etf.bars, row.date));
    rows.push({ symbol, name, marketEnv: env.label, marketScore: env.score, ...row });
  }

  if (sp.get('format') === 'json') return Response.json({ symbol, name, from, to, count: rows.length, rows });
  return new Response(toCSV(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="history_${symbol}_${from}_${to}.csv"`,
    },
  });
}
