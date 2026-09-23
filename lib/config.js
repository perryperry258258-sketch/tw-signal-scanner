// 所有門檻集中在這裡，改數字不用動邏輯
export const CONFIG = {
  // 週/月均線模式：
  // 'live'      = 含「本週/本月尚未走完」的K棒（跟看盤軟體一樣，週中可能出現又消失）
  // 'confirmed' = 只用已走完的週/月K（較穩定，但慢一拍）
  MA_MODE: 'live',

  WEEKLY_CROSS_WITHIN: 3,        // ① 週線黃金交叉需在最近幾根週K內（含本週）
  BREAKOUT_WINDOWS: [20, 40, 60],// ③ 前高天數（不含今日）
  BREAKOUT_LOOKBACK: 10,         // ⑥⑦ 往回找最近一次突破事件的交易日數（含今日）
  VOL_AVG_DAYS: 20,              // ⑥ 均量天數（不含今日）
  VOL_LOW: 0.8,                  // 量比 < 0.8 = 無量突破
  VOL_HIGH: 1.5,                 // 量比 >= 1.5 = 放量突破
  CHASE_PCT: 0.05,               // ⑦ 距突破價 > 5% 標記可能追高
  SWING_K: 5,                    // ④ 波段低點：左右各 5 根K的低點都比它高
  SWING_LOOKBACK: 120,           // ④ 只找最近 120 個交易日內的低點
  SWING_MIN_REBOUND: 0.03,       // ④ 低點之後至少反彈 3% 才算「明確」
  STOP_BUFFER: 0,                // 結構停損參考價 = 前低 × (1 - buffer)
  YEAR_BARS: 250,                // ⑤ 52週 ≈ 250 個交易日
  LOW_ESCAPE_MIN: 0.15,          // ⑤ 距52週低點至少 +15% 才算「脫離低點」
  HIGH_NEAR_MAX: -0.08,          // ⑤ 距52週高點至少 -8% 才算「尚未接近高點」
  GRADE_A: 6,                    // 7項中 >=6 = A
  GRADE_B: 4,                    // 4~5 = B，其餘 = 觀察
  ADJUSTED: true,                // 使用還原權息價格計算（原始收盤另外保留）
  WARMUP_DAYS: 1100,             // 往前多抓的日曆天數（月線20MA需約20個月）
};
