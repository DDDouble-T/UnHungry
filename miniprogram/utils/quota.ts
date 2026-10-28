export function getQuotaState(todayCalories: number, calorieQuota: number) {
  // 与记录的热量精度一致，避免浮点累计把刚好达标误判为超额。
  const consumed = Number.isFinite(todayCalories) ? Math.max(0, Math.round(todayCalories * 100) / 100) : 0
  const limit = Number.isFinite(calorieQuota) ? Math.max(0, Math.round(calorieQuota * 100) / 100) : 0
  const quotaAvailable = limit > 0
  const quotaExceeded = quotaAvailable && consumed > limit
  const percent = quotaAvailable ? consumed / limit * 100 : 0
  // 百分比保留溢出；只有有限宽度的进度条/第一圈需要截到 100%。
  const roundedPercent = Math.round(percent * 10) / 10
  const quotaPercent = quotaExceeded ? Math.max(100.1, roundedPercent) : roundedPercent
  const quotaTrackPercent = Math.min(100, percent)
  const quotaExcess = Number(Math.max(0, consumed - limit).toPrecision(12))
  const quotaRemaining = Number(Math.max(0, limit - consumed).toPrecision(12))
  const color = quotaExceeded ? '#F3967A' : '#78C2AD'
  return {
    todayCalories: consumed,
    calorieQuota: limit,
    quotaAvailable,
    quotaExceeded,
    quotaPercent,
    quotaTrackPercent,
    quotaExcess,
    quotaRemaining,
    quotaRingStyle: `background: conic-gradient(${color} ${quotaTrackPercent * 3.6}deg, #e4eee9 0deg);`,
    quotaOverflowStyle: `background: conic-gradient(${color} ${Math.min(100, Math.max(0, percent - 100)) * 3.6}deg, transparent 0deg);`,
  }
}
