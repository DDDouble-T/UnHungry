const test = require('node:test')
const assert = require('node:assert/strict')
const { CloudBaseRepository } = require('../src/repository')

class FakeDocument {
  constructor(store, id) {
    this.store = store
    this.id = id
  }

  async get() {
    return { data: this.store.get(this.id) || null }
  }

  async set(data) {
    assert.equal(data.data, undefined, 'Node SDK set 不应使用小程序端 data 包装')
    assert.equal(data._id, undefined, '文档 ID 应由 doc(id) 提供')
    this.store.set(this.id, { _id: this.id, ...data })
  }

  async update(data) {
    assert.equal(data.data, undefined, 'Node SDK update 不应使用小程序端 data 包装')
    this.store.set(this.id, { ...this.store.get(this.id), ...data })
  }
}

class FakeCollection {
  constructor(store) {
    this.store = store
    this.filters = null
    this.sortField = null
    this.sortDirection = 'asc'
    this.max = null
  }

  doc(id) { return new FakeDocument(this.store, id) }

  where(filters) { this.filters = filters; return this }

  orderBy(field, direction) {
    this.sortField = field
    this.sortDirection = direction
    return this
  }

  limit(value) { this.max = value; return this }

  async get() {
    let result = [...this.store.values()]
    if (this.filters) result = result.filter(item => Object.entries(this.filters).every(([key, value]) => value && value.$in ? value.$in.includes(item[key]) : item[key] === value))
    if (this.sortField) {
      result.sort((a, b) => this.sortDirection === 'desc'
        ? String(b[this.sortField]).localeCompare(String(a[this.sortField]))
        : String(a[this.sortField]).localeCompare(String(b[this.sortField])))
    }
    return { data: this.max ? result.slice(0, this.max) : result }
  }
}

class FakeDatabase {
  constructor() { this.stores = new Map(); this.command = { in: values => ({ $in: values }) } }

  collection(name) {
    if (!this.stores.has(name)) this.stores.set(name, new Map())
    return new FakeCollection(this.stores.get(name))
  }
}

test('CloudBase repository uses Node SDK writes and keeps records in sync', async () => {
  const repository = new CloudBaseRepository(new FakeDatabase())
  const created = await repository.createApproval({
    authorName: '小明', authorAvatar: 'cloud://avatars/me.jpg', isAnonymous: false, title: '豆花', price: 12, calorie: 180, reason: '想吃甜的', alternative: '无糖酸奶', intake: '', image: '',
  }, 'owner-1')
  const voted = await repository.createVote(created._id, { choice: 'approve', reason: '今天运动过了' }, 'voter-1')
  assert.equal(voted.status, 'approved')
  assert.equal(voted.authorName, '小明')
  assert.equal(voted.authorAvatar, 'cloud://avatars/me.jpg')
  assert.equal(voted.isAnonymous, false)
  assert.equal((await repository.getApproval(created._id)).authorName, '小明')
  const records = await repository.listRecords('owner-1')
  assert.equal(records.length, 1)
  assert.equal(records[0].status, 'approved')
  const input = { approvalId: created._id, title: '半份豆花', calorie: 90, image: 'cloud://food' }
  await assert.rejects(() => repository.recordApprovalFood(input, 'other-owner'))
  await repository.recordApprovalFood(input, 'owner-1')
  await repository.recordApprovalFood({ ...input, calorie: 999 }, 'owner-1')
  const recorded = await repository.listRecords('owner-1')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].foodRecorded, true)
  assert.equal(recorded[0].calorie, 90)


  await assert.rejects(
    () => repository.createVote(created._id, { choice: 'approve', reason: '重复投票' }, 'voter-1'),
    error => error.code === 'DUPLICATE_VOTE',
  )
})

test('CloudBase repository persists independent food records', async () => {
  const repository = new CloudBaseRepository(new FakeDatabase())
  const created = await repository.createFoodRecord({ title: '米饭', calorie: 230, image: '' }, 'owner-2')
  const records = await repository.listRecords('owner-2')
  assert.equal(records.length, 1)
  assert.equal(records[0]._id, created._id)
  assert.equal(records[0].status, 'logged')
  assert.equal(records[0].calorie, 230)
})

for (const [mode, createRepository] of [
  ['memory', () => new (require('../src/repository').MemoryRepository)()],
  ['cloudbase', () => new CloudBaseRepository(new FakeDatabase())],
]) {
  test(`${mode} recent records recover an approval whose personal record is missing`, async () => {
    const repository = createRepository()
    const owner = `missing-record-owner-${mode}`
    const approval = await repository.createApproval({ title: '缺少记录的审批', calorie: 320, reason: '想吃' }, owner)
    await repository.createApproval({ title: '别人的审批', calorie: 320, reason: '不应出现' }, `${owner}-other`)
    if (mode === 'memory') repository.records.clear()
    else repository.db.stores.get('user_records').clear()

    const records = await repository.listRecords(owner)
    assert.equal(records.length, 1)
    assert.equal(records[0].approvalId, approval._id)
    assert.equal(records[0].title, '缺少记录的审批')
    assert.equal(records[0].status, 'pending')
  })
}

for (const [mode, createRepository] of [
  ['memory', () => new (require('../src/repository').MemoryRepository)()],
  ['cloudbase', () => new CloudBaseRepository(new FakeDatabase())],
]) {
  test(`${mode} square exposes food decisions independently of vote status`, async () => {
    const repository = createRepository()
    const { approval } = require('../src/serializers')
    for (const choice of ['eaten', 'skipped', 'legacy-eaten', 'undecided']) {
      const owner = `owner-${choice}`
      const item = await repository.createApproval({ title: '米饭', calorie: 200, reason: '饿了' }, owner)
      assert.equal(approval(await repository.getApproval(item._id)).foodDecided, false)
      await repository.createVote(item._id, { choice: 'approve', reason: '可以吃' }, 'voter')
      assert.equal(approval(await repository.getApproval(item._id)).foodDecided, false)
      if (choice === 'eaten') await repository.recordApprovalFood({ approvalId: item._id, title: '半碗米饭', calorie: 100, image: '' }, owner)
      if (choice === 'skipped') await repository.checkIn(item._id, '后悔', owner)
      if (choice === 'legacy-eaten') await repository.checkIn(item._id, '真香', owner)
      const expected = choice !== 'undecided'
      const detail = approval(await repository.getApproval(item._id))
      const listed = approval((await repository.listApprovals()).find(row => row._id === item._id))
      assert.equal(detail.foodDecided, expected)
      assert.equal(listed.foodDecided, expected)
      assert.equal(detail.foodResult, choice === 'eaten' || choice === 'legacy-eaten' ? 'eaten' : choice === 'skipped' ? 'skipped' : '')
      assert.equal(listed.foodResult, detail.foodResult)
      if (expected) {
        // 即使历史数据仍为 pending，也必须根据已选择结果禁止投票。
        if (mode === 'memory') repository.approvals.get(item._id).status = 'pending'
        else await repository.collection('approvals').doc(item._id).update({ status: 'pending' })
        await assert.rejects(repository.createVote(item._id, { choice: 'approve', reason: '再投一票' }, 'another-voter'), error => error.code === 'APPROVAL_CLOSED' && error.message.includes('已选择'))
      }
    }
  })
}

for (const [mode, createRepository] of [
  ['memory', () => new (require('../src/repository').MemoryRepository)()],
  ['cloudbase', () => new CloudBaseRepository(new FakeDatabase())],
]) {
  test(`${mode} records expire approvals after three days and keep only today's food`, async () => {
    const repository = createRepository()
    const owner = `lifecycle-owner-${mode}`
    const approved = await repository.createApproval({ title: '烤冷面', calorie: 500, reason: '饿了' }, owner)
    await repository.createVote(approved._id, { choice: 'approve', reason: '可以' }, `voter-${mode}`)
    const pending = await repository.createApproval({ title: '奶茶', calorie: 300, reason: '想喝' }, owner)
    const todayFood = await repository.createFoodRecord({ title: '今天的米饭', calorie: 200, image: '' }, owner)
    const yesterdayFood = await repository.createFoodRecord({ title: '昨天的米饭', calorie: 200, image: '' }, owner)
    const expiredAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString()

    const approvalStore = mode === 'memory' ? repository.approvals : repository.db.stores.get('approvals')
    const recordStore = mode === 'memory' ? repository.records : repository.db.stores.get('user_records')
    approvalStore.get(approved._id).createdAt = expiredAt
    approvalStore.get(pending._id).createdAt = expiredAt
    for (const record of recordStore.values()) {
      if (record.approvalId === approved._id || record.approvalId === pending._id) record.createdAt = expiredAt
    }
    recordStore.get(yesterdayFood._id).createdAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    const records = await repository.listRecords(owner)
    assert.deepEqual(records.map(record => record.id || record._id), [todayFood._id])
    assert.deepEqual(await repository.listApprovals({ status: 'all', limit: 100 }), [])
    assert.equal((await repository.getApproval(approved._id)).foodResult, 'eaten')
    assert.equal((await repository.getApproval(pending._id)).status, 'rejected')
    assert.equal((await repository.getApproval(pending._id)).foodResult, 'skipped')
    await assert.rejects(
      () => repository.createVote(pending._id, { choice: 'approve', reason: '过期投票' }, `late-voter-${mode}`),
      error => error.code === 'APPROVAL_EXPIRED',
    )

    const stats = await repository.getStats(owner)
    assert.equal(stats.submittedCount, 2)
    assert.equal(stats.approvedCount, 1)
    assert.equal(stats.todayCalories, 200)
  })
}
