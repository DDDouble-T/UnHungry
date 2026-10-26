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
    '/api/v1/foods',
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

test('food search and independent food records are served by the backend', async () => {
  const foods = await request('/api/v1/foods?keyword=%E9%B8%A1%E8%9B%8B&limit=5')
  assert.equal(foods.response.status, 200)
  assert.ok(foods.body.data.length > 0)
  assert.ok(foods.body.data.some(item => item.name.includes('鸡蛋')))

  const owner = { 'x-dev-openid': 'food-log-owner' }
  const created = await request('/api/v1/me/records', {
    method: 'POST',
    headers: owner,
    body: JSON.stringify({ title: '米饭', calorie: 230 }),
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.data.status, 'logged')
  assert.equal(created.body.data.title, '米饭')

  const listed = await request('/api/v1/me/records', { headers: owner })
  assert.equal(listed.body.data.length, 1)
  assert.equal(listed.body.data[0].id, created.body.data.id)
  const stats = await request('/api/v1/me/stats', { headers: owner })
  assert.equal(stats.body.data.todayCalories, 230)
  assert.equal(stats.body.data.submittedCount, 0)
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


test('approval names default to public and anonymous names stay private across reads and votes', async () => {
  const named = await request('/api/v1/approvals', {
    method: 'POST',
    body: JSON.stringify({ title: '粥', reason: '饿了', authorName: ' 小明 ', authorAvatar: 'cloud://avatars/xiaoming.jpg' }),
  })
  assert.equal(named.response.status, 201)
  assert.equal(named.body.data.isAnonymous, false)
  assert.equal(named.body.data.authorName, '小明')
  assert.equal(named.body.data.authorAvatar, 'cloud://avatars/xiaoming.jpg')
  const namedDetail = await request(`/api/v1/approvals/${named.body.data.id}`)
  assert.equal(namedDetail.body.data.authorName, '小明')
  assert.equal(namedDetail.body.data.authorAvatar, 'cloud://avatars/xiaoming.jpg')

  const anonymous = await request('/api/v1/approvals', {
    method: 'POST',
    body: JSON.stringify({ title: '苹果', reason: '想吃水果', authorName: '秘密昵称', authorAvatar: 'cloud://avatars/secret.jpg', isAnonymous: true }),
  })
  assert.equal(anonymous.response.status, 201)
  assert.equal(anonymous.body.data.isAnonymous, true)
  assert.equal(anonymous.body.data.authorName, '')
  assert.equal(anonymous.body.data.authorAvatar, '')
  const approvalId = anonymous.body.data.id
  const detail = await request(`/api/v1/approvals/${approvalId}`)
  assert.equal(detail.body.data.isAnonymous, true)
  assert.equal(detail.body.data.authorName, '')
  assert.equal(detail.body.data.authorAvatar, '')
  const list = await request('/api/v1/approvals')
  assert.equal(list.body.data.find(item => item.id === approvalId).authorName, '')
  assert.equal(JSON.stringify(list.body).includes('秘密昵称'), false)
  assert.equal(JSON.stringify(list.body).includes('secret.jpg'), false)
  const voted = await request(`/api/v1/approvals/${approvalId}/votes`, {
    method: 'POST', headers: { 'x-dev-openid': 'privacy-voter' },
    body: JSON.stringify({ choice: 'approve', reason: '水果不错' }),
  })
  assert.equal(voted.response.status, 201)
  assert.equal(voted.body.data.authorName, '')
  assert.equal(voted.body.data.authorAvatar, '')
  assert.equal(voted.body.data.isAnonymous, true)
  assert.equal('_openid' in voted.body.data, false)
})

test('approval privacy validates booleans and name length', async () => {
  for (const isAnonymous of ['false', 'true', 0, 1, null, {}, []]) {
    const result = await request('/api/v1/approvals', {
      method: 'POST', body: JSON.stringify({ title: '粥', reason: '饿了', isAnonymous }),
    })
    assert.equal(result.response.status, 400)
  }
  const longName = await request('/api/v1/approvals', {
    method: 'POST', body: JSON.stringify({ title: '粥', reason: '饿了', authorName: '名'.repeat(33) }),
  })
  assert.equal(longName.response.status, 400)
  const { approval } = require('../src/serializers')
  assert.equal(approval({ _id: 'legacy', authorName: '旧名称' }).isAnonymous, true)
  assert.equal(approval({ _id: 'legacy', authorName: '旧名称' }).authorName, '')
  assert.equal(approval({ _id: 'legacy', authorAvatar: 'cloud://secret' }).authorAvatar, '')
  const { validateApprovalInput } = require('../src/validation')
  const hidden = validateApprovalInput({ title: '粥', reason: '饿了', isAnonymous: true, authorName: '秘密昵称', authorAvatar: 'cloud://secret' })
  assert.equal(hidden.authorName, '')
  assert.equal(hidden.authorAvatar, '')
})


test('avatar input rejects invalid types and oversize values', async () => {
  for (const authorAvatar of [42, {}, 'x'.repeat(2049)]) {
    const result = await request('/api/v1/approvals', {
      method: 'POST', body: JSON.stringify({ title: '粥', reason: '饿了', authorAvatar }),
    })
    assert.equal(result.response.status, 400)
  }
})
