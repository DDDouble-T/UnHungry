export interface PosterApproval {
  title: string
  statusLabel: string
  status: 'pending' | 'approved' | 'rejected'
  calorie: string
  price: string
  reason: string
  alternative: string
  intake: string
  authorName: string
  time: string
  totalVotes: number
  supportRate: number
  image?: string
  authorAvatar: string
}

// 项目旧版 typings 没有 Canvas 2D 类型，只声明实际用到的原生接口。
interface PosterContext {
  font: string
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  textBaseline: string
  scale(x: number, y: number): void
  save(): void
  restore(): void
  beginPath(): void
  closePath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void
  arc(x: number, y: number, radius: number, start: number, end: number): void
  clip(): void
  fill(): void
  stroke(): void
  fillRect(x: number, y: number, width: number, height: number): void
  fillText(text: string, x: number, y: number): void
  measureText(text: string): { width: number }
  drawImage(image: WechatMiniprogram.Image, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void
}

interface TextBlock {
  lines: string[]
  x: number
  y: number
  font: string
  color: string
  lineHeight: number
}

const WIDTH = 600
const PADDING = 42
const CONTENT_WIDTH = WIDTH - PADDING * 2
const MINT = '#78C2AD'
const ORANGE = '#F3967A'
const TEXT = '#34463F'
const MUTED = '#8E9C97'

function loadImage(canvas: WechatMiniprogram.Canvas, source?: string): Promise<WechatMiniprogram.Image | null> {
  if (!source) return Promise.resolve(null)
  return new Promise(resolve => {
    let settled = false
    let image: WechatMiniprogram.Image | undefined
    const finish = (result: WechatMiniprogram.Image | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (image) {
        image.onload = () => undefined
        image.onerror = () => undefined
      }
      resolve(result)
    }
    // 网络图片偶尔不会触发失败回调，超时降级保证文字海报仍可生成。
    const timer = setTimeout(() => finish(null), 4000)
    try {
      image = canvas.createImage()
      image.onload = () => finish(image && image.width > 0 && image.height > 0 ? image : null)
      image.onerror = () => finish(null)
      image.src = source
    } catch (_) {
      finish(null)
    }
  })
}

function wrapText(context: PosterContext, value: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of value.replace(/\r\n?/g, '\n').split('\n')) {
    let line = ''
    // 按 Unicode 字符测量，保留换行与完整理由，不用省略号裁掉传播文案。
    for (const character of Array.from(paragraph)) {
      if (line && context.measureText(line + character).width > maxWidth) {
        lines.push(line)
        line = character
      } else {
        line += character
      }
    }
    lines.push(line)
  }
  return lines
}

function roundedRect(context: PosterContext, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath()
  context.moveTo(x + radius, y)
  context.lineTo(x + width - radius, y)
  context.quadraticCurveTo(x + width, y, x + width, y + radius)
  context.lineTo(x + width, y + height - radius)
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  context.lineTo(x + radius, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - radius)
  context.lineTo(x, y + radius)
  context.quadraticCurveTo(x, y, x + radius, y)
  context.closePath()
}

function drawPhoto(context: PosterContext, image: WechatMiniprogram.Image, x: number, y: number, width: number, height: number) {
  const scale = Math.max(width / image.width, height / image.height)
  const sourceWidth = width / scale
  const sourceHeight = height / scale
  context.drawImage(image, (image.width - sourceWidth) / 2, (image.height - sourceHeight) / 2, sourceWidth, sourceHeight, x, y, width, height)
}

export async function createApprovalPoster(canvas: WechatMiniprogram.Canvas, approval: PosterApproval, pixelRatio: number): Promise<string> {
  if (!canvas || typeof canvas.getContext !== 'function') throw new Error('当前环境无法生成审批卡片')
  let context = canvas.getContext('2d') as PosterContext | null
  if (!context) throw new Error('当前环境不支持 2D 画布')

  const [photo, avatar] = await Promise.all([
    loadImage(canvas, approval.image),
    loadImage(canvas, approval.authorAvatar),
  ])
  const blocks: TextBlock[] = []
  const addText = (value: string, x: number, y: number, maxWidth: number, font: string, lineHeight: number, color: string) => {
    context!.font = font
    const lines = wrapText(context!, value, maxWidth)
    blocks.push({ lines, x, y, font, lineHeight, color })
    return lines.length * lineHeight
  }
  const statusLabel = approval.statusLabel.trim() || { pending: '待判官', approved: '已放行', rejected: '暂缓驳回' }[approval.status]
  const statusColor = approval.status === 'approved' ? MINT : ORANGE
  context.font = '500 19px sans-serif'
  const statusWidth = Math.min(CONTENT_WIDTH, context.measureText(statusLabel).width + 24)
  const statusOnOwnLine = statusWidth > 176
  const statusX = statusOnOwnLine ? PADDING : WIDTH - PADDING - statusWidth
  let y = PADDING
  const titleHeight = addText(approval.title.trim() || '嘴馋申请', PADDING, y, statusOnOwnLine ? CONTENT_WIDTH : CONTENT_WIDTH - statusWidth - 18, '700 34px sans-serif', 46, TEXT)
  const statusY = statusOnOwnLine ? y + titleHeight + 10 : y + 3
  const statusTextHeight = addText(statusLabel, statusX + 12, statusY + 8, statusWidth - 24, '500 19px sans-serif', 26, statusColor)
  const statusHeight = statusTextHeight + 16
  y = Math.max(y + titleHeight, statusY + statusHeight) + 12

  const calorie = approval.calorie.trim()
  const price = approval.price.trim()
  const meta = [calorie ? calorie === '待估算' ? calorie : `${calorie} kcal` : '', price ? `¥${price}` : ''].filter(Boolean).join('  ·  ')
  if (meta) y += addText(meta, PADDING, y, CONTENT_WIDTH, '600 24px sans-serif', 34, MUTED) + 24
  else y += 12
  y += addText(approval.reason.trim() || '申请理由未填写', PADDING, y, CONTENT_WIDTH, '600 27px sans-serif', 42, TEXT) + 24

  const photoY = y
  if (photo) y += 256
  if (approval.alternative.trim()) y += addText(`也可以试试  ${approval.alternative.trim()}`, PADDING, y, CONTENT_WIDTH, '400 22px sans-serif', 34, '#668F80') + 12
  if (approval.intake.trim()) y += addText(`今日已吃  ${approval.intake.trim()}`, PADDING, y, CONTENT_WIDTH, '400 21px sans-serif', 33, MUTED) + 12
  y += 8

  const authorY = y
  const author = [approval.authorName.trim() || '匿名干饭人', approval.time.trim()].filter(Boolean).join(' · ')
  const authorHeight = addText(author, PADDING + 48, y + 5, CONTENT_WIDTH - 48, '400 20px sans-serif', 30, MUTED)
  y += Math.max(38, authorHeight + 5) + 24
  const dividerY = y
  y += 23
  const totalVotes = Number.isFinite(approval.totalVotes) ? Math.max(0, Math.floor(approval.totalVotes)) : 0
  const supportRate = Number.isFinite(approval.supportRate) ? Math.round(Math.min(100, Math.max(0, approval.supportRate))) : 0
  const voteSummary = totalVotes ? `${totalVotes} 人已投票 · ${supportRate}% 支持` : '等待第一张投票'
  y += addText(voteSummary, PADDING, y, CONTENT_WIDTH, '500 22px sans-serif', 32, totalVotes ? '#668F80' : MUTED) + 38
  y += addText('干饭暂缓局｜嘴馋先审批', PADDING, y, CONTENT_WIDTH, '400 20px sans-serif', 30, '#ABB6B1') + PADDING
  const height = Math.ceil(y)

  // 大图降低导出倍率而非截断正文，兼顾完整内容与移动端画布内存限制。
  const requestedRatio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1
  const ratio = Math.min(requestedRatio, 3, 8192 / height, Math.sqrt(16000000 / (WIDTH * height)))
  canvas.width = Math.ceil(WIDTH * ratio)
  canvas.height = Math.ceil(height * ratio)
  context = canvas.getContext('2d') as PosterContext
  context.scale(ratio, ratio)
  context.fillStyle = '#FFFFFF'
  context.fillRect(0, 0, canvas.width / ratio, canvas.height / ratio)
  context.textBaseline = 'top'
  context.fillStyle = approval.status === 'approved' ? '#EEF7F3' : '#FFF2EC'
  roundedRect(context, statusX, statusY, statusWidth, statusHeight, 9)
  context.fill()

  if (photo) {
    context.save()
    roundedRect(context, PADDING, photoY, CONTENT_WIDTH, 232, 14)
    context.clip()
    try { drawPhoto(context, photo, PADDING, photoY, CONTENT_WIDTH, 232) } catch (_) { /* 图片绘制异常不影响文字导出。 */ }
    context.restore()
  }
  context.save()
  context.beginPath()
  context.arc(PADDING + 18, authorY + 19, 18, 0, Math.PI * 2)
  context.clip()
  context.fillStyle = '#EEF7F3'
  context.fillRect(PADDING, authorY + 1, 36, 36)
  if (avatar) {
    try { drawPhoto(context, avatar, PADDING, authorY + 1, 36, 36) } catch (_) { /* 保留头像占位底色。 */ }
  }
  context.restore()

  for (const block of blocks) {
    context.font = block.font
    context.fillStyle = block.color
    block.lines.forEach((line, index) => context!.fillText(line, block.x, block.y + index * block.lineHeight))
  }
  context.strokeStyle = '#EAF0ED'
  context.lineWidth = 1
  context.beginPath()
  context.moveTo(PADDING, dividerY)
  context.lineTo(WIDTH - PADDING, dividerY)
  context.stroke()

  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      fileType: 'png',
      destWidth: canvas.width,
      destHeight: canvas.height,
      success: result => resolve(result.tempFilePath),
      fail: () => reject(new Error('审批卡片生成失败，请重试')),
    })
  })
}
