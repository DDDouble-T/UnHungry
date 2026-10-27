const { badRequest } = require('./errors')

const VOTE_CHOICES = new Set(['approve', 'wait'])
const CHECKIN_RESULTS = new Set(['真香', '后悔'])

function bodyObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('INVALID_BODY', '请求体必须是 JSON 对象')
  }
  return body
}

function text(value, field, { required = false, max = 200 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw badRequest('INVALID_FIELD', `${field}不能为空`, { field })
    return ''
  }
  if (typeof value !== 'string') throw badRequest('INVALID_FIELD', `${field}必须是字符串`, { field })
  const result = value.trim()
  if (required && !result) throw badRequest('INVALID_FIELD', `${field}不能为空`, { field })
  if (result.length > max) throw badRequest('INVALID_FIELD', `${field}最多${max}个字符`, { field })
  return result
}

function number(value, field, { required = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest('INVALID_FIELD', `${field}不能为空`, { field })
    return null
  }
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw badRequest('INVALID_FIELD', `${field}必须是${min}到${max}之间的数字`, { field })
  }
  return parsed
}

function id(value, field = 'id') {
  const result = text(value, field, { required: true, max: 128 })
  if (!/^[a-zA-Z0-9:_-]+$/.test(result)) throw badRequest('INVALID_ID', `${field}格式不正确`, { field })
  return result
}

function validateApprovalInput(input) {
  const body = bodyObject(input)
  if (body.isAnonymous !== undefined && typeof body.isAnonymous !== 'boolean') {
    throw badRequest('INVALID_FIELD', '匿名选项必须是布尔值', { field: 'isAnonymous' })
  }
  const isAnonymous = body.isAnonymous === true
  return {
    isAnonymous,
    authorName: isAnonymous ? '' : text(body.authorName, '名称', { max: 32 }) || '微信用户',
    authorAvatar: isAnonymous ? '' : text(body.authorAvatar, '头像', { max: 2048 }),
    title: text(body.title ?? body.foodName, '食物名称', { required: true, max: 40 }),
    price: number(body.price, '价格', { min: 0, max: 100000 }),
    calorie: number(body.calorie, '热量', { min: 0, max: 10000 }),
    reason: text(body.reason, '想吃理由', { required: true, max: 200 }),
    alternative: text(body.alternative, '替代方案', { max: 100 }),
    intake: text(body.intake, '今日摄入', { max: 100 }),
    image: text(body.image, '食物照片', { max: 2048 }),
  }
}

function validateFoodRecordInput(input) {
  const body = bodyObject(input)
  return {
    ...(body.approvalId !== undefined ? { approvalId: id(body.approvalId, 'approvalId') } : {}),
    title: text(body.title ?? body.foodName, '食物名称', { required: true, max: 40 }),
    calorie: number(body.calorie, '热量', { min: 0, max: 10000 }),
    image: text(body.image, '食物照片', { max: 2048 }),
  }
}

function validateVoteInput(input) {
  const body = bodyObject(input)
  const choice = text(body.choice, '投票选项', { required: true, max: 10 })
  if (!VOTE_CHOICES.has(choice)) throw badRequest('INVALID_CHOICE', '投票选项只能是 approve 或 wait', { field: 'choice' })
  return { choice, reason: text(body.reason, '投票理由', { required: true, max: 200 }) }
}

function validateCheckinInput(input) {
  const body = bodyObject(input)
  const result = text(body.result, '打卡结果', { required: true, max: 10 })
  if (!CHECKIN_RESULTS.has(result)) throw badRequest('INVALID_RESULT', '打卡结果只能是真香或后悔', { field: 'result' })
  return { result }
}

function status(value) {
  const result = value === undefined || value === '' ? 'all' : text(value, 'status', { max: 10 })
  if (!new Set(['all', 'pending', 'approved', 'rejected']).has(result)) {
    throw badRequest('INVALID_STATUS', 'status 只能是 all、pending、approved 或 rejected')
  }
  return result
}

function limit(value) {
  if (value === undefined || value === '') return 50
  const result = Number(value)
  if (!Number.isInteger(result) || result < 1 || result > 100) throw badRequest('INVALID_LIMIT', 'limit 必须是 1 到 100 的整数')
  return result
}

module.exports = {
  CHECKIN_RESULTS,
  VOTE_CHOICES,
  validateApprovalInput,
  validateFoodRecordInput,
  validateVoteInput,
  validateCheckinInput,
  status,
  id,
  limit,
}
