const test = require('node:test')
const assert = require('node:assert/strict')
const { APPROVAL_VALID_DAYS, APPROVAL_VALIDITY_MS } = require('../src/config')
const {
  isApprovalExpired,
  isApprovalWithinValidity,
  isRecentRecord,
  resolveApprovalOutcome,
  resolveRecordOutcome,
} = require('../src/approval-lifecycle')

test('approval validity is configured as three days with a precise boundary', () => {
  const reference = new Date('2026-10-28T12:00:00.000Z')
  assert.equal(APPROVAL_VALID_DAYS, 3)
  assert.equal(isApprovalWithinValidity(new Date(reference.getTime() - APPROVAL_VALIDITY_MS + 1), reference), true)
  assert.equal(isApprovalExpired(new Date(reference.getTime() - APPROVAL_VALIDITY_MS), reference), true)
  assert.equal(isApprovalWithinValidity(new Date(reference.getTime() + 1), reference), false)
})

test('expired undecided approvals default to eaten only after approval', () => {
  const reference = new Date('2026-10-28T12:00:00.000Z')
  const createdAt = new Date(reference.getTime() - APPROVAL_VALIDITY_MS - 1000).toISOString()
  const approved = resolveRecordOutcome({ approvalId: 'approved', status: 'approved', createdAt, checkinResult: '' }, reference)
  const pending = resolveRecordOutcome({ approvalId: 'pending', status: 'pending', createdAt, checkinResult: '' }, reference)
  const rejected = resolveRecordOutcome({ approvalId: 'rejected', status: 'rejected', createdAt, checkinResult: '' }, reference)

  assert.equal(approved.checkinResult, '真香')
  assert.equal(approved.status, 'approved')
  assert.equal(pending.checkinResult, '后悔')
  assert.equal(pending.status, 'rejected')
  assert.equal(rejected.checkinResult, '后悔')
  assert.equal(resolveApprovalOutcome({ id: 'pending', status: 'pending', createdAt }, null, reference).foodResult, 'skipped')
  assert.equal(resolveRecordOutcome({ approvalId: 'explicit', status: 'approved', createdAt, checkinResult: '后悔' }, reference).checkinResult, '后悔')
})

test('recent records include only today independent food and approvals within validity', () => {
  const reference = new Date('2026-10-28T12:00:00.000Z')
  assert.equal(isRecentRecord({ status: 'logged', createdAt: '2026-10-28T01:00:00.000Z' }, reference), true)
  assert.equal(isRecentRecord({ status: 'logged', createdAt: '2026-10-27T23:59:59.000Z' }, reference), false)
  assert.equal(isRecentRecord({ approvalId: 'fresh', createdAt: new Date(reference.getTime() - APPROVAL_VALIDITY_MS + 1) }, reference), true)
  assert.equal(isRecentRecord({ approvalId: 'expired', createdAt: new Date(reference.getTime() - APPROVAL_VALIDITY_MS) }, reference), false)
})
