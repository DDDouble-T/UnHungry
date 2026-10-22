const express = require('express')
const crypto = require('node:crypto')
const { createRepository } = require('./repository')
const { HttpError, notFound, unauthorized } = require('./errors')
const { approval, record, stats } = require('./serializers')
const {
  validateApprovalInput,
  validateVoteInput,
  validateCheckinInput,
  status,
  id,
  limit,
} = require('./validation')

function openidFrom(request) {
  const value = request.get('x-wx-openid') || request.get('x-wx-open-id') || request.get('x-openid')
  if (value && value.trim()) return value.trim()
  const devValue = request.get('x-dev-openid')
  if (process.env.NODE_ENV !== 'production' && devValue && devValue.trim()) return devValue.trim()
  if (process.env.REQUIRE_OPENID !== 'true') return 'anonymous'
  throw unauthorized()
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next)
}

function createApp({ repository = createRepository() } = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.use((request, response, next) => {
    const requestId = request.get('x-request-id') || crypto.randomUUID()
    response.set('x-request-id', requestId)
    response.set('access-control-allow-origin', '*')
    response.set('access-control-allow-headers', 'content-type,x-wx-openid,x-dev-openid,x-request-id')
    response.set('access-control-allow-methods', 'GET,POST,OPTIONS')
    if (request.method === 'OPTIONS') return response.status(204).end()
    next()
  })
  app.use(express.json({ limit: process.env.BODY_LIMIT || '64kb' }))

  app.get('/health', (request, response) => response.json({ data: { status: 'ok', service: 'unhungry-api', database: repository.mode, timestamp: new Date().toISOString() } }))
  app.get('/api/v1', (request, response) => response.json({ data: { name: 'unhungry-api', version: 'v1', endpoints: ['/api/v1/approvals', '/api/v1/me/records', '/api/v1/me/stats'] } }))

  app.get('/api/v1/approvals', asyncRoute(async (request, response) => {
    const items = await repository.listApprovals({ status: status(request.query.status), limit: limit(request.query.limit) })
    response.json({ data: items.map(approval) })
  }))

  app.get('/api/v1/approvals/:approvalId', asyncRoute(async (request, response) => {
    const item = await repository.getApproval(id(request.params.approvalId, 'approvalId'))
    response.json({ data: approval(item) })
  }))

  app.post('/api/v1/approvals', asyncRoute(async (request, response) => {
    const item = await repository.createApproval(validateApprovalInput(request.body), openidFrom(request))
    response.status(201).json({ data: approval(item) })
  }))

  app.post('/api/v1/approvals/:approvalId/votes', asyncRoute(async (request, response) => {
    const item = await repository.createVote(id(request.params.approvalId, 'approvalId'), validateVoteInput(request.body), openidFrom(request))
    response.status(201).json({ data: approval(item) })
  }))

  app.get('/api/v1/me/records', asyncRoute(async (request, response) => {
    const items = await repository.listRecords(openidFrom(request))
    response.json({ data: items.map(record) })
  }))

  app.get('/api/v1/me/stats', asyncRoute(async (request, response) => {
    response.json({ data: stats(await repository.getStats(openidFrom(request))) })
  }))

  app.post('/api/v1/me/records/:approvalId/checkin', asyncRoute(async (request, response) => {
    const item = await repository.checkIn(id(request.params.approvalId, 'approvalId'), validateCheckinInput(request.body).result, openidFrom(request))
    response.json({ data: record(item) })
  }))

  app.use((request, response, next) => next(notFound('接口不存在')))
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error)
    const normalized = error instanceof HttpError
      ? error
      : error instanceof SyntaxError && error.status === 400
        ? new HttpError(400, 'INVALID_JSON', '请求体必须是合法 JSON')
        : error && error.type === 'entity.too.large'
          ? new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体不能超过 64KB')
        : new HttpError(500, 'INTERNAL_ERROR', '服务暂时不可用')
    if (normalized.status >= 500) console.error(`[${response.get('x-request-id')}]`, error)
    response.status(normalized.status).json({ error: { code: normalized.code, message: normalized.message, ...(normalized.details ? { details: normalized.details } : {}) } })
  })
  return app
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000)
  const app = createApp()
  app.listen(port, '0.0.0.0', () => console.log(`unhungry-api listening on ${port}`))
}

module.exports = { createApp, openidFrom }
