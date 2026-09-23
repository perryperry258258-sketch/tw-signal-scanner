import { CONFIG } from '../../../lib/config.js';
import { fetchDaily, taipeiNow, addDays } from '../../../lib/yahoo.js';
import { runChecks, pickTestIndices, compareSourceTruncation } from '../../../lib/lookahead.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// 用真實資料跑 Look-ahead Bias Check（台積電、富邦金、聯發科）
export async function GET() {
  const today = taipeiNow().date;
  const from = addDays(today, -4 * 365);
  const symbols = ['2330', '2881', '2454'];
  const merged = new Map();
  const errors = [];

  for (const code of symbols) {
    try {
      const { bars } = await fetchDaily(`${code}.TW`, from, today);
      for (const t of runChecks(code, bars)) {
        const m = merged.get(t.id) || { id: t.id, name: t.name, checked: 0, failures: [] };
        m.checked += t.checked;
        m.failures.push(...t.failures);
        merged.set(t.id, m);
      }
      // T10：資料來源截斷（只抓到當天）vs 完整資料切到當天
      if (code === '2330') {
        const m = { id: 'T10', name: '資料源頭截斷：只抓到當天的資料，與完整資料切到當天，訊號相同', checked: 0, failures: [] };
        const idx = pickTestIndices(bars, 3);
        for (const i of idx) {
          const date = bars[i].date;
          const trunc = await fetchDaily(`${code}.TW`, addDays(date, -CONFIG.WARMUP_DAYS), date);
          const r = compareSourceTruncation(code, date, trunc.bars, bars);
          m.checked++;
          if (!r.ok) m.failures.push(r.msg);
        }
        merged.set('T10', m);
      }
    } catch (e) {
      errors.push(`${code}: ${e.message || e}`);
    }
  }

  const tests = [...merged.values()].map(t => ({ ...t, pass: t.checked > 0 && t.failures.length === 0 }));
  const overall = tests.length > 0 && errors.length === 0 && tests.every(t => t.pass) ? 'PASS' : 'FAIL';
  return Response.json({ overall, runAt: new Date().toISOString(), symbols, maMode: CONFIG.MA_MODE, tests, errors });
}
