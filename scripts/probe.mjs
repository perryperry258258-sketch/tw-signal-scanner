// Phase 1：FinMind 資料源檢查（只讀取、不下載大量資料）
// 目的：確認免費帳號能用哪些資料、最早到哪一年、有沒有下市股票
// 注意：絕對不印出 token
import { appendFileSync } from 'node:fs';

const TOKEN = process.env.FINMIND_TOKEN || '';
const API = 'https://api.finmindtrade.com/api/v4/data';
const rows = [];   // 摘要表：[項目, 結果, 說明]
const notes = [];  // 詳細資料

async function q(dataset, params = {}) {
  const u = new URL(API);
  u.searchParams.set('dataset', dataset);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  try {
    const res = await fetch(u, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch { return { ok: false, msg: `HTTP ${res.status} 非JSON回應`, data: [] }; }
    const data = Array.isArray(j.data) ? j.data : [];
    const ok = res.ok && j.status !== 402 && j.status !== 400 && Array.isArray(j.data);
    return { ok, msg: j.msg || `HTTP ${res.status}`, data };
  } catch (e) {
    return { ok: false, msg: String(e.message || e), data: [] };
  }
}

const dates = d => d.map(r => r.date).filter(Boolean).sort();
const span = d => { const s = dates(d); return s.length ? `${s[0]} ～ ${s[s.length - 1]}` : '無日期欄位'; };
const keys = d => (d.length ? Object.keys(d[0]).join(', ') : '（無資料）');
const add = (item, ok, info) => rows.push([item, ok ? '✅' : '❌', info]);
const note = (title, obj) => notes.push(`**${title}**\n\n\`\`\`\n${typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1)}\n\`\`\``);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  if (!TOKEN) {
    add('Token 設定', false, '讀不到 FINMIND_TOKEN，請確認 GitHub Secrets 名稱完全一致');
    return;
  }
  add('Token 設定', true, '已讀到（內容不顯示）');

  // 0. 帳號額度
  try {
    const r = await fetch('https://api.web.finmindtrade.com/v2/user_info', { headers: { Authorization: `Bearer ${TOKEN}` } });
    const j = await r.json();
    add('帳號額度', r.ok, `每小時上限：${j.api_request_limit ?? '未知'}｜已使用：${j.user_count ?? '未知'}`);
  } catch (e) { add('帳號額度', false, String(e.message || e)); }

  // 1. 股票清單
  const info = await q('TaiwanStockInfo');
  const byType = {};
  for (const r of info.data) byType[r.type] = (byType[r.type] || 0) + 1;
  add('股票清單 TaiwanStockInfo', info.ok, info.ok ? `共 ${info.data.length} 筆｜市場別：${JSON.stringify(byType)}` : info.msg);
  note('TaiwanStockInfo 欄位', keys(info.data));

  // 2. 下市櫃清單
  const del = await q('TaiwanStockDelisting');
  add('下市櫃清單 TaiwanStockDelisting', del.ok && del.data.length > 0, del.ok ? `共 ${del.data.length} 筆｜期間 ${span(del.data)}` : del.msg);
  note('TaiwanStockDelisting 欄位與前3筆', { keys: keys(del.data), sample: del.data.slice(0, 3) });

  // 3. 台積電原始股價：最早到哪一年
  const p = await q('TaiwanStockPrice', { data_id: '2330', start_date: '1990-01-01' });
  add('原始股價 TaiwanStockPrice（2330）', p.ok && p.data.length > 0, p.ok ? `${p.data.length} 筆｜${span(p.data)}` : p.msg);
  note('TaiwanStockPrice 欄位', keys(p.data));

  // 4. 上櫃股票（環球晶 6488）
  const otc = await q('TaiwanStockPrice', { data_id: '6488', start_date: '1990-01-01' });
  add('上櫃股價（6488）', otc.ok && otc.data.length > 0, otc.ok ? `${otc.data.length} 筆｜${span(otc.data)}` : otc.msg);

  // 5. 加權指數
  const tx = await q('TaiwanStockPrice', { data_id: 'TAIEX', start_date: '1990-01-01' });
  add('加權指數（TAIEX）', tx.ok && tx.data.length > 0, tx.ok ? `${tx.data.length} 筆｜${span(tx.data)}` : tx.msg);

  // 6. 已下市股票的歷史股價（抽 3 檔 2010～2020 下市的）
  const idKey = del.data.length ? Object.keys(del.data[0]).find(k => /stock_id/i.test(k)) : null;
  const picks = del.data.filter(r => r.date >= '2010-01-01' && r.date <= '2020-12-31').slice(0, 3);
  if (!idKey || !picks.length) add('下市股票的歷史股價', false, '找不到可抽樣的下市股票');
  for (const r of picks) {
    await sleep(300);
    const dp = await q('TaiwanStockPrice', { data_id: r[idKey], start_date: '2000-01-01' });
    add(`下市股票股價（${r[idKey]}，${r.date}下市）`, dp.ok && dp.data.length > 0, dp.ok ? `${dp.data.length} 筆｜${span(dp.data)}` : dp.msg);
  }

  // 7. 單日全市場（免費帳號可能不支援）
  const all = await q('TaiwanStockPrice', { start_date: '2026-09-22', end_date: '2026-09-22' });
  add('單日全市場股價（不指定代號）', all.ok && all.data.length > 100, all.ok ? `${all.data.length} 筆` : all.msg);

  // 8. 付費資料集：確認免費帳號是否可用
  const adj = await q('TaiwanStockPriceAdj', { data_id: '2330', start_date: '2024-01-01' });
  add('還原股價 TaiwanStockPriceAdj', adj.ok && adj.data.length > 0, adj.ok ? `${adj.data.length} 筆` : adj.msg);
  const mv = await q('TaiwanStockMarketValue', { data_id: '2330', start_date: '2024-01-01' });
  add('市值表 TaiwanStockMarketValue', mv.ok && mv.data.length > 0, mv.ok ? `${mv.data.length} 筆` : mv.msg);

  // 9. 發行股數（算市值用）
  const sh = await q('TaiwanStockShareholding', { data_id: '2330', start_date: '1990-01-01' });
  const hasShares = sh.data.length > 0 && Object.keys(sh.data[0]).some(k => /SharesIssued/i.test(k));
  add('外資持股表（含發行股數）', sh.ok && hasShares, sh.ok ? `${sh.data.length} 筆｜${span(sh.data)}｜發行股數欄位：${hasShares ? '有' : '沒有'}` : sh.msg);
  note('TaiwanStockShareholding 欄位', keys(sh.data));

  // 10. 自己做還原價需要的公司行動資料
  const dr = await q('TaiwanStockDividendResult', { data_id: '2330', start_date: '1990-01-01' });
  add('除權息結果 TaiwanStockDividendResult', dr.ok && dr.data.length > 0, dr.ok ? `${dr.data.length} 筆｜${span(dr.data)}` : dr.msg);
  note('TaiwanStockDividendResult 欄位與第1筆', { keys: keys(dr.data), sample: dr.data[0] });

  const cr = await q('TaiwanStockCapitalReductionReferencePrice', { start_date: '2000-01-01' });
  add('減資參考價', cr.ok && cr.data.length > 0, cr.ok ? `${cr.data.length} 筆｜${span(cr.data)}` : cr.msg);
  note('減資參考價 欄位', keys(cr.data));

  const sp = await q('TaiwanStockSplitPrice', { start_date: '2000-01-01' });
  add('分割參考價', sp.ok, sp.ok ? `${sp.data.length} 筆｜${span(sp.data)}` : sp.msg);

  const pv = await q('TaiwanStockParValueChange', { start_date: '2000-01-01' });
  add('變更面額參考價', pv.ok, pv.ok ? `${pv.data.length} 筆｜${span(pv.data)}` : pv.msg);
}

await main();

const md = [
  '# Phase 1 資料源檢查結果',
  '',
  '| 項目 | 結果 | 說明 |',
  '|---|---|---|',
  ...rows.map(r => `| ${r[0]} | ${r[1]} | ${String(r[2]).replace(/\|/g, '/')} |`),
  '',
  '## 詳細欄位',
  '',
  ...notes,
].join('\n');

console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
