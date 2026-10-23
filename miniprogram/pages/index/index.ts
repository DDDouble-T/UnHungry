import { requestApprovalSubscription } from '../../config'
import { ApiApproval, createApproval, createApprovalVote, fetchApprovals, isApiConfigured, resolveApprovalImages, uploadApprovalImage } from '../../utils/api'

type TabKey = 'square' | 'apply' | 'record' | 'me'
type FilterKey = 'all' | 'pending' | 'approved' | 'rejected'
type Status = 'pending' | 'approved' | 'rejected'
type RecordStatus = Status | 'logged'
type VoteChoice = 'approve' | 'wait'
type FormField = 'foodName' | 'price' | 'calorie' | 'reason' | 'alternative' | 'intake'
type CalorieSource = 'manual' | 'local'

interface FoodPortion {
  label: string
  calorie: number
}

interface LocalFood {
  id: string
  name: string
  aliases: string[]
  calorieRange: [number, number]
  defaultPortion: string
  portions: FoodPortion[]
  per100g?: number
  source?: string
  category?: string
}

interface FoodSuggestion extends LocalFood {
  rangeLabel: string
}

interface Approval {
  id: string
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
  createdAt: string
  isDemo?: boolean
}

interface ApprovalForm {
  foodName: string
  price: string
  calorie: string
  portion: string
  reason: string
  alternative: string
  intake: string
}

interface MyRecord {
  id: string
  title: string
  time: string
  calorie: string
  status: RecordStatus
  statusLabel: string
  checkinResult: string
}

const labels: Record<Status, string> = { pending: '待审批', approved: '已通过', rejected: '先等等' }
const localFoods = require('../../data/foods.js') as LocalFood[]
const demoCreatedAt = new Date(0).toISOString()
const seedApprovals: Approval[] = [
  { id: 'demo-1', status: 'pending', statusLabel: '待审批', title: '芝士瀑布厚吐司', price: '28', calorie: '520', reason: '加班到现在，想用一口甜的给今天收尾。', alternative: '无糖酸奶 + 半根香蕉', intake: '鸡胸肉沙拉、黑咖啡', time: '示例内容', support: 24, against: 28, supportRate: 46, totalVotes: 52, tags: ['高糖', '夜宵'], emoji: '🍞', createdAt: demoCreatedAt, isDemo: true },
  { id: 'demo-2', status: 'approved', statusLabel: '已通过', title: '冰美式 + 可颂', price: '32', calorie: '360', reason: '下午会议太密集，需要一点香气续命。', alternative: '黑咖啡 + 全麦面包', intake: '燕麦粥、煎蛋', time: '示例内容', support: 41, against: 18, supportRate: 70, totalVotes: 59, tags: ['下午茶', '碳水'], emoji: '🥐', createdAt: demoCreatedAt, isDemo: true },
  { id: 'demo-3', status: 'rejected', statusLabel: '先等等', title: '大份麻辣拌', price: '39', calorie: '780', reason: '今天被工作气到了，想吃点重口的。', alternative: '番茄鸡蛋面 + 一份青菜', intake: '午餐吃得比较清淡', time: '示例内容', support: 17, against: 34, supportRate: 33, totalVotes: 51, tags: ['高油', '情绪进食'], emoji: '🥗', createdAt: demoCreatedAt, isDemo: true },
]
const seedRecords: MyRecord[] = [
  { id: 'demo-2', title: '冰美式 + 可颂', time: '今天 14:20', calorie: '360', status: 'approved', statusLabel: '已通过', checkinResult: '' },
  { id: 'demo-3', title: '大份麻辣拌', time: '今天 12:05', calorie: '780', status: 'rejected', statusLabel: '先等等', checkinResult: '' },
  { id: 'demo-1', title: '芝士瀑布厚吐司', time: '昨天 22:40', calorie: '520', status: 'approved', statusLabel: '已通过', checkinResult: '真香' },
]

const blankForm = (): ApprovalForm => ({ foodName: '', price: '', calorie: '', portion: '', reason: '', alternative: '', intake: '' })
let keyboardHeightListener: ((result: { height: number }) => void) | null = null

function normalizeFoodKeyword(value: string) {
  return value.trim().toLowerCase().replace(/[\s·＋+、,，。/\\_-]/g, '')
}

function keywordFragments(value: string) {
  const normalized = normalizeFoodKeyword(value)
  const fragments = [normalized]
  for (let index = 0; index < normalized.length - 1; index += 1) {
    fragments.push(normalized.slice(index, index + 2))
  }
  return [...new Set(fragments.filter(Boolean))]
}

function foodMatchScore(query: string, candidate: string): number | null {
  if (candidate === query) return 0
  if (candidate.includes(query) || query.includes(candidate)) return 1
  const queryFragments = keywordFragments(query).slice(1)
  const candidateFragments = new Set(keywordFragments(candidate).slice(1))
  const overlap = queryFragments.filter(fragment => candidateFragments.has(fragment)).length
  return overlap ? 2 - Math.min(overlap / Math.max(queryFragments.length, 1), 0.9) : null
}

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
    const id = String(value && value.id || '')
    if (!value || !/^[a-zA-Z0-9:_-]{1,128}$/.test(id) || typeof value.title !== 'string') return null
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
      createdAt: demoCreatedAt,
      isDemo: id.startsWith('demo-'),
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
    foodSuggestions: [] as FoodSuggestion[],
    foodMatchHint: '',
    selectedFoodId: '',
    portionOptions: [] as string[],
    portionIndex: 0,
    calorieHint: '',
    calorieSource: 'manual' as CalorieSource,
    uploadedImage: '',
    myRecords: seedRecords,
    shareTargetId: 'demo-1',
    shareAnchor: '',
    formFocusAnchor: '',
    keyboardHeight: 0,
    pageScrollStyle: '',
    voteTargetId: '',
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
        const keyboardHeight = this.data.activeTab === 'apply' || this.data.activeTab === 'record' ? Math.max(0, height) : 0
        if (keyboardHeight === this.data.keyboardHeight) return
        this.setData({
          keyboardHeight,
          pageScrollStyle: keyboardHeight
            ? `height: calc(100vh - 108rpx - env(safe-area-inset-top) - ${keyboardHeight}px);`
            : '',
        })
      }
      wx.onKeyboardHeightChange(keyboardHeightListener)
      void this.loadApprovals()
    },
    detached() {
      if (!keyboardHeightListener) return
      wx.offKeyboardHeightChange(keyboardHeightListener)
      keyboardHeightListener = null
    },
  },
  methods: {
    onLoad(query: any) {
      void this.loadApprovals()
      const approvalId = String(query && query.approvalId || '')
      if (!approvalId) return
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
    async loadApprovals() {
      if (!isApiConfigured()) return
      try {
        const apiItems = await resolveApprovalImages(await fetchApprovals())
        const current = this.data.approvals as Approval[]
        const sharedSnapshots = current.filter(item => !item.isDemo && item.tags.includes('好友分享'))
        const realApprovals = apiItems.map(item => this.mapApiApproval(item))
        const realIds = new Set(realApprovals.map(item => item.id))
        const merged = [
          ...realApprovals,
          ...sharedSnapshots.filter(item => !realIds.has(item.id)),
          ...seedApprovals,
        ].sort((left, right) => {
          if (left.isDemo !== right.isDemo) return left.isDemo ? 1 : -1
          return right.createdAt.localeCompare(left.createdAt)
        })
        this.setData({ approvals: merged, filteredApprovals: this.filterApprovals(merged, this.data.activeFilter as FilterKey) })
      } catch (error) {
        console.warn('load approvals failed', error)
      }
    },
    mapApiApproval(item: ApiApproval): Approval {
      const status = item.status
      return {
        id: item.id,
        status,
        statusLabel: labels[status],
        title: item.title,
        price: item.price === null || item.price === undefined ? '' : String(item.price),
        calorie: item.calorie === null || item.calorie === undefined ? '待估算' : String(item.calorie),
        reason: item.reason,
        alternative: item.alternative || '',
        intake: item.intake || '',
        image: item.image || '',
        time: this.relativeTime(item.createdAt),
        createdAt: item.createdAt,
        support: item.support,
        against: item.against,
        totalVotes: item.totalVotes,
        supportRate: item.supportRate,
        tags: item.tags || [],
        emoji: item.emoji || '🍽️',
      }
    },
    relativeTime(value: string) {
      const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000))
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return `${minutes} 分钟前`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours} 小时前`
      return `${Math.floor(hours / 24)} 天前`
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
        ...(activeTab === 'apply' || activeTab === 'record' ? {} : { keyboardHeight: 0, pageScrollStyle: '' }),
      })
    },
    startApply() { this.setData({ activeTab: 'apply' as TabKey, formFocusAnchor: 'form-field-foodName' }) },
    startRecord() {
      this.resetForm()
      this.setData({ activeTab: 'record' as TabKey, formFocusAnchor: 'form-field-foodName' })
    },
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
      const value = String(e.detail.value || '')
      if (field === 'foodName') {
        const selectedFoodId = this.data.selectedFoodId as string
        const selectedFood = localFoods.find(item => item.id === selectedFoodId)
        const keepSelection = Boolean(selectedFood && normalizeFoodKeyword(value) === normalizeFoodKeyword(selectedFood.name))
        const foodSuggestions = this.findLocalFoods(value)
        const updates: Record<string, unknown> = {
          [`form.${field}`]: value,
          foodSuggestions,
          foodMatchHint: value.trim() && !foodSuggestions.length ? '未找到本地食物，请手动填写热量' : '',
        }
        if (!keepSelection && selectedFoodId) {
          updates.selectedFoodId = ''
          updates.portionOptions = []
          updates.portionIndex = 0
          updates.calorieHint = ''
          updates.calorieSource = 'manual'
          updates['form.calorie'] = ''
          updates['form.portion'] = ''
        }
        this.setData(updates)
        return
      }
      this.setData({ [`form.${field}`]: value, ...(field === 'calorie' ? { calorieSource: 'manual' as CalorieSource } : {}) })
    },
    findLocalFoods(keyword: string): FoodSuggestion[] {
      const query = normalizeFoodKeyword(keyword)
      if (!query) return []
      return localFoods
        .map(food => {
          const names = [food.name, ...food.aliases].map(normalizeFoodKeyword)
          const scores = names.map(name => foodMatchScore(query, name)).filter((score): score is number => score !== null)
          const score = scores.length ? Math.min(...scores) : null
          return {
            ...food,
            rangeLabel: `${food.calorieRange[0]}-${food.calorieRange[1]} kcal`,
            score,
          }
        })
        .filter(item => item.score !== null)
        .sort((left, right) => (left.score as number) - (right.score as number))
        .slice(0, 5)
        .map(({ score: _score, ...food }) => food)
    },
    selectLocalFood(e: any) {
      const foodId = String(e.currentTarget.dataset.id || '')
      const food = localFoods.find(item => item.id === foodId)
      if (!food) return
      const defaultIndex = Math.max(0, food.portions.findIndex(item => item.label === food.defaultPortion))
      const portion = food.portions[defaultIndex]
      this.setData({
        'form.foodName': food.name,
        'form.calorie': String(portion.calorie),
        'form.portion': portion.label,
        foodSuggestions: [],
        foodMatchHint: '',
        selectedFoodId: food.id,
        portionOptions: food.portions.map(item => `${item.label} · ${item.calorie} kcal`),
        portionIndex: defaultIndex,
        calorieHint: `本地参考范围：${food.calorieRange[0]}-${food.calorieRange[1]} kcal`,
        calorieSource: 'local' as CalorieSource,
      })
    },
    onPortionChange(e: any) {
      const food = localFoods.find(item => item.id === this.data.selectedFoodId)
      const portionIndex = Number(e.detail.value)
      const portion = food && food.portions[portionIndex]
      if (!food || !portion) return
      this.setData({
        'form.portion': portion.label,
        'form.calorie': String(portion.calorie),
        portionIndex,
        calorieSource: 'local' as CalorieSource,
      })
    },
    onFormFocus(e: any) {
      const field = e.currentTarget.dataset.field as FormField
      this.setData({ formFocusAnchor: `form-field-${field}` })
    },
    chooseImage() {
      wx.chooseImage({ count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'], success: res => this.setData({ uploadedImage: res.tempFilePaths[0] }) })
    },
    async submitApproval() {
      const form = this.data.form as ApprovalForm
      const required: Array<[keyof ApprovalForm, string]> = [['foodName', '食物名称'], ['reason', '想吃理由']]
      const missing = required.find(([field]) => !form[field].trim())
      if (missing) { wx.showToast({ title: `请补充${missing[1]}`, icon: 'none' }); return }
      const price = form.price.trim()
      if (price && (!Number.isFinite(Number(price)) || Number(price) < 0)) { wx.showToast({ title: '请输入有效价格', icon: 'none' }); return }
      await requestApprovalSubscription()
      const approval: Approval = {
        id: Date.now(), status: 'pending', statusLabel: '待审批', title: form.foodName.trim(), price: form.price.trim(),
        calorie: form.calorie.trim() || '待估算', reason: form.reason.trim(), alternative: form.alternative.trim(), intake: form.intake.trim(), image: this.data.uploadedImage as string, time: '刚刚',
        support: 0, against: 0, supportRate: 0, totalVotes: 0, tags: ['新提交'], emoji: '🍽️',
      }
      const approvals = [approval, ...(this.data.approvals as Approval[])]
      const record: MyRecord = { id: approval.id, title: approval.title, time: '刚刚', calorie: approval.calorie, status: approval.status, statusLabel: approval.statusLabel, checkinResult: '' }
      const submittedCount = (this.data.submittedCount as number) + 1
      const myRecords = [record, ...(this.data.myRecords as MyRecord[])]
      this.setData({ approvals, filteredApprovals: this.filterApprovals(approvals, this.data.activeFilter as FilterKey), myRecords, form: blankForm(), uploadedImage: '', foodSuggestions: [], foodMatchHint: '', selectedFoodId: '', portionOptions: [], portionIndex: 0, calorieHint: '', calorieSource: 'manual' as CalorieSource, submittedCount, approvalRate: Math.round((this.data.approvedCount as number) / submittedCount * 100), activeTab: 'square' as TabKey, formFocusAnchor: '', keyboardHeight: 0, pageScrollStyle: '' })
      wx.showToast({ title: '审批单已发出', icon: 'success' })
    },
    resetForm() {
      this.setData({ form: blankForm(), uploadedImage: '', foodSuggestions: [], foodMatchHint: '', selectedFoodId: '', portionOptions: [], portionIndex: 0, calorieHint: '', calorieSource: 'manual' as CalorieSource })
    },
    saveFoodRecord() {
      const form = this.data.form as ApprovalForm
      const foodName = form.foodName.trim()
      if (!foodName) { wx.showToast({ title: '请填写食物名称', icon: 'none' }); return }
      const calorie = form.calorie.trim()
      if (calorie && (!Number.isFinite(Number(calorie)) || Number(calorie) < 0)) { wx.showToast({ title: '请输入有效热量', icon: 'none' }); return }
      const record: MyRecord = { id: Date.now(), title: foodName, time: '刚刚', calorie: calorie || '待估算', status: 'logged', statusLabel: '已记录', checkinResult: '' }
      const myRecords = [record, ...(this.data.myRecords as MyRecord[])]
      const addedCalories = calorie ? Number(calorie) : 0
      const todayCalories = (this.data.todayCalories as number) + addedCalories
      const calorieQuota = this.data.calorieQuota as number
      this.setData({ myRecords, form: blankForm(), uploadedImage: '', foodSuggestions: [], foodMatchHint: '', selectedFoodId: '', portionOptions: [], portionIndex: 0, calorieHint: '', calorieSource: 'manual' as CalorieSource, activeTab: 'me' as TabKey, formFocusAnchor: '', keyboardHeight: 0, pageScrollStyle: '', todayCalories, quotaPercent: Math.min(100, Math.round(todayCalories / calorieQuota * 100)) })
      wx.showToast({ title: '已添加到今日记录', icon: 'success' })
    },
    checkIn(e: any) {
      const result = e.currentTarget.dataset.result as string
      const id = Number(e.currentTarget.dataset.id)
      const myRecords = (this.data.myRecords as MyRecord[]).map(record => record.id === id ? { ...record, checkinResult: result } : record)
      this.setData({ myRecords })
      wx.showToast({ title: `已记录：${result}`, icon: 'success' })
    },
  },
})
