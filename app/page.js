'use client';
import { useState, useEffect } from 'react';

const ENV_COLOR = { '多方': '#e5484d', '震盪': '#f5a524', '空方': '#30a46c', '資料不足': '#888' }; // 台股紅漲綠跌
const GRADE_COLOR = { A: '#e5484d', B: '#f5a524', '觀察': '#666' };
const COND = ['①週線剛黃金交叉', '②月線無死叉', '③收盤突破前高', '④前低結構完好', '⑤脫離低點未近高', '⑥突破量能', '⑦未追高'];
const fmtPct = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`);
const box = { background: '#171a21', borderRadius: 12, padding: 12, marginBottom: 10 };

export default function Home() {
  const [date, setDate] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('AB');
  const [open, setOpen] = useState({});

  async function run() {
    setLoading(true); setErr('');
    try {
      const res = await fetch('/api/scan' + (date ? `?date=${date}` : ''));
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      setData(j);
    } catch (e) { setErr(String(e.message || e)); }
    setLoading(false);
  }
  useEffect(() => { run(); }, []); // 進頁面先跑一次

  const rows = (data?.rows || []).filter(r => filter === 'ALL' || (filter === 'AB' ? r.grade !== '觀察' : r.grade === filter));
  const cnt = g => (data?.rows || []).filter(r => r.grade === g).length;
  const m = data?.market;

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 12 }}>
      <h2 style={{ margin: '8px 0' }}>台股訊號蒐集器 <small style={{ color: '#888', fontSize: 13 }}>0050 成份股</small></h2>
      <p style={{ color: '#888', fontSize: 12, marginTop: 0 }}>篩出「符合技術條件、值得研究」的股票。不是買進建議，條件符合度 ≠ 勝率。</p>

      <div style={{ ...box, display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          style={{ flex: 1, padding: 8, borderRadius: 8, border: '1px solid #333', background: '#0f1115', color: '#e6e6e6' }} />
        <button onClick={run} disabled={loading}
          style={{ padding: '8px 14px', borderRadius: 8, border: 0, background: '#3b82f6', color: '#fff', fontWeight: 600 }}>
          {loading ? '計算中…' : '掃描'}
        </button>
      </div>
      <p style={{ color: '#888', fontSize: 12, marginTop: -4 }}>日期留空 = 最新收盤；選過去日期 = 只用當時已知資料重跑</p>

      {err && <div style={{ ...box, color: '#e5484d' }}>錯誤：{err}</div>}

      {data && (
        <>
          <div style={box}>
            <div style={{ fontSize: 13, color: '#888' }}>資料日期 {data.asOf}{data.droppedIntraday && '（盤中，已排除今日未收盤K）'}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: ENV_COLOR[m?.label] }}>市場環境：{m?.label}（{m?.score ?? '—'}/6）</div>
            {['TWII', 'ETF0050'].map(k => m?.[k] && (
              <div key={k} style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>
                {k === 'TWII' ? '加權指數' : '0050'} {m[k].close}｜週5/20：{m[k].wMA5} / {m[k].wMA20}｜月5/20：{m[k].mMA5} / {m[k].mMA20}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            {[['AB', `A+B (${cnt('A') + cnt('B')})`], ['A', `A (${cnt('A')})`], ['B', `B (${cnt('B')})`], ['觀察', `觀察 (${cnt('觀察')})`], ['ALL', '全部']].map(([k, label]) => (
              <button key={k} onClick={() => setFilter(k)}
                style={{ padding: '6px 10px', borderRadius: 999, border: 0, background: filter === k ? '#3b82f6' : '#232733', color: '#e6e6e6', fontSize: 13 }}>
                {label}
              </button>
            ))}
            <a href={`/api/scan?format=csv${date ? '&date=' + date : ''}`} style={{ padding: '6px 10px', borderRadius: 999, background: '#232733', color: '#9ecbff', fontSize: 13, textDecoration: 'none' }}>下載CSV</a>
          </div>

          {rows.length === 0 && <div style={{ ...box, color: '#888' }}>這個分類目前沒有股票。</div>}

          {rows.map(r => (
            <div key={r.symbol} style={box} onClick={() => setOpen(o => ({ ...o, [r.symbol]: !o[r.symbol] }))}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div><b style={{ fontSize: 17 }}>{r.symbol} {r.name}</b> <span style={{ color: '#aaa' }}>{r.close}</span></div>
                <span style={{ background: GRADE_COLOR[r.grade], color: '#fff', borderRadius: 8, padding: '2px 10px', fontWeight: 700 }}>
                  {r.grade}・{r.conditionsMet}/7
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 13, marginTop: 8, color: '#ccc' }}>
                <div>突破：{r.breakoutType}</div>
                <div>量比：{r.volRatio ?? '—'} 倍{r.breakoutVolLabel !== '無突破' ? `（${r.breakoutVolLabel}）` : ''}</div>
                <div>距52週高：{fmtPct(r.fromHigh52Pct)}</div>
                <div>距52週低：{fmtPct(r.fromLow52Pct)}</div>
                <div>前低：{r.swingLow ?? '—'}</div>
                <div>結構停損參考：{r.stopRef ?? '—'}</div>
                <div>距突破價：{fmtPct(r.breakoutExtPct)}</div>
                <div>週線交叉：{r.weeklyCrossDate ?? '—'}</div>
              </div>
              <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {r.structureFailed && <Tag c="#30a46c">結構失效</Tag>}
                {r.chaseFlag === '可能追高' && <Tag c="#f5a524">可能追高</Tag>}
                {r.positionTag === '脫離低點但尚未接近52週高點' && <Tag c="#3b82f6">脫離低點未近高</Tag>}
              </div>
              {open[r.symbol] && (
                <div style={{ marginTop: 8, fontSize: 12, color: '#aaa', borderTop: '1px solid #262a35', paddingTop: 8 }}>
                  {[r.c1, r.c2, r.c3, r.c4, r.c5, r.c6, r.c7].map((c, i) => (
                    <div key={i}>{c === true ? '✅' : c === false ? '❌' : '⚪'} {COND[i]}</div>
                  ))}
                  <div style={{ marginTop: 6 }}>{r.reasons}</div>
                  <div style={{ marginTop: 6 }}>
                    前高 20/40/60日：{r.prior20H} / {r.prior40H} / {r.prior60H}｜今日量 {r.volume.toLocaleString()}｜20日均量 {r.volAvg20.toLocaleString()}
                  </div>
                  <a href={`/api/history?symbol=${r.symbol}&from=2023-01-01`} onClick={e => e.stopPropagation()} style={{ color: '#9ecbff' }}>
                    下載此股 2023 起逐日回測資料 CSV
                  </a>
                </div>
              )}
            </div>
          ))}

          {data.errors?.length > 0 && <div style={{ ...box, fontSize: 12, color: '#f5a524' }}>抓取失敗：{data.errors.join('、')}</div>}
          <p style={{ fontSize: 11, color: '#666' }}>
            成份股清單更新至 {data.constituentsUpdated}（{data.constituentsCount} 檔）｜均線模式 {data.config?.MA_MODE}｜價格為還原權息
          </p>
        </>
      )}
    </main>
  );
}

function Tag({ c, children }) {
  return <span style={{ border: `1px solid ${c}`, color: c, borderRadius: 999, padding: '1px 8px', fontSize: 12 }}>{children}</span>;
}
