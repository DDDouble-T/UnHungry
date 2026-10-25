const STATUS_LABELS = { pending: '待审批', approved: '已通过', rejected: '先等等', logged: '已记录' }

function approval(item) {
  return {
    id: item._id,
    status: item.status,
    statusLabel: STATUS_LABELS[item.status],
    title: item.title,
    price: item.price,
    calorie: item.calorie,
    reason: item.reason,
    alternative: item.alternative,
    intake: item.intake,
    image: item.image || '',
    createdAt: item.createdAt,
    support: item.support,
    against: item.against,
    totalVotes: item.totalVotes,
    supportRate: item.supportRate,
    tags: item.tags || [],
    emoji: item.emoji || '🍽️',
  }
}

function record(item) {
  return {
    id: item.approvalId || item._id,
    ...(item.approvalId ? { recordId: item._id } : {}),
    title: item.title,
    time: item.createdAt,
    calorie: item.calorie,
    status: item.status,
    statusLabel: STATUS_LABELS[item.status],
    checkinResult: item.checkinResult || '',
  }
}

function stats(value) {
  return {
    submittedCount: value.submittedCount,
    approvedCount: value.approvedCount,
    approvalRate: value.approvalRate,
    todayCalories: value.todayCalories,
    calorieQuota: value.calorieQuota,
    savedCalories: value.savedCalories,
    topRejected: value.topRejected,
  }
}

module.exports = { STATUS_LABELS, approval, record, stats }
