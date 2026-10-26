const test = require('node:test')
const assert = require('node:assert/strict')
const { MySQLRepository } = require('../src/mysql-repository')

test('MySQL repository converts database rows to the application model', async () => {
  const calls = []
  const pool = {
    async execute(sql, params) {
      calls.push({ sql, params })
      return [[{
        id: 'approval-1', openid: 'owner-1', authorName: '小明', authorAvatar: 'cloud://avatars/me.jpg', isAnonymous: 0, title: '烤冷面', price: '15.00', calorie: '420',
        reason: '今天辛苦了', alternative: '', intake: '', image: '', status: 'pending',
        support: 0, against: 0, totalVotes: 0, supportRate: 0, tags: '["新提交"]', emoji: '🍽️',
        createdAt: '2026-10-26 10:00:00.000', updatedAt: '2026-10-26 10:00:00.000',
      }]]
    },
  }
  const repository = new MySQLRepository(pool)
  const items = await repository.listApprovals({ limit: 10 })
  assert.equal(items[0]._id, 'approval-1')
  assert.equal(items[0]._openid, 'owner-1')
  assert.equal(items[0].price, 15)
  assert.equal(items[0].authorName, '小明')
  assert.equal(items[0].authorAvatar, 'cloud://avatars/me.jpg')
  assert.equal(items[0].isAnonymous, false)
  assert.deepEqual(items[0].tags, ['新提交'])
  assert.match(calls[0].sql, /ORDER BY createdAt DESC LIMIT \?/)
})


test('MySQL repository preserves anonymous and legacy row privacy', async () => {
  const { approval } = require('../src/serializers')
  const repository = new MySQLRepository({ async execute() { return [[
    { id: 'anonymous', isAnonymous: 1, authorName: '秘密昵称' },
    { id: 'legacy', authorName: '旧名称' },
  ]] } })
  for (const item of await repository.listApprovals({ limit: 10 })) {
    assert.equal(item.isAnonymous, true)
    assert.equal(approval(item).authorName, '')
  }
})

test('MySQL repository saves names and privacy flags with approval records', async () => {
  const calls = []
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, params) { calls.push({ sql, params }) },
  }
  const repository = new MySQLRepository({ async getConnection() { return connection } })
  await repository.createApproval({ title: '粥', reason: '饿了', authorName: '小明', authorAvatar: 'cloud://avatars/me.jpg', isAnonymous: false }, 'owner')
  const insert = calls.find(call => call.sql.startsWith('INSERT INTO approvals'))
  assert.match(insert.sql, /openid, authorName, authorAvatar, isAnonymous, title/)
  assert.deepEqual(insert.params.slice(1, 6), ['owner', '小明', 'cloud://avatars/me.jpg', false, '粥'])
  assert.equal((insert.sql.match(/\?/g) || []).length, insert.params.length)
})
