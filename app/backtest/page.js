'use client';
import { useState, useMemo } from 'react';
import { CONSTITUENTS, CONSTITUENTS_UPDATED } from '../../lib/constituents.js';
import { BACKTEST_COLUMNS, toCSVCols } from '../../lib/backtest.js';
import { buildReport, HORIZONS, UP_LEVELS, DOWN_LEVELS, HIT_HORIZONS } from '../../lib/stats.js';

const box = { background: '#171a21', borderRadius: 12, padding: 12, marginBottom: 10 };
const th = { padding: '4px 6px', color: '#888', fontWeight: 500, textAlign: 'right', whiteSpace: 'nowrap' };
const td = { padding: '4px 6px', textAlign: 'right', whiteSpace: 'nowrap' };
const GROUPS = ['全部訊號', 'A級', 'B級', '基準：所有交易日'];
const BATCH = 5;
const f = v => (v == null ? '—' : v);
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const liteText = s => `n=${s.n} r20 ${f(s.r20)} r60 ${f(s.r60)}(中位${f(s.med60)}) 勝${f(s.win60)}% +10:${f(s.up10)}% -8:${f(s.dn8)}%`;

function Table({ head, rows }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
        <thead><tr>{head.map((h, i) => <th key={i} style={{ ...th, textAlign: i ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i} style={{ borderTop: '1px solid #262a35' }}>
            {r.map((c, j) => <td key={j} style={{ ...td, textAlign: j ? 'right' : 'left' }}>{c}</td>)}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Tabs({ value, onChange, options }) {
  return (
    <div style={{ display: 'flex', gap: 6, margin: '6px 0' }}>
      {options.map(o => (
        <button key={o} onClick={() => onChange(o)} style={{ ...pill, padding: '4px 10px', fontSize: 12, background: value === o ? '#3b82f6' : '#232733' }}>{o}</button>
      ))}
    </div>
  );
}

export default function Backtest() {
  const [from, setFrom] = useState('2023-01-01');
  const [to, setTo] = useState(today());
  const [mode, setMode] = useState('new');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [check, setCheck] = useState(null);
  const [days, setDays] = useState(null);
  const [signals, setSignals] = useState([]);
  const [errors, setErrors] = useState([]);
  const [copied, setCopied] = useState(false);
  const [envB, setEnvB] = useState('全部');
  const [envC, setEnvC] = useState('全部');

  async function run() {
    setRunning(true); setDays(null); setSignals([]); setErrors([]); setCheck(null);
    setProgress('執行 Look-ahead Bias Check…');
    try { setCheck(await (await fetch('/api/lookahead')).json()); } catch (e) { setCheck({ overall: 'FAIL', tests: [], errors: [String(e)] }); }

    const allDays = [], allSig = [], errs = [];
    const codes = CONSTITUENTS.map(c => c[0]);
    const batches = Math.ceil(codes.length / BATCH);
    for (let b = 0; b < batches; b++) {
      const part = codes.slice(b * BATCH, (b + 1) * BATCH);
      setProgress(`回測中：第 ${b + 1}/${batches} 批（${part.join(', ')}）`);
      try {
        const j = await (await fetch(`/api/backtest?symbols=${part.join(',')}&from=${from}&to=${to}`)).json();
        if (j.error) throw new Error(j.error);
        for (const d of j.days) {
          const o = { symbol: d[0], date: d[1], grade: d[2], isNewSignal: d[3] === 1, etf0050Env: d[4], conds: d[5] };
          HORIZONS.forEach((N, k) => { o[`mfe${N}`] = d[6 + k * 3]; o[`mae${N}`] = d[7 + k * 3]; o[`ret${N}`] = d[8 + k * 3]; });
          allDays.push(o);
        }
        allSig.push(...j.signals);
        errs.push(...j.errors);
      } catch (e) { errs.push(`批次 ${part.join(',')}: ${e.message || e}`); }
    }
    setDays(allDays); setSignals(allSig); setErrors(errs);
    setProgress(''); setRunning(false);
  }

  const report = useMemo(() => (days ? buildReport(days, mode) : null), [days, mode]);
  const okSymbols = days ? new Set(days.map(d => d.symbol)).size : 0;

  function downloadCSV() {
    const rows = mode === 'new' ? signals.filter(s => s.isNewSignal) : signals;
    const blob = new Blob([toCSVCols(rows, BACKTEST_COLUMNS)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `backtest_signals_${mode}_${from}_${to}.csv`;
    a.click();
  }

  function reportText() {
    if (!report) return '';
    const G = report.byGroup, L = [];
    L.push(`台股訊號蒐集器 第一版基準回測 ${from}～${to}`);
    L.push(`訊號定義：${mode === 'new' ? '新訊號（升級為A/B的第一天）' : '每個A/B日'}`);
    L.push(`① 成份股：${CONSTITUENTS.length}檔（清單日 ${CONSTITUENTS_UPDATED}），成功 ${okSymbols} 檔${errors.length ? '，失敗：' + errors.join('；') : ''}`);
    L.push(`② Look-ahead Bias Check：${check?.overall ?? '未執行'}${check?.tests ? '（' + check.tests.map(t => `${t.id}${t.pass ? '✓' : '✗'}`).join(' ') + '）' : ''}`);
    L.push(`③ 總訊號數：${G['全部訊號'].count}（總評估日 ${report.totalDays}）`);
    L.push(`④ A級：${G['A級'].count}｜B級：${G['B級'].count}`);
    L.push(`⑤ 平均最大漲幅/最大跌幅(%)：`);
    for (const g of GROUPS) L.push(`  ${g}：` + HORIZONS.map(N => `${N}日 +${f(G[g].avgMfe[N])}/${f(G[g].avgMae[N])}`).join('，'));
    for (const H of HIT_HORIZONS) {
      L.push(`⑥ ${H}日內達到漲幅比例(%)：`);
      for (const g of GROUPS) L.push(`  ${g}：` + UP_LEVELS.map(x => `+${x}%:${f(G[g].up[H][x])}`).join(' '));
      L.push(`⑦ ${H}日內曾跌超過比例(%)：`);
      for (const g of GROUPS) L.push(`  ${g}：` + DOWN_LEVELS.map(x => `-${x}%:${f(G[g].down[H][x])}`).join(' '));
    }
    L.push(`⑧ 0050市場環境比較：`);
    for (const env of ['多方', '震盪', '空方']) {
      for (const g of GROUPS) {
        const s = report.byEnv[env][g];
        L.push(`  ${env}｜${g}：n=${s.count}，20日 +${f(s.avgMfe[20])}/${f(s.avgMae[20])}，60日 +${f(s.avgMfe[60])}/${f(s.avgMae[60])}，60日收盤報酬 ${f(s.avgRet[60])}（勝${f(s.win[60])}%），60日達+10%:${f(s.up[60][10])}%，60日跌破-8%:${f(s.down[60][8])}%`);
      }
    }
    L.push(`⑨ N日後收盤報酬(%)：平均 / 中位數 / 勝率(報酬>0)`);
    for (const g of GROUPS) L.push(`  ${g}：` + HORIZONS.map(N => `${N}日 ${f(G[g].avgRet[N])}/${f(G[g].medRet[N])}/${f(G[g].win[N])}%`).join('，'));
    L.push(`⑩a 單一條件（所有交易日）成立｜不成立：`);
    for (const c of report.condAll) L.push(`  ${c.name} 成立 ${liteText(c.yes)}｜不成立 ${liteText(c.no)}`);
    for (const env of ['全部', '多方', '震盪']) {
      L.push(`⑩b 訊號中各條件（${env}）成立｜不成立：`);
      for (const c of report.condInSig[env]) L.push(`  ${c.name} 成立 ${liteText(c.yes)}｜不成立 ${liteText(c.no)}`);
    }
    for (const env of ['全部', '多方', '震盪']) {
      L.push(`⑩c A級依缺少條件分組（${env}）：`);
      for (const b of report.aMissing[env]) if (b.n) L.push(`  ${b.name} ${liteText(b)}`);
    }
    L.push(`⑪ 分年度：`);
    for (const y of report.byYear) for (const g of GROUPS) L.push(`  ${y.year}｜${g}：${liteText(y.groups[g])}`);
    return L.join('\n');
  }

  async function copy() {
    try { await navigator.clipboard.writeText(reportText()); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  }

  const G = report?.byGroup;
  const condHead = ['條件', '成立n', '成立60日報酬', '成立勝率', '成立-8%', '不成立n', '不成立60日報酬', '不成立勝率', '不成立-8%'];
  const condRow = c => [c.name, c.yes.n, f(c.yes.r60), f(c.yes.win60), f(c.yes.dn8), c.no.n, f(c.no.r60), f(c.no.win60), f(c.no.dn8)];
  const liteHead = ['', 'n', '20日報酬', '60日報酬', '60日中位', '60日勝率', '達+10%', '跌-8%'];
  const liteRow = (name, s) => [name, s.n, f(s.r20), f(s.r60), f(s.med60), f(s.win60), f(s.up10), f(s.dn8)];

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 12 }}>
      <h2 style={{ margin: '8px 0' }}>第一版基準回測 <small style={{ color: '#888', fontSize: 13 }}>0050 全部成份股</small></h2>
      <p style={{ color: '#888', fontSize: 12, marginTop: 0 }}>參數全部使用第一版基準值。每天的訊號只用當天收盤以前的資料；未來漲跌幅只用於事後統計。</p>

      <div style={{ ...box, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inp} />
        <span>～</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inp} />
        <button onClick={run} disabled={running} style={btn}>{running ? '執行中…' : '開始回測'}</button>
      </div>
      {progress && <div style={{ ...box, color: '#9ecbff' }}>{progress}<div style={{ fontSize: 12, color: '#888' }}>全部約需 2～4 分鐘，請不要關閉畫面</div></div>}

      {check && (
        <div style={box}>
          <b>② Look-ahead Bias Check：</b>
          <b style={{ color: check.overall === 'PASS' ? '#3dd68c' : '#ff6369', fontSize: 18 }}> {check.overall}</b>
          <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>
            {check.tests?.map(t => <div key={t.id}>{t.pass ? '✅' : '❌'} {t.id} {t.name}</div>)}
          </div>
          <a href="/check" style={{ color: '#9ecbff', fontSize: 12 }}>查看檢查細節</a>
        </div>
      )}

      {report && (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            {[['new', '新訊號（預設）'], ['daily', '每個A/B日']].map(([k, l]) => (
              <button key={k} onClick={() => setMode(k)} style={{ ...pill, background: mode === k ? '#3b82f6' : '#232733' }}>{l}</button>
            ))}
            <button onClick={copy} style={pill}>{copied ? '已複製 ✓' : '複製報告文字'}</button>
            <button onClick={downloadCSV} style={pill}>下載訊號CSV</button>
          </div>
          <p style={{ fontSize: 11, color: '#888', marginTop: -4 }}>
            新訊號 = 由「觀察」升到 B/A、或 B 升 A 的第一天（避免同一段行情連續幾天重複計算）
          </p>

          <div style={box}>
            <b>① 成份股</b>
            <div style={{ fontSize: 13, marginTop: 4 }}>{CONSTITUENTS.length} 檔（清單日 {CONSTITUENTS_UPDATED}），成功回測 {okSymbols} 檔</div>
            {errors.length > 0 && <div style={{ fontSize: 12, color: '#f5a524' }}>失敗：{errors.join('；')}</div>}
          </div>

          <div style={box}>
            <b>③④ 訊號數量</b>
            <Table head={['', '數量']} rows={[
              ['總訊號數', G['全部訊號'].count], ['A級', G['A級'].count], ['B級', G['B級'].count], ['總評估日（股票×交易日）', report.totalDays],
            ]} />
          </div>

          <div style={box}>
            <b>⑤ 平均未來最大漲幅（MFE, %）</b>
            <Table head={['', ...HORIZONS.map(N => `${N}日`)]} rows={GROUPS.map(g => [g, ...HORIZONS.map(N => f(G[g].avgMfe[N]))])} />
            <b style={{ display: 'block', marginTop: 10 }}>⑤ 平均未來最大跌幅（MAE, %）</b>
            <Table head={['', ...HORIZONS.map(N => `${N}日`)]} rows={GROUPS.map(g => [g, ...HORIZONS.map(N => f(G[g].avgMae[N]))])} />
          </div>

          {HIT_HORIZONS.map(H => (
            <div key={H} style={box}>
              <b>⑥ {H} 日內曾達到漲幅的比例（%）</b>
              <Table head={['', ...UP_LEVELS.map(x => `+${x}%`)]} rows={GROUPS.map(g => [g, ...UP_LEVELS.map(x => f(G[g].up[H][x]))])} />
              <b style={{ display: 'block', marginTop: 10 }}>⑦ {H} 日內曾跌超過的比例（%）</b>
              <Table head={['', ...DOWN_LEVELS.map(x => `-${x}%`)]} rows={GROUPS.map(g => [g, ...DOWN_LEVELS.map(x => f(G[g].down[H][x]))])} />
            </div>
          ))}

          <div style={box}>
            <b>⑧ 0050 市場環境比較</b>
            <div style={{ fontSize: 11, color: '#888' }}>0050 的 3 項（週5&gt;週20、收盤&gt;週20、月5&gt;月20）全符合 = 多方，全不符合 = 空方，其餘 = 震盪</div>
            {['多方', '震盪', '空方'].map(env => (
              <div key={env} style={{ marginTop: 8 }}>
                <b style={{ color: env === '多方' ? '#e5484d' : env === '空方' ? '#30a46c' : '#f5a524' }}>0050 {env}</b>
                <Table head={['', '數量', '20日MFE', '20日MAE', '60日MFE', '60日MAE', '60日報酬', '60日勝率', '60日達+10%', '60日跌-8%']}
                  rows={GROUPS.map(g => {
                    const s = report.byEnv[env][g];
                    return [g, s.count, f(s.avgMfe[20]), f(s.avgMae[20]), f(s.avgMfe[60]), f(s.avgMae[60]), f(s.avgRet[60]), f(s.win[60]), f(s.up[60][10]), f(s.down[60][8])];
                  })} />
              </div>
            ))}
          </div>

          <div style={box}>
            <b>⑨ N 日後收盤報酬（%）</b>
            <div style={{ fontSize: 11, color: '#888' }}>訊號日收盤買進、第 N 個交易日收盤的報酬（不是期間最高點）</div>
            <div style={{ fontSize: 12, marginTop: 6 }}>平均</div>
            <Table head={['', ...HORIZONS.map(N => `${N}日`)]} rows={GROUPS.map(g => [g, ...HORIZONS.map(N => f(G[g].avgRet[N]))])} />
            <div style={{ fontSize: 12, marginTop: 6 }}>中位數</div>
            <Table head={['', ...HORIZONS.map(N => `${N}日`)]} rows={GROUPS.map(g => [g, ...HORIZONS.map(N => f(G[g].medRet[N]))])} />
            <div style={{ fontSize: 12, marginTop: 6 }}>勝率（報酬 &gt; 0 的比例）</div>
            <Table head={['', ...HORIZONS.map(N => `${N}日`)]} rows={GROUPS.map(g => [g, ...HORIZONS.map(N => f(G[g].win[N]))])} />
          </div>

          <div style={box}>
            <b>⑩a 單一條件分析（所有交易日）</b>
            <div style={{ fontSize: 11, color: '#888' }}>每項條件單獨看：成立的日子 vs 不成立的日子，60 日表現</div>
            <Table head={condHead} rows={report.condAll.map(condRow)} />
          </div>

          <div style={box}>
            <b>⑩b 訊號中各條件的貢獻</b>
            <div style={{ fontSize: 11, color: '#888' }}>只看 A/B 訊號：該條件成立 vs 不成立</div>
            <Tabs value={envB} onChange={setEnvB} options={['全部', '多方', '震盪']} />
            <Table head={condHead} rows={report.condInSig[envB].map(condRow)} />
          </div>

          <div style={box}>
            <b>⑩c A 級依「缺少哪一項」分組</b>
            <div style={{ fontSize: 11, color: '#888' }}>A 級 = 7 項至少符合 6 項，所以最多缺 1 項</div>
            <Tabs value={envC} onChange={setEnvC} options={['全部', '多方', '震盪']} />
            <Table head={liteHead} rows={report.aMissing[envC].filter(b => b.n).map(b => liteRow(b.name, b))} />
          </div>

          <div style={box}>
            <b>⑪ 分年度</b>
            {report.byYear.map(y => (
              <div key={y.year} style={{ marginTop: 8 }}>
                <b>{y.year}</b>
                <Table head={liteHead} rows={GROUPS.map(g => liteRow(g, y.groups[g]))} />
              </div>
            ))}
            <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>最後一年只到今天，且最近 60 個交易日沒有 60 日報酬</div>
          </div>

          <p style={{ fontSize: 11, color: '#666' }}>
            MFE/MAE/收盤報酬 以訊號日收盤價為基準、使用還原權息價（含股利）。最後 5～60 個交易日的訊號因未來資料不足，對應期間不列入統計。
            「基準：所有交易日」= 同一批股票在同期間的每一天，用來對照訊號是否真的比隨便哪天好。
          </p>
        </>
      )}
    </main>
  );
}

const inp = { padding: 8, borderRadius: 8, border: '1px solid #333', background: '#0f1115', color: '#e6e6e6' };
const btn = { padding: '8px 14px', borderRadius: 8, border: 0, background: '#3b82f6', color: '#fff', fontWeight: 600 };
const pill = { padding: '6px 10px', borderRadius: 999, border: 0, background: '#232733', color: '#e6e6e6', fontSize: 13 };
