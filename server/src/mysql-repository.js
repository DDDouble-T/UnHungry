const crypto = require('node:crypto')
const { conflict, notFound } = require('./errors')

function now() {
  return new Date()
}

function newId() {
  return crypto.randomUUID()
}

function json(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function approvalRow(row) {
  return row ? { ...row, _id: row.id, _openid: row.openid, isAnonymous: row.isAnonymous === undefined || Boolean(row.isAnonymous), tags: json(row.tags, []), price: row.price === null ? null : Number(row.price), calorie: row.calorie === null ? null : Number(row.calorie), support: Number(row.support), against: Number(row.against), totalVotes: Number(row.totalVotes), supportRate: Number(row.supportRate) } : row
}

function recordRow(row) {
  return row ? { ...row, calorie: row.calorie === null ? null : Number(row.calorie) } : row
}

function calculateStatus(support, against) {
  const totalVotes = support + against
  const supportRate = totalVotes ? Math.round((support / totalVotes) * 100) : 0
  const status = supportRate >= 50 ? 'approved' : against > support ? 'rejected' : 'pending'
  return { totalVotes, supportRate, status }
}

class MySQLRepository {
  constructor(pool, { mode = 'mysql' } = {}) {
    this.mode = mode
    this.pool = pool
  }

  async listApprovals({ status = 'all', limit = 50 } = {}) {
    const params = []
    let sql = 'SELECT * FROM approvals'
    if (status !== 'all') { sql += ' WHERE status = ?'; params.push(status) }
    sql += ' ORDER BY createdAt DESC LIMIT ?'
    params.push(Number(limit))
    const [rows] = await this.pool.execute(sql, params)
    return rows.map(approvalRow)
  }

  async listFoods({ keyword = '', limit = 5 } = {}) {
    // 食物库仍随镜像发布，避免为静态检索额外维护一张 MySQL 表。
    const { searchFoods } = require('./repository')
    return searchFoods(keyword, limit)
  }

  async getApproval(approvalId) {
    const [rows] = await this.pool.execute('SELECT * FROM approvals WHERE id = ?', [approvalId])
    const item = approvalRow(rows[0])
    if (!item) throw notFound('审批单不存在')
    item._id = item.id
    return item
  }

  async createApproval(input, openid) {
    const createdAt = now()
    const id = newId()
    const approval = {
      _id: id, _openid: openid, ...input, status: 'pending', support: 0, against: 0,
      totalVotes: 0, supportRate: 0, tags: ['新提交'], emoji: '🍽️', createdAt, updatedAt: createdAt,
    }
    const record = { _id: newId(), _openid: openid, approvalId: id, title: approval.title, calorie: approval.calorie, status: approval.status, checkinResult: '', createdAt, updatedAt: createdAt }
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.execute('INSERT INTO approvals (id, openid, authorName, authorAvatar, isAnonymous, title, price, calorie, reason, alternative, intake, image, status, support, against, totalVotes, supportRate, tags, emoji, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, openid, approval.authorName, approval.authorAvatar, approval.isAnonymous, approval.title, approval.price, approval.calorie, approval.reason, approval.alternative, approval.intake, approval.image, approval.status, 0, 0, 0, 0, JSON.stringify(approval.tags), approval.emoji, createdAt, createdAt])
      await connection.execute('INSERT INTO user_records (id, openid, approvalId, title, calorie, status, checkinResult, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [record._id, openid, id, record.title, record.calorie, record.status, '', createdAt, createdAt])
      await connection.commit()
      return approval
    } catch (error) {
      await connection.rollback()
      throw error
    } finally { connection.release() }
  }

  async createVote(approvalId, input, openid) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [votes] = await connection.execute('SELECT id FROM approval_votes WHERE approvalId = ? AND openid = ? FOR UPDATE', [approvalId, openid])
      if (votes.length) throw conflict('DUPLICATE_VOTE', '你已经投过这张审批单')
      const [rows] = await connection.execute('SELECT * FROM approvals WHERE id = ? FOR UPDATE', [approvalId])
      const approval = approvalRow(rows[0])
      if (!approval) throw notFound('审批单不存在')
      if (approval.status !== 'pending') throw conflict('APPROVAL_CLOSED', '这张审批单已经完成审批')
      const support = approval.support + (input.choice === 'approve' ? 1 : 0)
      const against = approval.against + (input.choice === 'wait' ? 1 : 0)
      const result = calculateStatus(support, against)
      const updatedAt = now()
      await connection.execute('INSERT INTO approval_votes (id, approvalId, openid, choice, reason, createdAt) VALUES (?, ?, ?, ?, ?, ?)', [`${approvalId}:${openid}`, approvalId, openid, input.choice, input.reason, updatedAt])
      await connection.execute('UPDATE approvals SET support = ?, against = ?, totalVotes = ?, supportRate = ?, status = ?, updatedAt = ? WHERE id = ?', [support, against, result.totalVotes, result.supportRate, result.status, updatedAt, approvalId])
      await connection.execute('UPDATE user_records SET status = ?, updatedAt = ? WHERE approvalId = ? AND openid = ?', [result.status, updatedAt, approvalId, approval._openid])
      await connection.commit()
      return { ...approval, support, against, ...result, updatedAt }
    } catch (error) {
      await connection.rollback()
      if (error && error.code === 'ER_DUP_ENTRY') throw conflict('DUPLICATE_VOTE', '你已经投过这张审批单')
      throw error
    } finally { connection.release() }
  }

  async listRecords(openid) {
    const [rows] = await this.pool.execute('SELECT id AS _id, openid AS _openid, approvalId, title, calorie, status, checkinResult, image, createdAt, updatedAt FROM user_records WHERE openid = ? ORDER BY createdAt DESC LIMIT 100', [openid])
    return rows.map(recordRow)
  }

  async createFoodRecord(input, openid) {
    const id = newId()
    const createdAt = now()
    await this.pool.execute('INSERT INTO user_records (id, openid, approvalId, title, calorie, image, status, checkinResult, createdAt, updatedAt) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)', [id, openid, input.title, input.calorie, input.image, 'logged', '', createdAt, createdAt])
    return { _id: id, _openid: openid, title: input.title, calorie: input.calorie, image: input.image, status: 'logged', checkinResult: '', createdAt, updatedAt: createdAt }
  }

  async checkIn(approvalId, result, openid) {
    const [rows] = await this.pool.execute('SELECT id AS _id, openid AS _openid, approvalId, title, calorie, status, checkinResult, image, createdAt, updatedAt FROM user_records WHERE approvalId = ? AND openid = ? LIMIT 1', [approvalId, openid])
    const record = recordRow(rows[0])
    if (!record) throw notFound('没有找到这张审批单的个人记录')
    if (record.status !== 'approved') throw conflict('CHECKIN_NOT_ALLOWED', '审批通过后才能打卡')
    const updatedAt = now()
    await this.pool.execute('UPDATE user_records SET checkinResult = ?, updatedAt = ? WHERE id = ?', [result, updatedAt, record._id])
    return { ...record, checkinResult: result, updatedAt }
  }

  async getStats(openid) {
    const { calculateStats } = require('./repository')
    return calculateStats(await this.listRecords(openid))
  }
}

function createMySQLPool() {
  const mysql = require('mysql2/promise')
  const address = process.env.MYSQL_ADDRESS || ''
  const addressParts = address.match(/^([^:]+)(?::(\d+))?$/)
  const host = process.env.MYSQL_HOST || addressParts?.[1]
  const port = Number(process.env.MYSQL_PORT || addressParts?.[2] || 3306)
  const user = process.env.MYSQL_USER || process.env.MYSQL_USERNAME
  const options = process.env.MYSQL_URL
    ? process.env.MYSQL_URL
    : { host, port, user, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE, connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 5), dateStrings: true }
  if (!process.env.MYSQL_URL && (!options.host || !options.user || !options.database)) throw new Error('MySQL 模式必须配置 MYSQL_ADDRESS/ MYSQL_HOST、MYSQL_USERNAME/ MYSQL_USER、MYSQL_DATABASE')
  return mysql.createPool(options)
}

module.exports = { MySQLRepository, createMySQLPool }
