const test = require('node:test')
const assert = require('node:assert/strict')
const { createApp } = require('../src/app')
const { MemoryRepository } = require('../src/repository')

let server
let baseUrl
const notifications = []
let failNotifications = false

test.before(async () => {
  const app = createApp({
    repository: new MemoryRepository(),
    notifier: {
      async sendApprovalUpdate(payload) {
        notifications.push(payload)
        if (failNotifications) throw new Error('微信暂时不可用')
      },
    },
  })
  server = await new Promise(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value))
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

test.after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  })
  const body = await response.json()
  return { response, body }
}

test('health exposes service and storage mode', async () => {
  const { response, body } = await request('/health')
  assert.equal(response.status, 200)
  assert.equal(body.data.status, 'ok')
  assert.equal(body.data.database, 'memory')
})

test('memory repository starts without demo approvals', async () => {
  const { response, body } = await request('/api/v1/approvals')
  assert.equal(response.status, 200)
  assert.deepEqual(body.data, [])
})

test('API metadata lists all business routes', async () => {
  const { response, body } = await request('/api/v1')
  assert.equal(response.status, 200)
  assert.deepEqual(body.data.endpoints, [
    '/api/v1/approvals',
    '/api/v1/approvals/:approvalId',
    '/api/v1/approvals/:approvalId/votes',
    '/api/v1/me/records',
    '/api/v1/me/records/:approvalId/checkin',
    '/api/v1/me/stats',
  ])
})

test('approval flow creates a record, closes after vote and supports check-in', async () => {
  notifications.length = 0
  const owner = { 'x-dev-openid': 'owner-1' }
  const voter = { 'x-dev-openid': 'voter-1' }
  const { response: createResponse, body: createBody } = await request('/api/v1/approvals', {
    method: 'POST',
    headers: owner,
    body: JSON.stringify({ title: '烤冷面', price: '15', calorie: 420, reason: '今天辛苦了', alternative: '鸡蛋蔬菜卷' }),
  })
  assert.equal(createResponse.status, 201)
  assert.equal(createBody.data.status, 'pending')
  assert.equal(createBody.data.price, 15)
  const approvalId = createBody.data.id

  const { body: recordsBody } = await request('/api/v1/me/records', { headers: owner })
  assert.equal(recordsBody.data.length, 1)
  assert.equal(recordsBody.data[0].status, 'pending')

  const { response: voteResponse, body: voteBody } = await request(`/api/v1/approvals/${approvalId}/votes`, {
    method: 'POST',
    headers: voter,
    body: JSON.stringify({ choice: 'approve', reason: '偶尔吃一次没问题' }),
  })
  assert.equal(voteResponse.status, 201)
  assert.equal(voteBody.data.status, 'approved')
  assert.equal(voteBody.data.supportRate, 100)
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].openid, 'owner-1')
  assert.equal(notifications[0].approval._id, approvalId)
  assert.equal(notifications[0].choice, 'approve')

  const duplicate = await request(`/api/v1/approvals/${approvalId}/votes`, {
    method: 'POST',
    headers: voter,
    body: JSON.stringify({ choice: 'approve', reason: '重复提交' }),
  })
  assert.equal(duplicate.response.status, 409)
  assert.equal(duplicate.body.error.code, 'DUPLICATE_VOTE')

  const { body: updatedRecords } = await request('/api/v1/me/records', { headers: owner })
  assert.equal(updatedRecords.data[0].status, 'approved')

  const checkin = await request(`/api/v1/me/records/${approvalId}/checkin`, {
    method: 'POST',
    headers: owner,
    body: JSON.stringify({ result: '真香' }),
  })
  assert.equal(checkin.response.status, 200)
  assert.equal(checkin.body.data.checkinResult, '真香')
})

test('a failed subscription message does not turn a committed vote into an API failure', async () => {
  failNotifications = true
  const { body: created } = await request('/api/v1/approvals', {
    method: 'POST',
    headers: { 'x-dev-openid': 'owner-2' },
    body: JSON.stringify({ title: '豆花', price: 12, reason: '想吃甜的', alternative: '无糖酸奶' }),
  })
  const result = await request(`/api/v1/approvals/${created.data.id}/votes`, {
    method: 'POST',
    headers: { 'x-dev-openid': 'voter-2' },
    body: JSON.stringify({ choice: 'wait', reason: '先吃正餐' }),
  })
  failNotifications = false
  assert.equal(result.response.status, 201)
  assert.equal(result.body.data.status, 'rejected')
})

test('invalid input is rejected with a stable error contract', async () => {
  const result = await request('/api/v1/approvals', {
    method: 'POST',
    body: JSON.stringify({ title: '', price: -1 }),
  })
  assert.equal(result.response.status, 400)
  assert.equal(result.body.error.code, 'INVALID_FIELD')
})

test('malformed JSON is rejected as a client error', async () => {
  const result = await request('/api/v1/approvals', {
    method: 'POST',
    body: '{"title":',
  })
  assert.equal(result.response.status, 400)
  assert.equal(result.body.error.code, 'INVALID_JSON')
})
