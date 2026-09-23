export const metadata = { title: '台股訊號蒐集器 · 0050', description: '0050 成份股技術條件篩選' };

export default function RootLayout({ children }) {
  return (
    <html lang="zh-Hant">
      <head><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
      <body style={{ margin: 0, background: '#0f1115', color: '#e6e6e6', fontFamily: 'system-ui, -apple-system, "PingFang TC", "Noto Sans TC", sans-serif' }}>
        {children}
      </body>
    </html>
  );
}
