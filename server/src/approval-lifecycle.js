const { APPROVAL_VALIDITY_MS } = require('./config')

function asDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value)
  // MySQL dateStrings use UTC values written by this service.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text
  const date = new Date(normalized)
  return Number.isFinite(date.getTime()) ? date : null
}

function isApprovalWithinValidity(createdAt, reference = new Date()) {
  const created = asDate(createdAt)
  const current = asDate(reference)
  if (!created || !current) return false
  const age = current.getTime() - created.getTime()
  return age >= 0 && age < APPROVAL_VALIDITY_MS
}

function isApprovalExpired(createdAt, reference = new Date()) {
  const created = asDate(createdAt)
  const current = asDate(reference)
  return Boolean(created && current && current.getTime() - created.getTime() >= APPROVAL_VALIDITY_MS)
}

function isToday(value, reference = new Date()) {
  const date = asDate(value)
  const current = asDate(reference)
  return Boolean(date && current && date.toISOString().slice(0, 10) === current.toISOString().slice(0, 10))
}

function resolveRecordOutcome(record, reference = new Date()) {
  if (!record || !record.approvalId || !isApprovalExpired(record.createdAt, reference) || record.foodRecorded || record.checkinResult) return record
  const defaultedAt = new Date(asDate(record.createdAt).getTime() + APPROVAL_VALIDITY_MS).toISOString()
  // An expired undecided approval is treated as eaten only when approved.
  return record.status === 'approved'
    ? { ...record, checkinResult: '真香', updatedAt: defaultedAt }
    : { ...record, status: 'rejected', checkinResult: '后悔', updatedAt: defaultedAt }
}

function resolveApprovalOutcome(item, record, reference = new Date()) {
  if (!item || !isApprovalExpired(item.createdAt, reference)) return item
  const resolved = resolveRecordOutcome(record, reference)
  const outcome = resolved && resolved.foodRecorded
    ? 'eaten'
    : resolved && resolved.checkinResult
      ? resolved.checkinResult === '真香' ? 'eaten' : 'skipped'
      : item.foodResult || (item.status === 'approved' ? 'eaten' : 'skipped')
  return {
    ...item,
    status: item.status === 'approved' ? 'approved' : 'rejected',
    foodDecided: true,
    foodResult: outcome,
  }
}

function isRecentRecord(record, reference = new Date()) {
  return record && (record.approvalId
    ? isApprovalWithinValidity(record.createdAt, reference)
    : isToday(record.createdAt, reference))
}

module.exports = {
  asDate,
  isApprovalExpired,
  isApprovalWithinValidity,
  isRecentRecord,
  isToday,
  resolveApprovalOutcome,
  resolveRecordOutcome,
}
