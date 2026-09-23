'use client';
import { useState, useEffect } from 'react';

const box = { background: '#171a21', borderRadius: 12, padding: 12, marginBottom: 10 };

export default function Check() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    try { setData(await (await fetch('/api/lookahead')).json()); }
    catch (e) { setData({ overall: 'FAIL', tests: [], errors: [String(e)] }); }
    setLoading(false);
  }
  useEffect(() => { run(); }, []);

  const ok = data?.overall === 'PASS';
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 12 }}>
      <h2 style={{ margin: '8px 0' }}>Look-ahead Bias Check</h2>
      <p style={{ color: '#888', fontSize: 12, marginTop: 0 }}>用真實資料（台積電、富邦金、聯發科，各抽 10 個日期）檢查是否有未來函數</p>
      {loading && <div style={box}>檢查中…（約 10～30 秒）</div>}
      {data && (
        <>
          <div style={{ ...box, textAlign: 'center', background: ok ? '#12361f' : '#3a1414' }}>
            <div style={{ fontSize: 44, fontWeight: 800, color: ok ? '#3dd68c' : '#ff6369' }}>{data.overall}</div>
            <div style={{ fontSize: 12, color: '#aaa' }}>{data.runAt}｜均線模式 {data.maMode}</div>
          </div>
          {data.tests.map(t => (
            <div key={t.id} style={box}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 14 }}><b>{t.id}</b> {t.name}</span>
                <b style={{ color: t.pass ? '#3dd68c' : '#ff6369' }}>{t.pass ? 'PASS' : 'FAIL'}</b>
              </div>
              <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>檢查 {t.checked} 次</div>
              {t.failures.length > 0 && <div style={{ fontSize: 12, color: '#ff6369', marginTop: 4 }}>{t.failures.join('；')}</div>}
            </div>
          ))}
          {data.errors?.length > 0 && <div style={{ ...box, color: '#f5a524', fontSize: 12 }}>錯誤：{data.errors.join('、')}</div>}
          <button onClick={run} disabled={loading} style={{ padding: '8px 14px', borderRadius: 8, border: 0, background: '#3b82f6', color: '#fff' }}>重新檢查</button>
        </>
      )}
    </main>
  );
}
