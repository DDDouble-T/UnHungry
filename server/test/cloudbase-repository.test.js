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
    if (this.filters) result = result.filter(item => Object.entries(this.filters).every(([key, value]) => item[key] === value))
    if (this.sortField) {
      result.sort((a, b) => this.sortDirection === 'desc'
        ? String(b[this.sortField]).localeCompare(String(a[this.sortField]))
        : String(a[this.sortField]).localeCompare(String(b[this.sortField])))
    }
    return { data: this.max ? result.slice(0, this.max) : result }
  }
}

class FakeDatabase {
  constructor() { this.stores = new Map() }

  collection(name) {
    if (!this.stores.has(name)) this.stores.set(name, new Map())
    return new FakeCollection(this.stores.get(name))
  }
}

test('CloudBase repository uses Node SDK writes and keeps records in sync', async () => {
  const repository = new CloudBaseRepository(new FakeDatabase())
  const created = await repository.createApproval({
    title: '豆花', price: 12, calorie: 180, reason: '想吃甜的', alternative: '无糖酸奶', intake: '', image: '',
  }, 'owner-1')
  const voted = await repository.createVote(created._id, { choice: 'approve', reason: '今天运动过了' }, 'voter-1')
  assert.equal(voted.status, 'approved')
  const records = await repository.listRecords('owner-1')
  assert.equal(records.length, 1)
  assert.equal(records[0].status, 'approved')

  await assert.rejects(
    () => repository.createVote(created._id, { choice: 'approve', reason: '重复投票' }, 'voter-1'),
    error => error.code === 'DUPLICATE_VOTE',
  )
})
