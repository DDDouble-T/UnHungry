// 审批单从创建时间起的有效期。修改这里即可统一调整列表、投票和默认结果规则。
const APPROVAL_VALID_DAYS = 3
const APPROVAL_VALIDITY_MS = APPROVAL_VALID_DAYS * 24 * 60 * 60 * 1000

module.exports = { APPROVAL_VALID_DAYS, APPROVAL_VALIDITY_MS }
