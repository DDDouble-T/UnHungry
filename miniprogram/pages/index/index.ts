import { requestApprovalSubscription } from '../../config'
import { ApiApproval, ApiFood, ApiRecord, ApiStats, checkIn as submitCheckIn, createApproval, createApprovalVote, createFoodRecord, fetchApproval, fetchApprovals, fetchFoods, fetchRecords, fetchStats, isApiConfigured, resolveApprovalImages, uploadApprovalImage } from '../../utils/api'

type TabKey = 'square' | 'apply' | 'record' | 'me'
type FilterKey = 'all' | 'pending' | 'approved' | 'rejected'
type Status = 'pending' | 'approved' | 'rejected'
type RecordStatus = Status | 'logged'
type VoteChoice = 'approve' | 'wait'
type FormField = 'foodName' | 'price' | 'calorie' | 'reason' | 'alternative' | 'intake'
type CalorieSource = 'manual' | 'server'

interface FoodPortion {
  label: string
  calorie: number
}

interface Food {
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

interface FoodSuggestion extends Food {
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

const blankForm = (): ApprovalForm => ({ foodName: '', price: '', calorie: '', portion: '', reason: '', alternative: '', intake: '' })
let keyboardHeightListener: ((result: { height: number }) => void) | null = null
let foodSearchRequestId = 0
let dataLoadRequestId = 0

function normalizeFoodKeyword(value: string) {
  return value.trim().toLowerCase().replace(/[\s·＋+、,，。/\\_-]/g, '')
}

function mapFood(food: ApiFood): FoodSuggestion {
  return { ...food, rangeLabel: `${food.calorieRange[0]}-${food.calorieRange[1]} kcal` }
}

function mapApiRecord(item: ApiRecord): MyRecord {
  return {
    id: item.id,
    title: item.title,
    time: item.time ? relativeTime(item.time) : '',
    calorie: item.calorie === null || item.calorie === undefined ? '待估算' : String(item.calorie),
    status: item.status,
    statusLabel: item.statusLabel,
    checkinResult: item.checkinResult || '',
  }
}

function relativeTime(value: string) {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return value
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

Component({
  data: {
    activeTab: 'square' as TabKey,
    activeFilter: 'all' as FilterKey,
    approvals: [] as Approval[],
    filteredApprovals: [] as Approval[],
    form: blankForm(),
    foodSuggestions: [] as FoodSuggestion[],
    foodMatchHint: '',
    selectedFoodId: '',
    selectedFood: null as Food | null,
    portionOptions: [] as string[],
    portionIndex: 0,
    calorieHint: '',
    calorieSource: 'manual' as CalorieSource,
    uploadedImage: '',
    myRecords: [] as MyRecord[],
    shareTargetId: '',
    shareAnchor: '',
    formFocusAnchor: '',
    keyboardHeight: 0,
    pageScrollStyle: '',
    voteTargetId: '',
    voteChoice: '' as VoteChoice | '',
    voteReason: '',
    todayCalories: 0,
    calorieQuota: 0,
    quotaPercent: 0,
    savedCalories: 0,
    approvalRate: 0,
    approvedCount: 0,
    submittedCount: 0,
    topRejected: '',
    filterCounts: { all: 0, pending: 0, approved: 0, rejected: 0 },
    loading: true,
    apiError: '',
    initialLoadStarted: false,
    voteSubmitting: false,
    approvalSubmitting: false,
    recordSubmitting: false,
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
      this.setData({ initialLoadStarted: true })
      void this.loadData(this.data.shareTargetId as string)
    },
    detached() {
      if (!keyboardHeightListener) return
      wx.offKeyboardHeightChange(keyboardHeightListener)
      keyboardHeightListener = null
    },
  },
  methods: {
    onLoad(query: any) {
      const approvalId = String(query && query.approvalId || '')
      if (!approvalId) return
      this.setData({ activeTab: 'square' as TabKey, activeFilter: 'all' as FilterKey, shareTargetId: approvalId, shareAnchor: `approval-${approvalId}` })
      if (this.data.initialLoadStarted) void this.loadData(approvalId)
    },
    async loadData(sharedApprovalId = '') {
      const requestId = ++dataLoadRequestId
      if (!isApiConfigured()) {
        this.setData({ loading: false, apiError: '请先配置后端服务' })
        return
      }
      this.setData({ loading: true, apiError: '' })
      try {
        const [rawApprovals, apiRecords, apiStats] = await Promise.all([fetchApprovals(), fetchRecords(), fetchStats()])
        const apiItems = await resolveApprovalImages(rawApprovals)
        if (requestId !== dataLoadRequestId) return
        const approvals = apiItems.map(item => this.mapApiApproval(item))
        const records = apiRecords.map(mapApiRecord)
        const stats = apiStats as ApiStats
        const update: Record<string, unknown> = {
          approvals,
          filteredApprovals: this.filterApprovals(approvals, this.data.activeFilter as FilterKey),
          filterCounts: this.getFilterCounts(approvals),
          myRecords: records,
          todayCalories: stats.todayCalories,
          calorieQuota: stats.calorieQuota,
          quotaPercent: stats.calorieQuota ? Math.min(100, Math.round(stats.todayCalories / stats.calorieQuota * 100)) : 0,
          savedCalories: stats.savedCalories,
          approvalRate: stats.approvalRate,
          approvedCount: stats.approvedCount,
          submittedCount: stats.submittedCount,
          topRejected: stats.topRejected,
          loading: false,
        }
        this.setData(update)
        if (sharedApprovalId && !approvals.some(item => item.id === sharedApprovalId)) {
          try {
            const [sharedItem] = await resolveApprovalImages([await fetchApproval(sharedApprovalId)])
            if (requestId !== dataLoadRequestId) return
            const sharedApproval = this.mapApiApproval(sharedItem)
            const withShared = [sharedApproval, ...approvals]
            this.setData({ approvals: withShared, filteredApprovals: this.filterApprovals(withShared, this.data.activeFilter as FilterKey), filterCounts: this.getFilterCounts(withShared) })
          } catch (_error) {
            wx.showToast({ title: '这张审批单暂时无法查看', icon: 'none' })
          }
        }
      } catch (error) {
        if (requestId !== dataLoadRequestId) return
        console.warn('load approvals failed', error)
        this.setData({ loading: false, apiError: '数据加载失败，请稍后重试' })
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
      return relativeTime(value)
    },
    getFilterCounts(approvals: Approval[]) {
      return approvals.reduce((counts, item) => {
        counts.all += 1
        counts[item.status] += 1
        return counts
      }, { all: 0, pending: 0, approved: 0, rejected: 0 })
    },
    onShareAppMessage(options: any) {
      const buttonId = options && options.from === 'button' && options.target
        ? String(options.target.dataset.id || '')
        : ''
      const selectedId = buttonId || (this.data.shareTargetId as string)
      const approval = (this.data.approvals as Approval[]).find(item => item.id === selectedId)
      const title = approval
        ? `帮我看看「${approval.title}」这顿要不要吃？`
        : '吃之前，先来一张饮食审批单'
      const path = approval ? `/pages/index/index?approvalId=${encodeURIComponent(approval.id)}` : '/pages/index/index'
      return { title, path }
    },
    onShareTimeline() {
      const selectedId = this.data.shareTargetId as string
      const approval = (this.data.approvals as Approval[]).find(item => item.id === selectedId)
      if (!approval) return { title: '吃之前，先来一张饮食审批单' }
      return {
        title: `「${approval.title}」要不要吃？帮忙审批一下`,
        query: `approvalId=${encodeURIComponent(approval.id)}`,
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
      const id = String(e.currentTarget.dataset.id || '')
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
    retryLoadData() {
      void this.loadData(this.data.shareTargetId as string)
    },
    openVote(e: any) {
      this.setData({ voteTargetId: String(e.currentTarget.dataset.id || ''), voteChoice: e.currentTarget.dataset.choice as VoteChoice, voteReason: '' })
    },
    closeVoteSheet() { this.setData({ voteTargetId: '', voteChoice: '', voteReason: '' }) },
    stopPropagation() {},
    onVoteReasonInput(e: any) { this.setData({ voteReason: e.detail.value }) },
    async submitVote() {
      if (this.data.voteSubmitting) return
      const reason = (this.data.voteReason as string).trim()
      if (!reason) { wx.showToast({ title: '写下理由才算有效票', icon: 'none' }); return }
      const targetId = this.data.voteTargetId as string
      const choice = this.data.voteChoice as VoteChoice
      this.setData({ voteSubmitting: true })
      try {
        const updated = this.mapApiApproval(await createApprovalVote(targetId, { choice, reason }))
        const approvals = (this.data.approvals as Approval[]).map(item => item.id === targetId ? updated : item)
        this.setData({ approvals, filteredApprovals: this.filterApprovals(approvals, this.data.activeFilter as FilterKey), filterCounts: this.getFilterCounts(approvals), voteTargetId: '', voteChoice: '', voteReason: '' })
        await this.loadData()
        wx.showToast({ title: '投票已计入', icon: 'success' })
      } catch (error) {
        console.warn('submit vote failed', error)
        wx.showToast({ title: error instanceof Error ? error.message : '投票失败，请稍后重试', icon: 'none' })
      } finally {
        this.setData({ voteSubmitting: false })
      }
    },
    onFormInput(e: any) {
      const field = e.currentTarget.dataset.field as FormField
      const value = String(e.detail.value || '')
      if (field === 'foodName') {
        const selectedFood = this.data.selectedFood as Food | null
        const keepSelection = Boolean(selectedFood && normalizeFoodKeyword(value) === normalizeFoodKeyword(selectedFood.name))
        const requestId = ++foodSearchRequestId
        const updates: Record<string, unknown> = { [`form.${field}`]: value, foodSuggestions: [], foodMatchHint: '' }
        if (!keepSelection) {
          updates.selectedFoodId = ''
          updates.selectedFood = null
          updates.portionOptions = []
          updates.portionIndex = 0
          updates.calorieHint = ''
          updates.calorieSource = 'manual'
          updates['form.calorie'] = ''
          updates['form.portion'] = ''
        }
        this.setData(updates)
        if (value.trim()) void this.searchFoods(value, requestId)
        return
      }
      this.setData({ [`form.${field}`]: value, ...(field === 'calorie' ? { calorieSource: 'manual' as CalorieSource } : {}) })
    },
    dismissFoodSuggestions() {
      // 关闭后忽略在途搜索结果，避免填写其他字段时下拉框重新出现。
      foodSearchRequestId += 1
      this.setData({ foodSuggestions: [], foodMatchHint: '' })
    },
    async searchFoods(keyword: string, requestId: number) {
      try {
        const suggestions = (await fetchFoods(keyword)).map(mapFood)
        if (requestId !== foodSearchRequestId) return
        this.setData({ foodSuggestions: suggestions, foodMatchHint: keyword.trim() && !suggestions.length ? '未找到匹配食物，可手动填写热量' : '' })
      } catch (error) {
        if (requestId !== foodSearchRequestId) return
        console.warn('search foods failed', error)
        this.setData({ foodSuggestions: [], foodMatchHint: '食物数据暂时不可用，可手动填写热量' })
      }
    },
    selectFood(e: any) {
      const foodId = String(e.currentTarget.dataset.id || '')
      const food = (this.data.foodSuggestions as FoodSuggestion[]).find(item => item.id === foodId)
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
        selectedFood: food,
        portionOptions: food.portions.map(item => `${item.label} · ${item.calorie} kcal`),
        portionIndex: defaultIndex,
        calorieHint: `参考范围：${food.calorieRange[0]}-${food.calorieRange[1]} kcal`,
        calorieSource: 'server' as CalorieSource,
      })
    },
    onPortionChange(e: any) {
      const food = this.data.selectedFood as Food | null
      const portionIndex = Number(e.detail.value)
      const portion = food && food.portions[portionIndex]
      if (!food || !portion) return
      this.setData({
        'form.portion': portion.label,
        'form.calorie': String(portion.calorie),
        portionIndex,
        calorieSource: 'server' as CalorieSource,
      })
    },
    onFormFocus(e: any) {
      const field = e.currentTarget.dataset.field as FormField
      if (field !== 'foodName') this.dismissFoodSuggestions()
      this.setData({ formFocusAnchor: `form-field-${field}` })
    },
    chooseImage() {
      wx.chooseImage({ count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'], success: res => this.setData({ uploadedImage: res.tempFilePaths[0] }) })
    },
    async submitApproval() {
      if (this.data.approvalSubmitting) return
      const form = this.data.form as ApprovalForm
      const required: Array<[keyof ApprovalForm, string]> = [['foodName', '食物名称'], ['reason', '想吃理由']]
      const missing = required.find(([field]) => !form[field].trim())
      if (missing) { wx.showToast({ title: `请补充${missing[1]}`, icon: 'none' }); return }
      const price = form.price.trim()
      if (price && (!Number.isFinite(Number(price)) || Number(price) < 0)) { wx.showToast({ title: '请输入有效价格', icon: 'none' }); return }
      if (!isApiConfigured()) { wx.showToast({ title: '请先配置后端服务', icon: 'none' }); return }
      this.setData({ approvalSubmitting: true })
      try {
        await requestApprovalSubscription()
        const imagePath = this.data.uploadedImage as string
        const image = imagePath ? await uploadApprovalImage(imagePath) : ''
        const item = await createApproval({
          title: form.foodName.trim(),
          ...(price ? { price: Number(price) } : {}),
          ...(form.calorie.trim() ? { calorie: Number(form.calorie) } : {}),
          reason: form.reason.trim(),
          alternative: form.alternative.trim(),
          intake: form.intake.trim(),
          image,
        })
        const approval = this.mapApiApproval(item)
        const approvals = [approval, ...(this.data.approvals as Approval[])]
        this.setData({ approvals, filteredApprovals: this.filterApprovals(approvals, this.data.activeFilter as FilterKey), filterCounts: this.getFilterCounts(approvals), form: blankForm(), uploadedImage: '', foodSuggestions: [], foodMatchHint: '', selectedFoodId: '', selectedFood: null, portionOptions: [], portionIndex: 0, calorieHint: '', calorieSource: 'manual' as CalorieSource, activeTab: 'square' as TabKey, formFocusAnchor: '', keyboardHeight: 0, pageScrollStyle: '' })
        await this.loadData()
        wx.showToast({ title: '审批单已发出', icon: 'success' })
      } catch (error) {
        console.warn('create approval failed', error)
        wx.showToast({ title: error instanceof Error ? error.message : '提交失败，请稍后重试', icon: 'none' })
      } finally {
        this.setData({ approvalSubmitting: false })
      }
    },
    resetForm() {
      foodSearchRequestId += 1
      this.setData({ form: blankForm(), uploadedImage: '', foodSuggestions: [], foodMatchHint: '', selectedFoodId: '', selectedFood: null, portionOptions: [], portionIndex: 0, calorieHint: '', calorieSource: 'manual' as CalorieSource })
    },
    async saveFoodRecord() {
      if (this.data.recordSubmitting) return
      const form = this.data.form as ApprovalForm
      const foodName = form.foodName.trim()
      if (!foodName) { wx.showToast({ title: '请填写食物名称', icon: 'none' }); return }
      const calorie = form.calorie.trim()
      if (calorie && (!Number.isFinite(Number(calorie)) || Number(calorie) < 0)) { wx.showToast({ title: '请输入有效热量', icon: 'none' }); return }
      if (!isApiConfigured()) { wx.showToast({ title: '请先配置后端服务', icon: 'none' }); return }
      this.setData({ recordSubmitting: true })
      try {
        const imagePath = this.data.uploadedImage as string
        const image = imagePath ? await uploadApprovalImage(imagePath) : ''
        await createFoodRecord({ title: foodName, ...(calorie ? { calorie: Number(calorie) } : {}), image })
        this.resetForm()
        this.setData({ activeTab: 'me' as TabKey, formFocusAnchor: '', keyboardHeight: 0, pageScrollStyle: '' })
        await this.loadData()
        wx.showToast({ title: '已添加到今日记录', icon: 'success' })
      } catch (error) {
        console.warn('save food record failed', error)
        wx.showToast({ title: error instanceof Error ? error.message : '保存失败，请稍后重试', icon: 'none' })
      } finally {
        this.setData({ recordSubmitting: false })
      }
    },
    async checkIn(e: any) {
      const result = e.currentTarget.dataset.result as '真香' | '后悔'
      const id = String(e.currentTarget.dataset.id || '')
      try {
        const updated = mapApiRecord(await submitCheckIn(id, result))
        const myRecords = (this.data.myRecords as MyRecord[]).map(record => record.id === id ? updated : record)
        this.setData({ myRecords })
        wx.showToast({ title: `已记录：${result}`, icon: 'success' })
      } catch (error) {
        console.warn('check in failed', error)
        wx.showToast({ title: error instanceof Error ? error.message : '打卡失败，请稍后重试', icon: 'none' })
      }
    },
  },
})
