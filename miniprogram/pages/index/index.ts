type TabKey = 'square' | 'apply' | 'me'
type FilterKey = 'all' | 'pending' | 'approved' | 'rejected'
type Status = 'pending' | 'approved' | 'rejected'
type VoteChoice = 'approve' | 'wait'
type FormField = 'foodName' | 'price' | 'calorie' | 'reason' | 'alternative' | 'intake'

interface Approval {
  id: number
  status: Status
  statusLabel: string
  title: string
  price: string
  calorie: string
  reason: string
  alternative: string
  intake: string
  image?: string
  time: string
  support: number
  against: number
  supportRate: number
  totalVotes: number
  tags: string[]
  emoji: string
}

interface ApprovalForm {
  foodName: string
  price: string
  calorie: string
  reason: string
  alternative: string
  intake: string
}

interface MyRecord {
  id: number
  title: string
  time: string
  calorie: string
  status: Status
  statusLabel: string
  checkinResult: string
}

const labels: Record<Status, string> = { pending: '待审批', approved: '已通过', rejected: '先等等' }
const seedApprovals: Approval[] = [
  { id: 1, status: 'pending', statusLabel: '待审批', title: '芝士瀑布厚吐司', price: '28', calorie: '520', reason: '加班到现在，想用一口甜的给今天收尾。', alternative: '无糖酸奶 + 半根香蕉', intake: '鸡胸肉沙拉、黑咖啡', time: '12 分钟前', support: 24, against: 28, supportRate: 46, totalVotes: 52, tags: ['高糖', '夜宵'], emoji: '🍞' },
  { id: 2, status: 'approved', statusLabel: '已通过', title: '冰美式 + 可颂', price: '32', calorie: '360', reason: '下午会议太密集，需要一点香气续命。', alternative: '黑咖啡 + 全麦面包', intake: '燕麦粥、煎蛋', time: '26 分钟前', support: 41, against: 18, supportRate: 70, totalVotes: 59, tags: ['下午茶', '碳水'], emoji: '🥐' },
  { id: 3, status: 'rejected', statusLabel: '先等等', title: '大份麻辣拌', price: '39', calorie: '780', reason: '今天被工作气到了，想吃点重口的。', alternative: '番茄鸡蛋面 + 一份青菜', intake: '午餐吃得比较清淡', time: '41 分钟前', support: 17, against: 34, supportRate: 33, totalVotes: 51, tags: ['高油', '情绪进食'], emoji: '🥗' },
]
const seedRecords: MyRecord[] = [
  { id: 2, title: '冰美式 + 可颂', time: '今天 14:20', calorie: '360', status: 'approved', statusLabel: '已通过', checkinResult: '' },
  { id: 3, title: '大份麻辣拌', time: '今天 12:05', calorie: '780', status: 'rejected', statusLabel: '先等等', checkinResult: '' },
  { id: 100, title: '芝士瀑布厚吐司', time: '昨天 22:40', calorie: '520', status: 'approved', statusLabel: '已通过', checkinResult: '真香' },
]

const blankForm = (): ApprovalForm => ({ foodName: '', price: '', calorie: '', reason: '', alternative: '', intake: '' })
let keyboardHeightListener: ((result: { height: number }) => void) | null = null

function encodeShareSnapshot(approval: Approval) {
  const snapshot = JSON.stringify({
    id: approval.id,
    title: approval.title.slice(0, 24),
    price: approval.price.slice(0, 8),
    calorie: approval.calorie.slice(0, 8),
    reason: approval.reason.slice(0, 50),
    alternative: approval.alternative.slice(0, 30),
    intake: approval.intake.slice(0, 20),
    status: approval.status,
    support: approval.support,
    against: approval.against,
    supportRate: approval.supportRate,
    totalVotes: approval.totalVotes,
  })
  const binary = encodeURIComponent(snapshot).replace(/%([0-9A-F]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return wx.arrayBufferToBase64(bytes.buffer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeShareSnapshot(encoded: string): Approval | null {
  try {
    if (!encoded || encoded.length > 1500) return null
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4)
    const bytes = new Uint8Array(wx.base64ToArrayBuffer(base64))
    let escaped = ''
    for (let index = 0; index < bytes.length; index += 1) escaped += `%${bytes[index].toString(16).padStart(2, '0')}`
    const value = JSON.parse(decodeURIComponent(escaped))
    const id = Number(value && value.id)
    if (!value || !Number.isSafeInteger(id) || id <= 0 || typeof value.title !== 'string') return null
    if (!['pending', 'approved', 'rejected'].includes(value.status)) return null
    const status = value.status as Status
    const support = Math.max(0, Math.floor(Number(value.support) || 0))
    const against = Math.max(0, Math.floor(Number(value.against) || 0))
    return {
      id,
      status,
      statusLabel: labels[status],
      title: value.title.slice(0, 30),
      price: typeof value.price === 'string' || typeof value.price === 'number' ? String(value.price).slice(0, 8) : '',
      calorie: String(value.calorie || '待估算').slice(0, 8),
      reason: String(value.reason || '').slice(0, 100),
      alternative: String(value.alternative || '').slice(0, 50),
      intake: String(value.intake || '').slice(0, 60),
      time: '刚刚',
      support,
      against,
      supportRate: Math.min(100, Math.max(0, Math.round(Number(value.supportRate) || 0))),
      totalVotes: support + against,
      tags: ['好友分享'],
      emoji: '🍽️',
    }
  } catch (_error) {
    return null
  }
}

Component({
  data: {
    activeTab: 'square' as TabKey,
    activeFilter: 'all' as FilterKey,
    approvals: seedApprovals,
    filteredApprovals: seedApprovals,
    form: blankForm(),
    uploadedImage: '',
    myRecords: seedRecords,
    shareTargetId: 1,
    shareAnchor: '',
    formFocusAnchor: '',
    keyboardHeight: 0,
    pageScrollStyle: '',
    voteTargetId: 0,
    voteChoice: '' as VoteChoice | '',
    voteReason: '',
    todayCalories: 860,
    calorieQuota: 1600,
    quotaPercent: 54,
    savedCalories: 1840,
    approvalRate: 75,
    approvedCount: 12,
    submittedCount: 16,
    topRejected: '奶茶',
  },
  lifetimes: {
    attached() {
      keyboardHeightListener = ({ height }) => {
        const keyboardHeight = this.data.activeTab === 'apply' ? Math.max(0, height) : 0
        if (keyboardHeight === this.data.keyboardHeight) return
        this.setData({
          keyboardHeight,
          pageScrollStyle: keyboardHeight
            ? `height: calc(100vh - 108rpx - env(safe-area-inset-top) - ${keyboardHeight}px);`
            : '',
        })
      }
      wx.onKeyboardHeightChange(keyboardHeightListener)
    },
    detached() {
      if (!keyboardHeightListener) return
      wx.offKeyboardHeightChange(keyboardHeightListener)
      keyboardHeightListener = null
    },
  },
  methods: {
    onLoad(query: any) {
      const approvalId = Number(query && query.approvalId)
      if (!Number.isFinite(approvalId)) return
      let approvals = this.data.approvals as Approval[]
      const sharedSnapshot = query.snapshot ? decodeShareSnapshot(query.snapshot) : null
      if (sharedSnapshot && sharedSnapshot.id === approvalId && !approvals.some(item => item.id === approvalId)) {
        approvals = [sharedSnapshot, ...approvals]
      }
      if (!approvals.some(item => item.id === approvalId)) {
        wx.showToast({ title: '这张审批单暂时无法查看', icon: 'none' })
        return
      }
      this.setData({ approvals, filteredApprovals: this.filterApprovals(approvals, 'all'), activeTab: 'square' as TabKey, activeFilter: 'all' as FilterKey, shareTargetId: approvalId, shareAnchor: `approval-${approvalId}` })
    },
    onShareAppMessage(options: any) {
      const buttonId = options && options.from === 'button' && options.target
        ? Number(options.target.dataset.id)
        : 0
      const selectedId = buttonId || this.data.shareTargetId as number
      const approval = (this.data.approvals as Approval[]).find(item => item.id === selectedId)
      const title = approval
        ? `帮我看看「${approval.title}」这顿要不要吃？`
        : '吃之前，先来一张饮食审批单'
      const snapshot = approval ? encodeShareSnapshot(approval) : ''
      const path = approval ? `/pages/index/index?approvalId=${approval.id}&snapshot=${snapshot}` : '/pages/index/index'
      return { title, path }
    },
    onShareTimeline() {
      const selectedId = this.data.shareTargetId as number
      const approval = (this.data.approvals as Approval[]).find(item => item.id === selectedId)
      if (!approval) return { title: '吃之前，先来一张饮食审批单' }
      return {
        title: `「${approval.title}」要不要吃？帮忙审批一下`,
        query: `approvalId=${approval.id}&snapshot=${encodeShareSnapshot(approval)}`,
      }
    },
    switchTab(e: any) {
      const activeTab = e.currentTarget.dataset.tab as TabKey
      this.setData({
        activeTab,
        formFocusAnchor: '',
        ...(activeTab === 'apply' ? {} : { keyboardHeight: 0, pageScrollStyle: '' }),
      })
    },
    startApply() { this.setData({ activeTab: 'apply' as TabKey, formFocusAnchor: '' }) },
    openFriends() { wx.showToast({ title: '亲友群审批即将开放', icon: 'none' }) },
    prepareTimelineShare(e: any) {
      const id = Number(e.currentTarget.dataset.id)
      this.setData({ shareTargetId: id })
      try {
        wx.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage', 'shareTimeline'] })
          .then(() => wx.showToast({ title: '请从右上角菜单分享到朋友圈', icon: 'none' }))
          .catch(error => {
            console.warn('showShareMenu failed', error)
            wx.showToast({ title: '朋友圈分享暂不可用', icon: 'none' })
          })
      } catch (error) {
        console.warn('showShareMenu failed', error)
        wx.showToast({ title: '朋友圈分享暂不可用', icon: 'none' })
      }
    },
    switchFilter(e: any) {
      const filter = e.currentTarget.dataset.filter as FilterKey
      const approvals = this.data.approvals as Approval[]
      this.setData({ activeFilter: filter, filteredApprovals: this.filterApprovals(approvals, filter) })
    },
    filterApprovals(approvals: Approval[], filter: FilterKey) {
      return filter === 'all' ? approvals : approvals.filter(item => item.status === filter)
    },
    openVote(e: any) {
      this.setData({ voteTargetId: Number(e.currentTarget.dataset.id), voteChoice: e.currentTarget.dataset.choice as VoteChoice, voteReason: '' })
    },
    closeVoteSheet() { this.setData({ voteTargetId: 0, voteChoice: '', voteReason: '' }) },
    stopPropagation() {},
    onVoteReasonInput(e: any) { this.setData({ voteReason: e.detail.value }) },
    submitVote() {
      const reason = (this.data.voteReason as string).trim()
      if (!reason) { wx.showToast({ title: '写下理由才算有效票', icon: 'none' }); return }
      const targetId = this.data.voteTargetId as number
      const choice = this.data.voteChoice as VoteChoice
      let newlyApproved = false
      const approvals = (this.data.approvals as Approval[]).map(item => {
        if (item.id !== targetId || item.status !== 'pending') return item
        const support = item.support + (choice === 'approve' ? 1 : 0)
        const against = item.against + (choice === 'wait' ? 1 : 0)
        const totalVotes = support + against
        const supportRate = Math.round(support / totalVotes * 100)
        const status: Status = supportRate >= 50 ? 'approved' : against > support ? 'rejected' : 'pending'
        const myRecords = this.data.myRecords as MyRecord[]
        newlyApproved = myRecords.some(record => record.id === targetId && record.status === 'pending' && status === 'approved')
        return { ...item, support, against, totalVotes, supportRate, status, statusLabel: labels[status] }
      })
      const votedApproval = approvals.find(item => item.id === targetId)
      const myRecords = (this.data.myRecords as MyRecord[]).map(record => record.id === targetId && votedApproval
        ? { ...record, status: votedApproval.status, statusLabel: votedApproval.statusLabel }
        : record)
      const approvedCount = (this.data.approvedCount as number) + (newlyApproved ? 1 : 0)
      const submittedCount = this.data.submittedCount as number
      this.setData({ approvals, filteredApprovals: this.filterApprovals(approvals, this.data.activeFilter as FilterKey), myRecords, approvedCount, approvalRate: Math.round(approvedCount / submittedCount * 100), voteTargetId: 0, voteChoice: '', voteReason: '' })
      wx.showToast({ title: '投票已计入', icon: 'success' })
    },
    onFormInput(e: any) {
      const field = e.currentTarget.dataset.field as FormField
      this.setData({ [`form.${field}`]: e.detail.value })
    },
    onFormFocus(e: any) {
      const field = e.currentTarget.dataset.field as FormField
      this.setData({ formFocusAnchor: `form-field-${field}` })
    },
    chooseImage() {
      wx.chooseImage({ count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'], success: res => this.setData({ uploadedImage: res.tempFilePaths[0] }) })
    },
    submitApproval() {
      const form = this.data.form as ApprovalForm
      const required: Array<[keyof ApprovalForm, string]> = [['foodName', '食物名称'], ['reason', '想吃理由']]
      const missing = required.find(([field]) => !form[field].trim())
      if (missing) { wx.showToast({ title: `请补充${missing[1]}`, icon: 'none' }); return }
      const price = form.price.trim()
      if (price && (!Number.isFinite(Number(price)) || Number(price) < 0)) { wx.showToast({ title: '请输入有效价格', icon: 'none' }); return }
      const approval: Approval = {
        id: Date.now(), status: 'pending', statusLabel: '待审批', title: form.foodName.trim(), price: form.price.trim(),
        calorie: form.calorie.trim() || '待估算', reason: form.reason.trim(), alternative: form.alternative.trim(), intake: form.intake.trim(), image: this.data.uploadedImage as string, time: '刚刚',
        support: 0, against: 0, supportRate: 0, totalVotes: 0, tags: ['新提交'], emoji: '🍽️',
      }
      const approvals = [approval, ...(this.data.approvals as Approval[])]
      const record: MyRecord = { id: approval.id, title: approval.title, time: '刚刚', calorie: approval.calorie, status: approval.status, statusLabel: approval.statusLabel, checkinResult: '' }
      const submittedCount = (this.data.submittedCount as number) + 1
      this.setData({ approvals, filteredApprovals: this.filterApprovals(approvals, this.data.activeFilter as FilterKey), myRecords: [record, ...(this.data.myRecords as MyRecord[])], form: blankForm(), uploadedImage: '', submittedCount, approvalRate: Math.round((this.data.approvedCount as number) / submittedCount * 100), activeTab: 'square' as TabKey, formFocusAnchor: '', keyboardHeight: 0, pageScrollStyle: '' })
      wx.showToast({ title: '审批单已发出', icon: 'success' })
    },
    resetForm() { this.setData({ form: blankForm(), uploadedImage: '' }) },
    checkIn(e: any) {
      const result = e.currentTarget.dataset.result as string
      const id = Number(e.currentTarget.dataset.id)
      const myRecords = (this.data.myRecords as MyRecord[]).map(record => record.id === id ? { ...record, checkinResult: result } : record)
      this.setData({ myRecords })
      wx.showToast({ title: `已记录：${result}`, icon: 'success' })
    },
  },
})
