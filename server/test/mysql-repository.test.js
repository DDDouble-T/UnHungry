const test = require('node:test')
const assert = require('node:assert/strict')
const { MySQLRepository } = require('../src/mysql-repository')

test('MySQL repository converts database rows to the application model', async () => {
  const calls = []
  const pool = {
    async execute(sql, params) {
      calls.push({ sql, params })
      return [[{
        id: 'approval-1', openid: 'owner-1', title: '烤冷面', price: '15.00', calorie: '420',
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
  assert.deepEqual(items[0].tags, ['新提交'])
  assert.match(calls[0].sql, /ORDER BY createdAt DESC LIMIT \?/)
})
