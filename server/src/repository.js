const crypto = require('node:crypto')
const { conflict, notFound } = require('./errors')

const COLLECTIONS = { approvals: 'approvals', votes: 'approval_votes', records: 'user_records' }
const STATUS_LABELS = { pending: '待审批', approved: '已通过', rejected: '先等等' }

function now() {
  return new Date().toISOString()
}

function newId() {
  return crypto.randomUUID()
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

function withoutId(value) {
  const { _id, ...data } = value
  return data
}

function calculateStats(records) {
  const approvedCount = records.filter(item => item.status === 'approved').length
  const rejected = records.filter(item => item.status === 'rejected')
  const rejectedNames = new Map()
  rejected.forEach(item => rejectedNames.set(item.title, (rejectedNames.get(item.title) || 0) + 1))
  const topRejected = [...rejectedNames.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''
  const today = new Date().toISOString().slice(0, 10)
  return {
    submittedCount: records.length,
    approvedCount,
    approvalRate: records.length ? Math.round((approvedCount / records.length) * 100) : 0,
    todayCalories: records.filter(item => item.createdAt.startsWith(today)).reduce((sum, item) => sum + (Number(item.calorie) || 0), 0),
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
    return [...this.approvals.values()]
      .filter(item => status === 'all' || item.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
  }

  async getApproval(approvalId) {
    const item = this.approvals.get(approvalId)
    if (!item) throw notFound('审批单不存在')
    return item
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
    // 复合键同时承担幂等约束：同一用户对同一审批单只能产生一票。
    const voteId = `${approvalId}:${openid}`
    if (this.votes.has(voteId)) throw conflict('DUPLICATE_VOTE', '你已经投过这张审批单')
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
    return [...this.records.values()]
      .filter(item => item._openid === openid)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async checkIn(approvalId, result, openid) {
    const record = [...this.records.values()].find(item => item.approvalId === approvalId && item._openid === openid)
    if (!record) throw notFound('没有找到这张审批单的个人记录')
    if (record.status !== 'approved') throw conflict('CHECKIN_NOT_ALLOWED', '审批通过后才能打卡')
    record.checkinResult = result
    record.updatedAt = now()
    return record
  }

  async getStats(openid) {
    return calculateStats(await this.listRecords(openid))
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
    let query = this.collection(COLLECTIONS.approvals)
    if (status !== 'all') query = query.where({ status })
    const result = await query.orderBy('createdAt', 'desc').limit(limit).get()
    return result.data || []
  }

  async getApproval(approvalId) {
    const item = cloudData(await this.collection(COLLECTIONS.approvals).doc(approvalId).get())
    if (!item) throw notFound('审批单不存在')
    return item
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
      if (approval.status !== 'pending') throw conflict('APPROVAL_CLOSED', '这张审批单已经完成审批')
      const support = approval.support + (input.choice === 'approve' ? 1 : 0)
      const against = approval.against + (input.choice === 'wait' ? 1 : 0)
      const result = calculateStatus(support, against)
      const updatedAt = now()
      await voteCollection.doc(voteId).set({ _openid: openid, approvalId, ...input, createdAt: updatedAt })
      await approvalCollection.doc(approvalId).update({ support, against, ...result, updatedAt })
      const records = await tx.collection(COLLECTIONS.records).where({ approvalId, _openid: approval._openid }).get()
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
    const result = await this.collection(COLLECTIONS.records).where({ _openid: openid }).orderBy('createdAt', 'desc').limit(100).get()
    return result.data || []
  }

  async checkIn(approvalId, result, openid) {
    const query = await this.collection(COLLECTIONS.records).where({ approvalId, _openid: openid }).limit(1).get()
    const record = query.data && query.data[0]
    if (!record) throw notFound('没有找到这张审批单的个人记录')
    if (record.status !== 'approved') throw conflict('CHECKIN_NOT_ALLOWED', '审批通过后才能打卡')
    const updatedAt = now()
    await this.collection(COLLECTIONS.records).doc(record._id).update({ checkinResult: result, updatedAt })
    return { ...record, checkinResult: result, updatedAt }
  }

  async getStats(openid) {
    return calculateStats(await this.listRecords(openid))
  }
}

function createRepository({ envId = process.env.TCB_ENV_ID || process.env.CLOUDBASE_ENV_ID, forceMemory = process.env.USE_MEMORY_DB === '1' } = {}) {
  if (forceMemory || (process.env.NODE_ENV !== 'production' && !envId)) return new MemoryRepository()
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

module.exports = { COLLECTIONS, CloudBaseRepository, MemoryRepository, createRepository, calculateStatus }
