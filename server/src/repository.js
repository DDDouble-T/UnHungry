const crypto = require('node:crypto')
const foods = require('../data/foods.json')
const { conflict, notFound } = require('./errors')
const { isApprovalWithinValidity, isRecentRecord, resolveApprovalOutcome, resolveRecordOutcome } = require('./approval-lifecycle')

const COLLECTIONS = { approvals: 'approvals', votes: 'approval_votes', records: 'user_records' }
const STATUS_LABELS = { pending: '待审批', approved: '已通过', rejected: '先等等' }

function now() {
  return new Date().toISOString()
}

function newId() {
  return crypto.randomUUID()
}

function normalizeFoodName(value) {
  return value.trim().toLowerCase().replace(/[\s·＋+、,，。/\\_\-()（）【】\[\]]/g, '')
}

function foodScore(query, candidate) {
  if (candidate === query) return 0
  if (candidate.includes(query) || query.includes(candidate)) return 1
  const fragments = new Set()
  for (let index = 0; index < candidate.length - 1; index += 1) fragments.add(candidate.slice(index, index + 2))
  let overlap = 0
  let total = 0
  for (let index = 0; index < query.length - 1; index += 1) {
    total += 1
    if (fragments.has(query.slice(index, index + 2))) overlap += 1
  }
  return overlap ? 2 - Math.min(overlap / Math.max(total, 1), 0.9) : null
}

function searchFoods(keyword, limit) {
  const query = normalizeFoodName(keyword)
  if (!query) return []
  return foods
    .map(food => {
      const scores = [food.name, ...(food.aliases || [])]
        .map(name => foodScore(query, normalizeFoodName(name)))
        .filter(score => score !== null)
      return { food, score: scores.length ? Math.min(...scores) : null }
    })
    .filter(item => item.score !== null)
    .sort((left, right) => left.score - right.score || left.food.name.localeCompare(right.food.name))
    .slice(0, limit)
    .map(item => item.food)
}

function calculateStatus(support, against) {
  // 状态由服务端统一计算，客户端只提交 choice，避免不同客户端出现审批结果分叉。
  const totalVotes = support + against
  const supportRate = totalVotes ? Math.round((support / totalVotes) * 100) : 0
  const status = supportRate >= 50 ? 'approved' : against > support ? 'rejected' : 'pending'
  return { totalVotes, supportRate, status }
}

function recordFor(approval, openid, createdAt = now()) {
  return {
    _id: newId(),
    _openid: openid,
    approvalId: approval._id,
    title: approval.title,
    calorie: approval.calorie,
    status: approval.status,
    checkinResult: '',
    createdAt,
    updatedAt: createdAt,
  }
}

function recordFromApproval(approval, openid) {
  // 历史数据可能只有审批主体，没有同步生成 user_records；先用审批主体补齐列表，避免“我的”记录凭空消失。
  return {
    _id: approval._id,
    _openid: openid,
    approvalId: approval._id,
    title: approval.title,
    calorie: approval.calorie,
    status: approval.status,
    checkinResult: '',
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt || approval.createdAt,
  }
}

function mergeApprovalRecords(records, approvals, openid, reference) {
  const existingApprovalIds = new Set(records.filter(item => item.approvalId).map(item => item.approvalId))
  const missing = approvals
    .filter(item => item && item._id && item._openid === openid && !existingApprovalIds.has(item._id))
    .map(item => recordFromApproval(item, openid))
  return [...records, ...missing]
    .filter(item => isRecentRecord(item, reference))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(item => resolveRecordOutcome(item, reference))
}

function foodRecordFor(input, openid, createdAt = now()) {
  return {
    _id: newId(),
    _openid: openid,
    title: input.title,
    calorie: input.calorie,
    image: input.image,
    status: 'logged',
    checkinResult: '',
    createdAt,
    updatedAt: createdAt,
  }
}

function withoutId(value) {
  const { _id, ...data } = value
  return data
}

function calculateStats(records) {
  const approvalRecords = records.filter(item => item.approvalId)
  const approvedCount = approvalRecords.filter(item => item.status === 'approved').length
  const rejected = approvalRecords.filter(item => item.status === 'rejected')
  const rejectedNames = new Map()
  rejected.forEach(item => rejectedNames.set(item.title, (rejectedNames.get(item.title) || 0) + 1))
  const topRejected = [...rejectedNames.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''
  const today = new Date().toISOString().slice(0, 10)
  const todayCalories = records.filter(item => {
    // 发起或获批不代表实际摄入；跨日确认吃了时，热量归到确认当天。
    const eaten = item.status === 'logged' || item.foodRecorded || item.checkinResult === '真香'
    const consumedAt = item.approvalId ? item.updatedAt || item.createdAt : item.createdAt
    const consumedDay = consumedAt instanceof Date ? consumedAt.toISOString().slice(0, 10) : String(consumedAt || '').slice(0, 10)
    return eaten && consumedDay === today
  }).reduce((sum, item) => sum + (Number(item.calorie) || 0), 0)
  return {
    submittedCount: approvalRecords.length,
    approvedCount,
    approvalRate: approvalRecords.length ? Math.round((approvedCount / approvalRecords.length) * 100) : 0,
    todayCalories: Math.round(todayCalories * 100) / 100,
    calorieQuota: 1600,
    savedCalories: rejected.reduce((sum, item) => sum + (Number(item.calorie) || 0), 0),
    topRejected,
  }
}

class MemoryRepository {
  constructor() {
    this.mode = 'memory'
    this.approvals = new Map()
    this.votes = new Map()
    this.records = new Map()
  }

  async listApprovals({ status = 'all', limit = 50 } = {}) {
    const reference = new Date()
    return [...this.approvals.values()]
      .filter(item => status === 'all' || item.status === status)
      .filter(item => isApprovalWithinValidity(item.createdAt, reference))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(item => this.withFoodDecision(item))
  }

  withFoodDecision(item) {
    const record = [...this.records.values()].find(record => record.approvalId === item._id && record._openid === item._openid)
    const resolved = resolveRecordOutcome(record)
    const approval = resolveApprovalOutcome(item, record)
    return { ...approval, foodDecided: Boolean(resolved && (resolved.foodRecorded || resolved.checkinResult) || approval.foodDecided), foodResult: approval.foodResult || (resolved && (resolved.foodRecorded || resolved.checkinResult === '真香') ? 'eaten' : resolved && resolved.checkinResult === '后悔' ? 'skipped' : '') }
  }

  async listFoods({ keyword = '', limit = 5 } = {}) {
    return searchFoods(keyword, limit)
  }

  async listApprovalMessages(openid, limit = 10) {
    const ownApprovalIds = new Set([...this.approvals.values()]
      .filter(item => item._openid === openid)
      .map(item => item._id))
    const sortByTime = (left, right) => String(right.createdAt).localeCompare(String(left.createdAt))
    const ownMessages = [...this.votes.values()]
      .filter(item => ownApprovalIds.has(item.approvalId))
      .sort(sortByTime)
    const otherMessages = [...this.votes.values()]
      .filter(item => !ownApprovalIds.has(item.approvalId))
      .sort(sortByTime)
    return [...ownMessages, ...otherMessages].slice(0, limit)
  }

  async getApproval(approvalId) {
    const item = this.approvals.get(approvalId)
    if (!item) throw notFound('审批单不存在')
    return this.withFoodDecision(item)
  }

  async createApproval(input, openid) {
    const createdAt = now()
    const approval = {
      _id: newId(),
      _openid: openid,
      ...input,
      status: 'pending',
      support: 0,
      against: 0,
      totalVotes: 0,
      supportRate: 0,
      tags: ['新提交'],
      emoji: '🍽️',
      createdAt,
      updatedAt: createdAt,
    }
    this.approvals.set(approval._id, approval)
    // 审批单创建时建立个人记录，保证“我的”页面能追踪这张审批单的后续状态。
    const record = recordFor(approval, openid, createdAt)
    this.records.set(record._id, record)
    return approval
  }

  async createVote(approvalId, input, openid) {
    const approval = await this.getApproval(approvalId)
    if (approval._openid === openid) throw conflict('SELF_VOTE_NOT_ALLOWED', '不能给自己发起的审批投票')
    if (!isApprovalWithinValidity(approval.createdAt)) throw conflict('APPROVAL_EXPIRED', '这张审批单已过期')
    // 复合键同时承担幂等约束：同一用户对同一审批单只能产生一票。
    const voteId = `${approvalId}:${openid}`
    if (this.votes.has(voteId)) throw conflict('DUPLICATE_VOTE', '你已经投过这张审批单')
    if (approval.foodDecided) throw conflict('APPROVAL_CLOSED', '发起人已选择吃了或没吃，不能继续投票')
    if (approval.status !== 'pending') throw conflict('APPROVAL_CLOSED', '这张审批单已经完成审批')
    const support = approval.support + (input.choice === 'approve' ? 1 : 0)
    const against = approval.against + (input.choice === 'wait' ? 1 : 0)
    const result = calculateStatus(support, against)
    const updated = { ...approval, support, against, ...result, updatedAt: now() }
    this.votes.set(voteId, { _id: voteId, _openid: openid, approvalId, ...input, createdAt: now() })
    this.approvals.set(approvalId, updated)
    for (const record of this.records.values()) {
      if (record.approvalId === approvalId && record._openid === approval._openid) {
        record.status = updated.status
        record.updatedAt = updated.updatedAt
      }
    }
    return updated
  }

  async listRecords(openid) {
    const reference = new Date()
    const records = [...this.records.values()]
      .filter(item => item._openid === openid)
    return mergeApprovalRecords(records, [...this.approvals.values()], openid, reference)
  }

  async createFoodRecord(input, openid) {
    const record = foodRecordFor(input, openid)
    this.records.set(record._id, record)
    return record
  }

  async recordApprovalFood(input, openid) {
    const record = [...this.records.values()].find(item => item.approvalId === input.approvalId && item._openid === openid)
    if (!record) throw notFound('没有找到这张审批单的个人记录')
    if (record.foodRecorded) return record
    if (record.checkinResult) throw conflict('RECORD_ALREADY_DECIDED', '这张审批单已经记录过结果')
    if (!isApprovalWithinValidity(record.createdAt)) throw conflict('APPROVAL_EXPIRED', '这张审批单已过期')
    if (record.status !== 'approved') throw conflict('RECORD_NOT_ALLOWED', '审批通过后才能添加食物')
    // 更新原记录，避免同一顿食物生成两条记录、重复计算热量。
    Object.assign(record, { title: input.title, calorie: input.calorie, image: input.image, foodRecorded: true, updatedAt: now() })
    return record
  }

  async checkIn(approvalId, result, openid) {
    const record = [...this.records.values()].find(item => item.approvalId === approvalId && item._openid === openid)
    if (!record) throw notFound('没有找到这张审批单的个人记录')
    if (record.foodRecorded) throw conflict('RECORD_ALREADY_DECIDED', '这张审批单已经记录为吃了')
    if (record.checkinResult) {
      if (record.checkinResult === result) return record
      throw conflict('RECORD_ALREADY_DECIDED', '这张审批单已经记录过结果')
    }
    if (!isApprovalWithinValidity(record.createdAt)) throw conflict('APPROVAL_EXPIRED', '这张审批单已过期')
    if (record.status !== 'approved') throw conflict('CHECKIN_NOT_ALLOWED', '审批通过后才能打卡')
    record.checkinResult = result
    record.updatedAt = now()
    return record
  }

  async getStats(openid) {
    const reference = new Date()
    const records = [...this.records.values()]
      .filter(item => item._openid === openid)
      .map(item => resolveRecordOutcome(item, reference))
    return calculateStats(records)
  }
}

function cloudData(result) {
  if (!result) return null
  if (Array.isArray(result.data)) return result.data[0] || null
  return result.data || null
}

class CloudBaseRepository {
  constructor(db) {
    this.mode = 'cloudbase'
    this.db = db
  }

  collection(name) {
    return this.db.collection(name)
  }

  async listApprovals({ status = 'all', limit = 50 } = {}) {
    const reference = new Date()
    let query = this.collection(COLLECTIONS.approvals)
    if (status !== 'all') query = query.where({ status })
    const result = await query.orderBy('createdAt', 'desc').limit(limit).get()
    return this.withFoodDecisions((result.data || []).filter(item => isApprovalWithinValidity(item.createdAt, reference)), reference)
  }

  async withFoodDecisions(items, reference = new Date()) {
    if (!items.length) return []
    // 每张审批只有一条个人记录，批量读取避免广场列表逐条查询。
    const result = await this.collection(COLLECTIONS.records).where({ approvalId: this.db.command.in(items.map(item => item._id)) }).limit(items.length).get()
    return items.map(item => {
      const record = (result.data || []).find(record => record.approvalId === item._id && record._openid === item._openid)
      const resolved = resolveRecordOutcome(record, reference)
      const decorated = { ...item, foodDecided: Boolean(resolved && (resolved.foodRecorded || resolved.checkinResult)), foodResult: resolved && (resolved.foodRecorded || resolved.checkinResult === '真香') ? 'eaten' : resolved && resolved.checkinResult === '后悔' ? 'skipped' : '' }
      return resolveApprovalOutcome(decorated, record, reference)
    })
  }

  async listFoods({ keyword = '', limit = 5 } = {}) {
    return searchFoods(keyword, limit)
  }

  async listApprovalMessages(openid, limit = 10) {
    const ownApprovals = await this.listApprovals({ status: 'all', limit: 100 })
    const ownApprovalIds = new Set(ownApprovals.filter(item => item._openid === openid).map(item => item._id))
    const result = await this.collection(COLLECTIONS.votes).orderBy('createdAt', 'desc').limit(100).get()
    const messages = result.data || []
    const ownMessages = messages.filter(item => ownApprovalIds.has(item.approvalId))
    const otherMessages = messages.filter(item => !ownApprovalIds.has(item.approvalId))
    return [...ownMessages, ...otherMessages].slice(0, limit)
  }

  async getApproval(approvalId) {
    const item = cloudData(await this.collection(COLLECTIONS.approvals).doc(approvalId).get())
    if (!item) throw notFound('审批单不存在')
    return (await this.withFoodDecisions([item]))[0]
  }

  async createApproval(input, openid) {
    const createdAt = now()
    const approval = {
      _id: newId(),
      _openid: openid,
      ...input,
      status: 'pending',
      support: 0,
      against: 0,
      totalVotes: 0,
      supportRate: 0,
      tags: ['新提交'],
      emoji: '🍽️',
      createdAt,
      updatedAt: createdAt,
    }
    const record = recordFor(approval, openid, createdAt)
    const persist = async database => {
      await database.collection(COLLECTIONS.approvals).doc(approval._id).set(withoutId(approval))
      await database.collection(COLLECTIONS.records).doc(record._id).set(withoutId(record))
    }
    if (typeof this.db.runTransaction === 'function') await this.db.runTransaction(persist)
    else await persist(this.db)
    return approval
  }

  async createVote(approvalId, input, openid) {
    const voteId = `${approvalId}:${openid}`
    const run = async tx => {
      const approvalCollection = tx.collection(COLLECTIONS.approvals)
      const voteCollection = tx.collection(COLLECTIONS.votes)
      const existing = cloudData(await voteCollection.doc(voteId).get())
      if (existing) throw conflict('DUPLICATE_VOTE', '你已经投过这张审批单')
      const approval = cloudData(await approvalCollection.doc(approvalId).get())
      if (!approval) throw notFound('审批单不存在')
      if (approval._openid === openid) throw conflict('SELF_VOTE_NOT_ALLOWED', '不能给自己发起的审批投票')
      if (!isApprovalWithinValidity(approval.createdAt)) throw conflict('APPROVAL_EXPIRED', '这张审批单已过期')
      const records = await tx.collection(COLLECTIONS.records).where({ approvalId, _openid: approval._openid }).get()
      if ((records.data || []).some(record => record.foodRecorded || record.checkinResult)) throw conflict('APPROVAL_CLOSED', '发起人已选择吃了或没吃，不能继续投票')
      if (approval.status !== 'pending') throw conflict('APPROVAL_CLOSED', '这张审批单已经完成审批')
      const support = approval.support + (input.choice === 'approve' ? 1 : 0)
      const against = approval.against + (input.choice === 'wait' ? 1 : 0)
      const result = calculateStatus(support, against)
      const updatedAt = now()
      await voteCollection.doc(voteId).set({ _openid: openid, approvalId, ...input, createdAt: updatedAt })
      await approvalCollection.doc(approvalId).update({ support, against, ...result, updatedAt })
      for (const record of records.data || []) {
        await tx.collection(COLLECTIONS.records).doc(record._id).update({ status: result.status, updatedAt })
      }
      return { ...approval, support, against, ...result, updatedAt }
    }
    if (typeof this.db.runTransaction === 'function') return this.db.runTransaction(run)

    // 旧版 SDK 没有事务时仍保留唯一投票键，避免同一用户重复投票。
    const existing = cloudData(await this.collection(COLLECTIONS.votes).doc(voteId).get())
    if (existing) throw conflict('DUPLICATE_VOTE', '你已经投过这张审批单')
    const approval = await this.getApproval(approvalId)
    if (approval._openid === openid) throw conflict('SELF_VOTE_NOT_ALLOWED', '不能给自己发起的审批投票')
    if (!isApprovalWithinValidity(approval.createdAt)) throw conflict('APPROVAL_EXPIRED', '这张审批单已过期')
    if (approval.foodDecided) throw conflict('APPROVAL_CLOSED', '发起人已选择吃了或没吃，不能继续投票')
    if (approval.status !== 'pending') throw conflict('APPROVAL_CLOSED', '这张审批单已经完成审批')
    const support = approval.support + (input.choice === 'approve' ? 1 : 0)
    const against = approval.against + (input.choice === 'wait' ? 1 : 0)
    const result = calculateStatus(support, against)
    const updatedAt = now()
    await this.collection(COLLECTIONS.votes).doc(voteId).set({ _openid: openid, approvalId, ...input, createdAt: updatedAt })
    await this.collection(COLLECTIONS.approvals).doc(approvalId).update({ support, against, ...result, updatedAt })
    const records = await this.collection(COLLECTIONS.records).where({ approvalId, _openid: approval._openid }).get()
    for (const record of records.data || []) {
      await this.collection(COLLECTIONS.records).doc(record._id).update({ status: result.status, updatedAt })
    }
    return { ...approval, support, against, ...result, updatedAt }
  }

  async listRecords(openid) {
    const reference = new Date()
    const result = await this.collection(COLLECTIONS.records).where({ _openid: openid }).orderBy('createdAt', 'desc').limit(100).get()
    const approvals = await this.collection(COLLECTIONS.approvals).where({ _openid: openid }).limit(100).get()
    return mergeApprovalRecords(result.data || [], approvals.data || [], openid, reference)
  }

  async createFoodRecord(input, openid) {
    const record = foodRecordFor(input, openid)
    await this.collection(COLLECTIONS.records).doc(record._id).set(withoutId(record))
    return record
  }

  async recordApprovalFood(input, openid) {
    const query = await this.collection(COLLECTIONS.records).where({ approvalId: input.approvalId, _openid: openid }).limit(1).get()
    const record = query.data && query.data[0]
    if (!record) throw notFound('没有找到这张审批单的个人记录')
    if (record.foodRecorded) return record
    if (record.checkinResult) throw conflict('RECORD_ALREADY_DECIDED', '这张审批单已经记录过结果')
    if (!isApprovalWithinValidity(record.createdAt)) throw conflict('APPROVAL_EXPIRED', '这张审批单已过期')
    if (record.status !== 'approved') throw conflict('RECORD_NOT_ALLOWED', '审批通过后才能添加食物')
    const update = { title: input.title, calorie: input.calorie, image: input.image, foodRecorded: true, updatedAt: now() }
    await this.collection(COLLECTIONS.records).doc(record._id).update(update)
    return { ...record, ...update }
  }

  async checkIn(approvalId, result, openid) {
    const query = await this.collection(COLLECTIONS.records).where({ approvalId, _openid: openid }).limit(1).get()
    const record = query.data && query.data[0]
    if (!record) throw notFound('没有找到这张审批单的个人记录')
    if (record.foodRecorded) throw conflict('RECORD_ALREADY_DECIDED', '这张审批单已经记录为吃了')
    if (record.checkinResult) {
      if (record.checkinResult === result) return record
      throw conflict('RECORD_ALREADY_DECIDED', '这张审批单已经记录过结果')
    }
    if (!isApprovalWithinValidity(record.createdAt)) throw conflict('APPROVAL_EXPIRED', '这张审批单已过期')
    if (record.status !== 'approved') throw conflict('CHECKIN_NOT_ALLOWED', '审批通过后才能打卡')
    const updatedAt = now()
    await this.collection(COLLECTIONS.records).doc(record._id).update({ checkinResult: result, updatedAt })
    return { ...record, checkinResult: result, updatedAt }
  }

  async getStats(openid) {
    const reference = new Date()
    const result = await this.collection(COLLECTIONS.records).where({ _openid: openid }).orderBy('createdAt', 'desc').limit(1000).get()
    return calculateStats((result.data || []).map(item => resolveRecordOutcome(item, reference)))
  }
}

function createRepository({ envId = process.env.TCB_ENV_ID || process.env.CLOUDBASE_ENV_ID, forceMemory = process.env.USE_MEMORY_DB === '1', driver = process.env.DB_DRIVER || '' } = {}) {
  if (forceMemory) return new MemoryRepository()
  if (driver === 'mysql') {
    const { MySQLRepository, createMySQLPool } = require('./mysql-repository')
    return new MySQLRepository(createMySQLPool())
  }
  if (process.env.NODE_ENV !== 'production' && !envId) return new MemoryRepository()
  if (!envId) throw new Error('生产环境必须配置 TCB_ENV_ID 或 CLOUDBASE_ENV_ID')
  let cloudbase
  try {
    cloudbase = require('@cloudbase/node-sdk')
  } catch (error) {
    throw new Error(`CloudBase SDK 加载失败: ${error.message}`)
  }
  const app = cloudbase.init({ env: envId })
  return new CloudBaseRepository(app.database())
}

module.exports = { COLLECTIONS, CloudBaseRepository, MemoryRepository, createRepository, calculateStatus, calculateStats, mergeApprovalRecords, searchFoods }
