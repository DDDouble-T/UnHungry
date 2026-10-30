const test = require('node:test')
const assert = require('node:assert/strict')
const { MySQLRepository } = require('../src/mysql-repository')
const { APPROVAL_VALIDITY_MS } = require('../src/config')

function mysqlDate(value) {
  return value.toISOString().replace('T', ' ').replace('Z', '')
}

test('MySQL repository converts database rows to the application model', async () => {
  const calls = []
  const pool = {
    async execute(sql, params) {
      calls.push({ sql, params })
      return [[{
        id: 'approval-1', openid: 'owner-1', authorName: '小明', authorAvatar: 'cloud://avatars/me.jpg', isAnonymous: 0, title: '烤冷面', price: '15.00', calorie: '420',
        reason: '今天辛苦了', alternative: '', intake: '', image: '', status: 'pending',
        support: 0, against: 0, totalVotes: 0, supportRate: 0, tags: '["新提交"]', emoji: '🍽️',
        createdAt: mysqlDate(new Date(Date.now() - 60 * 60 * 1000)), updatedAt: mysqlDate(new Date()),
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


test('MySQL recording updates the owned approval record once', async () => {
  const row = { _id: 'record-1', approvalId: 'approval-1', status: 'approved', title: '米饭', calorie: 230, foodRecorded: 0, createdAt: mysqlDate(new Date()) }
  let writes = 0
  const repository = new MySQLRepository({ async execute(sql, params) {
    if (sql.startsWith('SELECT')) return [[{ ...row }]]
    assert.match(sql, /WHERE id = \? AND openid = \? AND foodRecorded = FALSE/)
    assert.equal(params[5], 'owner')
    writes++
    Object.assign(row, { title: params[0], calorie: params[1], image: params[2], foodRecorded: 1 })
    return [{ affectedRows: 1 }]
  } })
  const input = { approvalId: 'approval-1', title: '半碗米饭', calorie: 115, image: '' }
  const saved = await repository.recordApprovalFood(input, 'owner')
  assert.equal(saved.foodRecorded, 1)
  assert.equal(saved.calorie, 115)
  await repository.recordApprovalFood(input, 'owner')
  assert.equal(writes, 1)
})

test('MySQL rejects votes for decided food even when approval is pending', async () => {
  for (const record of [{ foodRecorded: 1 }, { checkinResult: '后悔' }, { checkinResult: '真香' }]) {
    let rolledBack = false
    const connection = {
      async beginTransaction() {},
      async rollback() { rolledBack = true },
      release() {},
      async execute(sql) {
        if (sql.includes('FROM approval_votes')) return [[]]
        if (sql.includes('FROM approvals')) {
          return [[{
            id: 'approval',
            openid: 'owner',
            status: 'pending',
            createdAt: mysqlDate(new Date()),
          }]]
        }
        if (sql.includes('FROM user_records')) return [[record]]
        assert.fail('已选择结果后不应写入投票')
      },
    }
    const repository = new MySQLRepository({ async getConnection() { return connection } })
    await assert.rejects(
      repository.createVote('approval', { choice: 'approve', reason: '可以吃' }, 'voter'),
      error => error.code === 'APPROVAL_CLOSED' && error.message.includes('已选择'),
    )
    assert.equal(rolledBack, true)
  }
})

test("MySQL recent records keep today's food and in-window approvals only", async () => {
  const today = new Date()
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const expired = new Date(Date.now() - APPROVAL_VALIDITY_MS - 1000)
  const rows = [
    { _id: 'today-food', title: '今天的饭', status: 'logged', createdAt: mysqlDate(today) },
    { _id: 'old-food', title: '昨天的饭', status: 'logged', createdAt: mysqlDate(yesterday) },
    { _id: 'fresh-approval-record', approvalId: 'fresh', title: '有效审批', status: 'pending', createdAt: mysqlDate(yesterday) },
    { _id: 'expired-approval-record', approvalId: 'expired', title: '过期审批', status: 'approved', createdAt: mysqlDate(expired) },
  ]
  const repository = new MySQLRepository({ async execute() { return [rows] } })
  const records = await repository.listRecords('owner')
  assert.deepEqual(records.map(record => record._id), ['today-food', 'fresh-approval-record'])
})

test('MySQL recent records recover approvals without a user_records row', async () => {
  const createdAt = mysqlDate(new Date())
  const foodCreatedAt = mysqlDate(new Date(Date.now() - 1000))
  const calls = []
  const repository = new MySQLRepository({
    async execute(sql) {
      calls.push(sql)
      if (sql.includes('FROM user_records')) return [[
        { _id: 'today-food', _openid: 'owner', title: '今天的饭', status: 'logged', createdAt: foodCreatedAt },
      ]]
      return [[
        { id: 'approval-only', openid: 'owner', title: '审批主体', calorie: 450, status: 'pending', createdAt },
      ]]
    },
  })

  const records = await repository.listRecords('owner')
  assert.deepEqual(records.map(record => record._id), ['approval-only', 'today-food'])
  assert.equal(calls.length, 2)
})

test('MySQL applies default outcomes to expired approvals and rejects late votes', async () => {
  const createdAt = mysqlDate(new Date(Date.now() - APPROVAL_VALIDITY_MS - 1000))
  const approvalRow = { id: 'expired', openid: 'owner', status: 'pending', createdAt }
  const detailRepository = new MySQLRepository({ async execute() { return [[approvalRow]] } })
  const detail = await detailRepository.getApproval('expired')
  assert.equal(detail.status, 'rejected')
  assert.equal(detail.foodDecided, true)
  assert.equal(detail.foodResult, 'skipped')

  const connection = {
    async beginTransaction() {}, async rollback() {}, release() {},
    async execute(sql) {
      if (sql.includes('FROM approval_votes')) return [[]]
      if (sql.includes('FROM approvals')) return [[approvalRow]]
      assert.fail('过期审批不应读取投票记录')
    },
  }
  const voteRepository = new MySQLRepository({ async getConnection() { return connection } })
  await assert.rejects(
    () => voteRepository.createVote('expired', { choice: 'approve', reason: '太晚了' }, 'voter'),
    error => error.code === 'APPROVAL_EXPIRED',
  )
})
