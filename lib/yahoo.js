import { CONFIG } from './config.js';

const TPE = 8 * 3600;

export function tpeDate(tsSec) {
  return new Date((tsSec + TPE) * 1000).toISOString().slice(0, 10);
}

export function taipeiNow() {
  const d = new Date(Date.now() + TPE * 1000);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 抓日K。toDate 之後的資料「根本不抓」，歷史日期查詢時從源頭避免未來函數
export async function fetchDaily(symbol, fromDate, toDate) {
  const p1 = Math.floor(Date.parse(fromDate + 'T00:00:00+08:00') / 1000);
  const p2 = Math.floor(Date.parse(toDate + 'T23:59:59+08:00') / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplit&includeAdjustedClose=true`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`${symbol} HTTP ${res.status}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r || !r.timestamp) throw new Error(`${symbol} 無資料`);
  const q = r.indicators.quote[0];
  const adj = r.indicators.adjclose?.[0]?.adjclose;

  const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if ([o, h, l, c].some(x => x == null || !isFinite(x)) || c <= 0) continue;
    const date = tpeDate(r.timestamp[i]);
    if (date > toDate) continue;
    const f = CONFIG.ADJUSTED && adj && adj[i] ? adj[i] / c : 1;
    const bar = {
      date, open: o * f, high: h * f, low: l * f, close: c * f,
      rawClose: c, volume: q.volume[i] || 0,
    };
    if (bars.length && bars[bars.length - 1].date === date) bars[bars.length - 1] = bar;
    else bars.push(bar);
  }

  // 盤中（14:30 前）抓到的「今日K」不是收盤價，直接丟掉，避免把盤中突破當成收盤突破
  const now = taipeiNow();
  let droppedIntraday = false;
  if (bars.length && bars[bars.length - 1].date === now.date && now.minutes < 14 * 60 + 30) {
    bars.pop();
    droppedIntraday = true;
  }
  return { bars, droppedIntraday };
}

// 併發上限，避免一次打 50 個請求被擋
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = { ok: true, value: await fn(items[i], i) }; }
      catch (e) { out[i] = { ok: false, error: String(e.message || e) }; }
    }
  });
  await Promise.all(workers);
  return out;
}
