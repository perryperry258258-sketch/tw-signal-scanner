'use client';
import { useEffect, useState } from 'react';

const box = { background: '#171a21', borderRadius: 12, padding: 12, marginBottom: 10 };
const ENV_COLOR = { '多方': '#e5484d', '震盪': '#f5a524', '空方': '#30a46c' };
const SIG_COLOR = { B5: '#e5484d', C4: '#3b82f6', A4: '#f5a524' };
const pct = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`);
const col = v => (v > 0 ? '#e5484d' : v < 0 ? '#30a46c' : '#aaa'); // 台股紅漲綠跌

function Chart({ history }) {
  if (!history || history.length < 2) return <div style={{ color: '#888', fontSize: 12 }}>模擬剛開始，累積幾天後會出現走勢圖</div>;
  const W = 340, H = 140, keys = [['total', '#e5484d', '策略合計'], ['totalIdle', '#f5a524', '閒置資金跟大盤'], ['taiex', '#888', '加權指數']];
  const all = history.flatMap(h => keys.map(([k]) => h[k]));
  const lo = Math.min(...all), hi = Math.max(...all), sx = i => (i / (history.length - 1)) * W, sy = v => H - ((v - lo) / (hi - lo || 1)) * H;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 150 }}>
        {keys.map(([k, c]) => <polyline key={k} fill="none" stroke={c} strokeWidth="2" points={history.map((h, i) => `${sx(i)},${sy(h[k])}`).join(' ')} />)}
      </svg>
      <div style={{ display: 'flex', gap: 10, fontSize: 11, color: '#aaa', flexWrap: 'wrap' }}>
        {keys.map(([k, c, n]) => <span key={k}><span style={{ color: c }}>■</span> {n} {history.at(-1)[k]}</span>)}
      </div>
    </div>
  );
}

export default function Daily() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { fetch('/daily/latest.json', { cache: 'no-store' }).then(r => r.json()).then(setD).catch(e => setErr(String(e))); }, []);
  if (err) return <main style={{ padding: 16 }}>還沒有每日資料（{err}）</main>;
  if (!d) return <main style={{ padding: 16, color: '#888' }}>載入中…</main>;
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 12 }}>
      <h2 style={{ margin: '8px 0' }}>每日訊號 <small style={{ color: '#888', fontSize: 13 }}>權值股全市場</small></h2>
      <div style={box}>
        <div style={{ fontSize: 13, color: '#888' }}>資料日期 {d.date}｜今日權值股 {d.universeCount} 檔</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: ENV_COLOR[d.env] }}>大盤環境：{d.env}</div>
      </div>

      <h3 style={{ margin: '12px 0 6px' }}>今日新訊號（明天開盤進場）</h3>
      {d.signals.length === 0 && <div style={{ ...box, color: '#888' }}>今天沒有新訊號。</div>}
      {d.signals.map(s => (
        <div key={s.sig + s.id} style={box}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <b style={{ fontSize: 17 }}>{s.id} {s.name}</b>
            <span style={{ background: SIG_COLOR[s.sig], color: '#fff', borderRadius: 8, padding: '2px 8px', fontSize: 13 }}>{s.sig} {s.sigName}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 13, marginTop: 8, color: '#ccc' }}>
            <div>收盤：{s.close}</div>
            <div>參考停損：{s.stopRef}（{s.stopPct}%）</div>
            <div>整理天數：{s.baseDays}</div>
            <div>突破量能：{s.moneyRatio} 倍</div>
            <div>距52週高：{pct(s.fromHigh52)}</div>
            <div>近60日：{pct(s.ret60)}</div>
          </div>
        </div>
      ))}

      <h3 style={{ margin: '12px 0 6px' }}>近 60 個交易日的訊號（到今天的表現）</h3>
      <div style={box}>
        {(d.recentSignals || []).length === 0 && <div style={{ color: '#888', fontSize: 13 }}>近期沒有訊號</div>}
        {(d.recentSignals || []).map((r, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '5px 0', borderBottom: '1px solid #262a35' }}>
            <span>
              <span style={{ color: SIG_COLOR[r.sig], fontWeight: 700 }}>{r.sig}</span> {r.id} {r.name}
              <br /><small style={{ color: '#888' }}>{r.date} 訊號價 {r.priceAtSignal} → 今 {r.lastPrice}｜最高 {pct(r.maxGain)}｜{r.status}</small>
            </span>
            <b style={{ color: col(r.ret) }}>{pct(r.ret)}</b>
          </div>
        ))}
      </div>

      <h3 style={{ margin: '12px 0 6px' }}>觀察名單（整理中、離突破 3% 以內）</h3>
      <div style={box}>
        {(d.watch || []).length === 0 && <div style={{ color: '#888', fontSize: 13 }}>目前沒有接近突破的股票</div>}
        {(d.watch || []).map(w => (
          <div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '5px 0', borderBottom: '1px solid #262a35' }}>
            <span>{w.id} {w.name} <small style={{ color: '#9ecbff' }}>{w.type}</small>
              <br /><small style={{ color: '#888' }}>整理 {w.baseDays} 天｜區間高點 {w.baseHigh}｜今日量能 {w.moneyRatio} 倍</small>
            </span>
            <b style={{ color: '#aaa' }}>{w.dist}%</b>
          </div>
        ))}
        <div style={{ fontSize: 11, color: '#666', marginTop: 6 }}>收盤突破區間高點、且量能達標（B5 ≥ 2 倍、C4 ≥ 1.5 倍）時，才會成為正式訊號</div>
      </div>

      {d.alerts.length > 0 && (
        <div style={{ ...box, border: '1px solid #f5a524' }}>
          <b style={{ color: '#f5a524' }}>⚠️ 崩盤反轉提醒（A4，不自動交易）</b>
          {d.alerts.map(a => <div key={a.id} style={{ fontSize: 13, marginTop: 4 }}>{a.id} {a.name}｜收盤 {a.close}｜距高點 {pct(a.fromHigh52)}</div>)}
        </div>
      )}

      <h3 style={{ margin: '12px 0 6px' }}>模擬帳戶（{d.startDate} 起，起始 100）</h3>
      <div style={box}><Chart history={d.history} /></div>
      {['B5', 'C4'].map(k => {
        const b = d.books[k], st = d.stats[k];
        return (
          <div key={k} style={box}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <b style={{ color: SIG_COLOR[k] }}>{k} {k === 'B5' ? '短整理放量突破' : '長整理放量突破'}</b>
              <b>{b.equity}</b>
            </div>
            <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>現金 {b.cash}%｜已結束 {st.n} 筆，勝率 {st.win ?? '—'}%，平均 {pct(st.avg)}</div>
            {b.positions.map(p => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginTop: 6, borderTop: '1px solid #262a35', paddingTop: 6 }}>
                <span>{p.id} {p.name}<br /><small style={{ color: '#888' }}>{p.entryDate} 進 {p.entry}｜停損 {p.stop}</small></span>
                <b style={{ color: col(p.ret) }}>{pct(p.ret)}</b>
              </div>
            ))}
            {b.pending.length > 0 && <div style={{ fontSize: 12, color: '#9ecbff', marginTop: 6 }}>明天開盤買進：{b.pending.map(p => `${p.id}${p.name}`).join('、')}</div>}
          </div>
        );
      })}

      <h3 style={{ margin: '12px 0 6px' }}>最近交易</h3>
      <div style={box}>
        {d.recentTrades.length === 0 && <div style={{ color: '#888', fontSize: 13 }}>還沒有交易紀錄</div>}
        {d.recentTrades.map((t, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #262a35' }}>
            <span>{t.book} {t.id} {t.name}<br /><small style={{ color: '#888' }}>{t.entryDate ?? t.signalDate} → {t.exitDate ?? ''} {t.reason ?? t.status}</small></span>
            <b style={{ color: col(t.ret) }}>{t.ret != null ? pct(t.ret) : ''}</b>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 11, color: '#666' }}>規則已凍結，與回測相同：隔天開盤進場、停損為整理區間低點（最多 -15%）、最長持有 250 個交易日、成本 0.6%。這是模擬紀錄，不是投資建議。更新時間 {d.generatedAt}</p>
    </main>
  );
}
