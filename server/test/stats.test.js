const test = require('node:test')
const assert = require('node:assert/strict')
const { calculateStats } = require('../src/repository')

function timestamps() {
  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(`${today}T00:00:00.000Z`)
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)
  return { today: `${today}T12:00:00.000Z`, yesterday: yesterday.toISOString() }
}

test('today calories include food eaten, excluding pending, rejected, approved and skipped applications', () => {
  const { today } = timestamps()
  const records = [
    { status: 'logged', calorie: 200 },
    { approvalId: 'eaten', status: 'approved', foodRecorded: true, calorie: 300 },
    { approvalId: 'legacy-eaten', status: 'approved', checkinResult: '真香', calorie: 100 },
    { approvalId: 'pending', status: 'pending', calorie: 400 },
    { approvalId: 'rejected', status: 'rejected', title: '奶茶', calorie: 500 },
    { approvalId: 'approved', status: 'approved', calorie: 600 },
    { approvalId: 'skipped', status: 'approved', checkinResult: '后悔', calorie: 700 },
  ].map(record => ({ ...record, createdAt: today, updatedAt: today }))

  const stats = calculateStats(records)
  assert.equal(stats.todayCalories, 600)
  assert.equal(stats.submittedCount, 6)
  assert.equal(stats.approvedCount, 4)
  assert.equal(stats.savedCalories, 500)
  assert.equal(stats.topRejected, '奶茶')
  assert.equal(stats.calorieQuota, 1600)
})

test('confirmed approval food belongs to the confirmation day across midnight', () => {
  const { today, yesterday } = timestamps()
  const stats = calculateStats([
    { approvalId: 'confirmed-today', status: 'approved', foodRecorded: true, calorie: 300, createdAt: yesterday, updatedAt: today },
    { approvalId: 'legacy-confirmed-today', status: 'approved', checkinResult: '真香', calorie: 100, createdAt: yesterday, updatedAt: today },
    { approvalId: 'confirmed-yesterday', status: 'approved', foodRecorded: true, calorie: 500, createdAt: yesterday, updatedAt: yesterday },
    { approvalId: 'legacy-confirmed-yesterday', status: 'approved', checkinResult: '真香', calorie: 600, createdAt: yesterday, updatedAt: yesterday },
  ])
  assert.equal(stats.todayCalories, 400)
})

test('independent food records keep their creation day even when updated later', () => {
  const { today, yesterday } = timestamps()
  const stats = calculateStats([
    { status: 'logged', calorie: 230, createdAt: today, updatedAt: today },
    { status: 'logged', calorie: 500, createdAt: yesterday, updatedAt: today },
  ])
  assert.equal(stats.todayCalories, 230)
})

test('missing and zero calories do not distort totals or count confirmation flags twice', () => {
  const { today } = timestamps()
  const records = [
    { status: 'logged', calorie: 0 },
    { status: 'logged', calorie: null },
    { status: 'logged' },
    { status: 'logged', calorie: '12.5' },
    { approvalId: 'both-flags', status: 'approved', foodRecorded: true, checkinResult: '真香', calorie: 100 },
  ].map(record => ({ ...record, createdAt: today, updatedAt: today }))
  assert.equal(calculateStats(records).todayCalories, 112.5)
  assert.equal(calculateStats([]).todayCalories, 0)
})

test('legacy confirmed records fall back to creation time and accept database Date values', () => {
  const { today } = timestamps()
  const stats = calculateStats([
    { approvalId: 'legacy', status: 'approved', checkinResult: '真香', calorie: 100, createdAt: today },
    { approvalId: 'database-date', status: 'approved', foodRecorded: true, calorie: 200, createdAt: new Date(today), updatedAt: new Date(today) },
  ])
  assert.equal(stats.todayCalories, 300)
})

test('decimal calories do not exceed the quota because of floating point addition', () => {
  const { today } = timestamps()
  const records = [459.27, 282.67, 383.9, 474.16].map(calorie => ({ status: 'logged', calorie, createdAt: today }))
  assert.equal(calculateStats(records).todayCalories, 1600)
})
