import { requestApprovalSubscription } from '../../config'
import { createApprovalPoster } from '../../utils/approval-poster'
import { getQuotaState } from '../../utils/quota'
import { ApiApproval, ApiApprovalMessage, ApiFood, ApiRecord, ApiStats, checkIn as submitCheckIn, createApproval, createApprovalVote, createFoodRecord, fetchApproval, fetchApprovalMessages, fetchApprovals, fetchFoods, fetchRecords, fetchStats, isApiConfigured, recordApprovalFood as submitApprovalFood, resolveApprovalImages, resolveImageUrls, uploadApprovalImage, uploadAuthorAvatar } from '../../utils/api'

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
  authorName: string
  authorAvatar: string
  status: Status
  isMine: boolean
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
  foodDecided: boolean
  foodResult: 'eaten' | 'skipped' | ''
  messages: string[]
  messageExpanded: boolean
  messageNeedsExpand: boolean
}

interface ApprovalForm {
  authorName: string
  authorAvatar: string
  isAnonymous: boolean
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
  isApproval: boolean
  foodRecorded: boolean
  title: string
  time: string
  calorie: string
  status: RecordStatus
  statusLabel: string
  checkinResult: string
}

interface BarrageMessage {
  id: string
  approvalId: string
  text: string
  createdAt: string
}

interface BarrageItem extends BarrageMessage {
  background: string
  textColor: string
  delay: number
  renderKey: string
}

const labels: Record<Status, string> = { pending: '待判官', approved: '已放行', rejected: '暂缓驳回' }

function savedAuthor(): { authorName: string; authorAvatar: string } {
  try {
    const profile = wx.getStorageSync('approvalAuthor')
    if (profile && typeof profile.authorName === 'string') {
      return { authorName: profile.authorName.trim().slice(0, 32), authorAvatar: typeof profile.authorAvatar === 'string' ? profile.authorAvatar : '' }
    }
    const name = wx.getStorageSync('approvalAuthorName')
    return { authorName: typeof name === 'string' ? name.trim().slice(0, 32) : '', authorAvatar: '' }
  } catch { return { authorName: '', authorAvatar: '' } }
}

const blankForm = (): ApprovalForm => ({ ...savedAuthor(), isAnonymous: false, foodName: '', price: '', calorie: '', portion: '', reason: '', alternative: '', intake: '' })
let keyboardHeightListener: ((result: { height: number }) => void) | null = null
let foodSearchRequestId = 0
let dataLoadRequestId = 0

const fallbackBarrageMessages = [
  '这不是馋，是生活在发光',
  '今天这口，允许自己快乐一下',
  '先吃两口垫垫，别让肚子开会',
  '运动量达标，热量先记账',
  '看着就香，但建议少来一点',
  '这顿不吃，快乐要打折',
  '允许放纵一次，明天继续自律',
  '再等等，下一顿会更香',
  '批准通过，人生没有撤回键',
  '建议开吃，别让胃等太久',
]

const barrageColors = [
  { background: '#d8d0d2', textColor: '#695d63' },
  { background: '#d3d9cf', textColor: '#5f6b5e' },
  { background: '#d2d8df', textColor: '#5d6874' },
  { background: '#ded5c7', textColor: '#716452' },
  { background: '#d9d1dc', textColor: '#6e6177' },
  { background: '#d0dadd', textColor: '#5b6d71' },
]

function normalizeFoodKeyword(value: string) {
  return value.trim().toLowerCase().replace(/[\s·＋+、,，。/\\_-]/g, '')
}

function mapFood(food: ApiFood): FoodSuggestion {
  return { ...food, rangeLabel: `${food.calorieRange[0]}-${food.calorieRange[1]} kcal` }
}

function mapApiRecord(item: ApiRecord): MyRecord {
  return {
    id: item.id,
    isApproval: Boolean(item.recordId),
    foodRecorded: Boolean(item.foodRecorded),
    title: item.title,
    time: item.time ? relativeTime(item.time) : '',
    calorie: item.calorie === null || item.calorie === undefined ? '待估算' : String(item.calorie),
    status: item.status,
    statusLabel: item.status === 'logged' ? '已记录' : labels[item.status],
    checkinResult: item.checkinResult === '真香' ? '已记录' : item.checkinResult === '后悔' ? '忍住了，真棒' : item.checkinResult || '',
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
    nicknameAction: '' as '' | 'apply' | 'submit' | 'edit',
    nicknameInitialValue: '',
    avatarPreview: '',
    avatarDraft: '',
    avatarDraftPath: '',
    profileSaving: false,
    nicknameKeyboardHeight: 0,
    foodSuggestions: [] as FoodSuggestion[],
    foodMatchHint: '',
    selectedFoodId: '',
    selectedFood: null as Food | null,
    portionOptions: [] as string[],
    portionIndex: 0,
    calorieHint: '',
    calorieSource: 'manual' as CalorieSource,
    uploadedImage: '',
    uploadedImageSource: '',
    recordPrefillId: '',
    recordActionId: '',
    recordApprovalId: '',
    myRecords: [] as MyRecord[],
    shareTargetId: '',
    shareSheetId: '',
    posterGenerating: false,
    shareAnchor: '',
    formFocusAnchor: '',
    keyboardHeight: 0,
    pageScrollStyle: '',
    voteTargetId: '',
    voteChoice: '' as VoteChoice | '',
    voteReason: '',
    barrageMessages: [] as BarrageMessage[],
    barrageItems: [] as BarrageItem[],
    barrageStarted: false,
    ...getQuotaState(0, 0),
    savedCalories: 0,
    approvalRate: 0,
    approvedCount: 0,
    submittedCount: 0,
    topRejected: '',
    loading: true,
    apiError: '',
    hasLoadedData: false,
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
      void this.restoreAuthorAvatar()
      this.setData({ initialLoadStarted: true })
      void this.loadData(this.data.shareTargetId as string)
    },
    detached() {
      if (keyboardHeightListener) {
        wx.offKeyboardHeightChange(keyboardHeightListener)
        keyboardHeightListener = null
      }
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
        if (this.data.hasLoadedData) {
          wx.showToast({ title: '服务暂不可用，当前内容已保留', icon: 'none' })
          return
        }
        const fallbackMessages = this.buildBarrageMessages([])
        this.setData({ barrageMessages: fallbackMessages })
        this.startBarrage(fallbackMessages)
        this.setData({ loading: false, apiError: '请先配置后端服务' })
        return
      }
      if (!this.data.hasLoadedData) this.setData({ loading: true, apiError: '' })
      try {
        const [rawApprovals, apiRecords, apiStats, rawMessages] = await Promise.all([
          fetchApprovals(),
          fetchRecords(),
          fetchStats(),
          fetchApprovalMessages().catch(error => {
            // 兼容尚未部署留言接口的旧云托管版本，首页主数据不应因此失败。
            console.warn('load approval messages failed', error)
            return [] as ApiApprovalMessage[]
          }),
        ])
        const apiItems = await resolveApprovalImages(rawApprovals)
        if (requestId !== dataLoadRequestId) return
        const records = apiRecords.map(mapApiRecord)
        const approvalRecords = new Map(apiRecords.filter(record => record.recordId).map(record => [record.id, record]))
        const approvalMessages = this.groupApprovalMessages(rawMessages)
        const mapApproval = (item: ApiApproval) => {
          const record = approvalRecords.get(item.id)
          // 我的原审批记录也能确定饮食结果，兼容尚未返回广场结果字段的服务。
          const foodResult = record && (record.foodRecorded || record.checkinResult === '真香') ? 'eaten'
            : record && record.checkinResult === '后悔' ? 'skipped' : item.foodResult
          return this.mapApiApproval({ ...item, foodDecided: Boolean(item.foodDecided || foodResult), foodResult }, Boolean(record), approvalMessages.get(item.id) || [])
        }
        const approvals = apiItems.map(mapApproval)
        const barrageMessages = this.buildBarrageMessages(rawMessages)
        const stats = apiStats as ApiStats
        const update: Record<string, unknown> = {
          approvals,
          filteredApprovals: this.filterApprovals(approvals, this.data.activeFilter as FilterKey),
          myRecords: records,
          ...getQuotaState(stats.todayCalories, stats.calorieQuota),
          savedCalories: stats.savedCalories,
          approvalRate: stats.approvalRate,
          approvedCount: stats.approvedCount,
          submittedCount: stats.submittedCount,
          topRejected: stats.topRejected,
          barrageMessages,
          loading: false,
          apiError: '',
          hasLoadedData: true,
        }
        this.setData(update)
        this.startBarrage(barrageMessages)
        if (sharedApprovalId && !approvals.some(item => item.id === sharedApprovalId)) {
          try {
            const [sharedItem] = await resolveApprovalImages([await fetchApproval(sharedApprovalId)])
            if (requestId !== dataLoadRequestId) return
            const sharedApproval = mapApproval(sharedItem)
            const withShared = [sharedApproval, ...approvals]
            this.setData({ approvals: withShared, filteredApprovals: this.filterApprovals(withShared, this.data.activeFilter as FilterKey) })
          } catch (_error) {
            if (requestId === dataLoadRequestId) wx.showToast({ title: '这张审批单暂时无法查看', icon: 'none' })
          }
        }
      } catch (error) {
        if (requestId !== dataLoadRequestId) return
        console.warn('load approvals failed', error)
        if (this.data.hasLoadedData) {
          wx.showToast({ title: '刷新失败，当前内容已保留', icon: 'none' })
          return
        }
        const fallbackMessages = this.buildBarrageMessages([])
        this.setData({ barrageMessages: fallbackMessages })
        this.startBarrage(fallbackMessages)
        this.setData({ loading: false, apiError: '数据加载失败，请稍后重试' })
      }
    },
    mapApiApproval(item: ApiApproval, isMine = false, messages: string[] = []): Approval {
      const status = item.status
      return {
        id: item.id,
        authorName: item.isAnonymous === false ? item.authorName || '微信用户' : '匿名',
        authorAvatar: item.isAnonymous === false ? item.authorAvatar || '' : '',
        status,
        isMine,
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
        foodDecided: Boolean(item.foodDecided),
        foodResult: item.foodResult || '',
        messages,
        messageExpanded: false,
        messageNeedsExpand: messages.length > 1 || (messages[0] || '').length > 18,
        support: item.support,
        against: item.against,
        totalVotes: item.totalVotes,
        supportRate: item.supportRate,
        tags: item.tags || [],
        emoji: item.emoji || '🍽️',
      }
    },
    groupApprovalMessages(items: ApiApprovalMessage[]) {
      const grouped = new Map<string, string[]>()
      items.forEach(item => {
        const approvalId = typeof item.approvalId === 'string' ? item.approvalId : ''
        const text = typeof item.text === 'string' ? item.text.trim() : ''
        if (!approvalId || !text) return
        const messages = grouped.get(approvalId) || []
        if (messages.indexOf(text) === -1) messages.push(text)
        grouped.set(approvalId, messages)
      })
      return grouped
    },
    toggleApprovalMessages(e: any) {
      const id = String(e.currentTarget.dataset.id || '')
      const approvals = (this.data.approvals as Approval[]).map(item => item.id === id ? { ...item, messageExpanded: true } : item)
      this.setData({ approvals, filteredApprovals: this.filterApprovals(approvals, this.data.activeFilter as FilterKey) })
    },
    buildBarrageMessages(items: ApiApprovalMessage[]) {
      const messages: BarrageMessage[] = []
      const seen = new Set<string>()
      items.forEach((item, index) => {
        const text = typeof item.text === 'string' ? item.text.trim() : ''
        if (!text || seen.has(text)) return
        seen.add(text)
        messages.push({ id: item.id || `message-${index}`, approvalId: item.approvalId || '', text, createdAt: item.createdAt || '' })
      })
      fallbackBarrageMessages.forEach((text, index) => {
        if (messages.length >= 10 || seen.has(text)) return
        seen.add(text)
        messages.push({ id: `fallback-${index}`, approvalId: '', text, createdAt: '' })
      })
      return messages.slice(0, 10)
    },
    createBarrageItem(message: BarrageMessage, slot: number, delay: number, version: number): BarrageItem {
      const color = barrageColors[Math.floor(Math.random() * barrageColors.length)]
      return {
        ...message,
        ...color,
        delay,
        renderKey: `${message.id}-${slot}-${version}`,
      }
    },
    startBarrage(messages: BarrageMessage[]) {
      if (!messages.length || this.data.barrageStarted) return
      const initialItems = messages.slice(0, 3).map((message, index) => this.createBarrageItem(message, index, index * 2.2, 0))
      this.setData({ barrageItems: initialItems, barrageStarted: true })
    },
    relativeTime(value: string) {
      return relativeTime(value)
    },
    onShareAppMessage(options: any) {
      const buttonId = options && options.from === 'button' && options.target
        ? String(options.target.dataset.id || '')
        : ''
      const selectedId = buttonId || (this.data.shareTargetId as string)
      const approval = (this.data.approvals as Approval[]).find(item => item.id === selectedId)
      const title = approval
        ? `帮我看看「${approval.title}」这顿要不要吃？`
        : '干饭暂缓局｜想吃先提交，判官帮你踩刹车'
      const path = approval ? `/pages/index/index?approvalId=${encodeURIComponent(approval.id)}` : '/pages/index/index'
      this.closeShareSheet()
      return { title, path }
    },
    onShareTimeline() {
      const selectedId = this.data.shareTargetId as string
      const approval = (this.data.approvals as Approval[]).find(item => item.id === selectedId)
      if (!approval) return { title: '干饭暂缓局｜想吃先提交，判官帮你踩刹车' }
      return {
        title: `「${approval.title}」要不要吃？帮忙审批一下`,
        query: `approvalId=${encodeURIComponent(approval.id)}`,
      }
    },
    switchTab(e: any) {
      const activeTab = e.currentTarget.dataset.tab as TabKey
      if ((activeTab === 'square' || activeTab === 'me') && activeTab === this.data.activeTab) return
      if (activeTab === 'apply') { this.startApply(); return }
      this.setData({
        activeTab,
        shareSheetId: '',
        formFocusAnchor: '',
        ...(activeTab === 'record' ? {} : { keyboardHeight: 0, pageScrollStyle: '' }),
      })
      if (activeTab === 'square' || activeTab === 'me') void this.loadData(activeTab === 'square' ? this.data.shareTargetId as string : '')
    },
    startApply() {
      if (!this.data.form.isAnonymous && !this.data.form.authorName.trim()) {
        this.showNicknameSheet('apply')
        return
      }
      this.setData({ activeTab: 'apply' as TabKey, formFocusAnchor: 'form-field-foodName' })
    },
    showNicknameSheet(action: 'apply' | 'submit' | 'edit') {
      this.setData({ nicknameAction: action, nicknameInitialValue: this.data.form.authorName, avatarDraft: this.data.avatarPreview || this.data.form.authorAvatar, avatarDraftPath: '', nicknameKeyboardHeight: 0 })
    },
    editNickname() { this.showNicknameSheet('edit') },
    closeNicknameSheet() {
      if (this.data.profileSaving) return
      this.setData({ nicknameAction: '', nicknameKeyboardHeight: 0 })
    },
    async restoreAuthorAvatar() {
      const avatar = this.data.form.authorAvatar
      if (!avatar) return
      try {
        const urls = await resolveImageUrls([avatar])
        if (this.data.form.authorAvatar === avatar) {
          const preview = urls.get(avatar) || avatar
          this.setData({ avatarPreview: preview, ...(this.data.nicknameAction && !this.data.avatarDraftPath ? { avatarDraft: preview } : {}) })
        }
      } catch (error) { console.warn('load avatar failed', error) }
    },
    onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>) {
      if (this.data.profileSaving || !e.detail.avatarUrl) return
      this.setData({ avatarDraft: e.detail.avatarUrl, avatarDraftPath: e.detail.avatarUrl })
    },
    onNicknameReview(e: any) {
      const pass = Boolean(e.detail && e.detail.pass)
      if (this.data.nicknameAction && !pass && !(e.detail && e.detail.timeout)) {
        wx.showToast({ title: '昵称未通过审核，请重新选择或填写', icon: 'none' })
      }
    },
    onNicknameKeyboardHeightChange(e: any) { this.setData({ nicknameKeyboardHeight: Math.max(0, Number(e.detail.height) || 0) }) },
    async confirmNickname(e: WechatMiniprogram.CustomEvent<{ value: { authorName: string } }>) {
      if (this.data.profileSaving) return
      // 微信昵称由原生组件回填，并在失焦时异步审核；以表单提交值为准，避免缓存输入值覆盖回填结果。
      const authorName = e.detail.value.authorName.trim()
      if (!authorName) { wx.showToast({ title: '请选择或填写昵称', icon: 'none' }); return }
      if (authorName.length > 32) { wx.showToast({ title: '昵称最多32个字符', icon: 'none' }); return }
      const action = this.data.nicknameAction
      this.setData({ profileSaving: true })
      try {
        // chooseAvatar 返回临时路径；上传后缓存云文件 ID，避免下次打开头像失效。
        const authorAvatar = this.data.avatarDraftPath ? await uploadAuthorAvatar(this.data.avatarDraftPath) : this.data.form.authorAvatar
        wx.setStorageSync('approvalAuthor', { authorName, authorAvatar })
        this.setData({ 'form.authorName': authorName, 'form.authorAvatar': authorAvatar, avatarPreview: this.data.avatarDraft || this.data.avatarPreview || authorAvatar, nicknameAction: '', nicknameKeyboardHeight: 0 })
        if (action === 'apply') this.startApply()
        if (action === 'submit') void this.submitApproval()
      } catch (error) {
        console.warn('save profile failed', error)
        wx.showToast({ title: '保存失败，请重试', icon: 'none' })
      } finally {
        this.setData({ profileSaving: false })
      }
    },
    onAnonymousChange(e: any) {
      this.setData({ 'form.isAnonymous': e.detail.value.indexOf('anonymous') !== -1 })
    },
    startRecord() {
      this.resetForm()
      this.setData({ activeTab: 'record' as TabKey, formFocusAnchor: 'form-field-foodName' })
    },
    async recordApprovalFood(e: any) {
      if (this.data.recordPrefillId) return
      const id = String(e.currentTarget.dataset.id || '')
      const record = (this.data.myRecords as MyRecord[]).find(item => item.id === id && item.isApproval && !item.foodRecorded && !item.checkinResult)
      if (!record) return
      this.setData({ recordPrefillId: id })
      try {
        // 单独读取原审批，避免广场分页或图片临时 URL 丢失已知内容。
        const approval = await fetchApproval(id)
        const [preview] = await resolveApprovalImages([approval])
        if (this.data.activeTab !== 'me') return
        this.resetForm()
        this.setData({
          recordApprovalId: id,
          activeTab: 'record' as TabKey,
          formFocusAnchor: 'form-field-foodName',
          'form.foodName': approval.title,
          'form.calorie': approval.calorie === null || approval.calorie === undefined ? '' : String(approval.calorie),
          uploadedImage: preview.image || '',
          uploadedImageSource: approval.image || '',
        })
      } catch (error) {
        console.warn('prefill approval food failed', error)
        wx.showToast({ title: '读取审批单失败，请重试', icon: 'none' })
      } finally {
        this.setData({ recordPrefillId: '' })
      }
    },
    openFriends() { wx.showToast({ title: '亲友群审批即将开放', icon: 'none' }) },
    openShareSheet(e: any) {
      const id = String(e.currentTarget.dataset.id || '')
      if (!(this.data.approvals as Approval[]).some(item => item.id === id)) return
      this.setData({ shareSheetId: id, shareTargetId: id })
    },
    closeShareSheet() { this.setData({ shareSheetId: '' }) },
    async previewShareCard() {
      if (this.data.posterGenerating) return
      const approval = (this.data.approvals as Approval[]).find(item => item.id === this.data.shareSheetId)
      if (!approval) return
      this.setData({ posterGenerating: true })
      try {
        const canvas = await new Promise<WechatMiniprogram.Canvas>((resolve, reject) => {
          this.createSelectorQuery().select('#approval-poster').fields({ node: true, size: true }).exec((result: any[]) => {
            if (result[0] && result[0].node) resolve(result[0].node as WechatMiniprogram.Canvas)
            else reject(new Error('分享画布尚未就绪'))
          })
        })
        const path = await createApprovalPoster(canvas, approval, wx.getSystemInfoSync().pixelRatio)
        // 生成期间用户可能已关闭或切换申请，旧结果不应打断新的分享操作。
        if (this.data.shareSheetId !== approval.id) return
        this.closeShareSheet()
        // 原生预览支持长按保存，不额外索取相册权限；导出图只含本张申请。
        wx.previewImage({ current: path, urls: [path], fail: () => wx.showToast({ title: '图片预览失败，请重试', icon: 'none' }) })
      } catch (error) {
        console.warn('generate share card failed', error)
        if (this.data.shareSheetId === approval.id) wx.showToast({ title: '分享图生成失败，请重试', icon: 'none' })
      } finally {
        this.setData({ posterGenerating: false })
      }
    },
    prepareTimelineShare(e: any) {
      const id = String(e.currentTarget.dataset.id || '')
      this.setData({ shareTargetId: id, shareSheetId: '' })
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
      if (filter === 'all') return approvals
      if (filter === 'pending') {
        // 服务端只返回有效期内的审批单；是否已选择饮食结果与投票结论分开判断。
        return approvals.filter(item => !item.foodDecided)
      }
      return approvals.filter(item => item.status === filter)
    },
    markApprovalFoodDecided(id: string, foodResult: 'eaten' | 'skipped') {
      const approvals = (this.data.approvals as Approval[]).map(item => item.id === id ? { ...item, foodDecided: true, foodResult } : item)
      this.setData({ approvals, filteredApprovals: this.filterApprovals(approvals, this.data.activeFilter as FilterKey) })
    },
    applySavedRecord(record: MyRecord) {
      // 写入前发出的列表请求不能再覆盖接口已确认的新记录或饮食结果。
      dataLoadRequestId += 1
      const records = this.data.myRecords as MyRecord[]
      const myRecords = records.some(item => item.id === record.id)
        ? records.map(item => item.id === record.id ? record : item)
        : [record, ...records]
      this.setData({ myRecords, loading: false, hasLoadedData: true })
    },
    retryLoadData() {
      void this.loadData(this.data.shareTargetId as string)
    },
    openVote(e: any) {
      const targetId = String(e.currentTarget.dataset.id || '')
      const target = (this.data.approvals as Approval[]).find(item => item.id === targetId)
      if (!target || target.foodDecided || target.status !== 'pending') return
      if (target.isMine) {
        wx.showToast({ title: '自己发起的审批不能投票', icon: 'none' })
        return
      }
      this.setData({ voteTargetId: targetId, voteChoice: e.currentTarget.dataset.choice as VoteChoice, voteReason: '' })
    },
    closeVoteSheet() { this.setData({ voteTargetId: '', voteChoice: '', voteReason: '' }) },
    stopPropagation() {},
    onVoteReasonInput(e: any) { this.setData({ voteReason: e.detail.value }) },
    async submitVote() {
      if (this.data.voteSubmitting) return
      const reason = (this.data.voteReason as string).trim()
      if (!reason) { wx.showToast({ title: '写下理由才算有效票', icon: 'none' }); return }
      const targetId = this.data.voteTargetId as string
      const target = (this.data.approvals as Approval[]).find(item => item.id === targetId)
      if (!target || target.foodDecided || target.status !== 'pending') { this.closeVoteSheet(); return }
      const choice = this.data.voteChoice as VoteChoice
      this.setData({ voteSubmitting: true })
      try {
        const item = await createApprovalVote(targetId, { choice, reason })
        const existing = (this.data.approvals as Approval[]).find(approval => approval.id === targetId)
        const updated = this.mapApiApproval({ ...item, authorAvatar: existing ? existing.authorAvatar : '', image: existing && existing.image || item.image }, Boolean(existing && existing.isMine), existing ? existing.messages : [])
        const approvals = (this.data.approvals as Approval[]).map(item => item.id === targetId ? updated : item)
        this.setData({ approvals, filteredApprovals: this.filterApprovals(approvals, this.data.activeFilter as FilterKey), voteTargetId: '', voteChoice: '', voteReason: '' })
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
      wx.chooseImage({ count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'], success: res => this.setData({ uploadedImage: res.tempFilePaths[0], uploadedImageSource: '' }) })
    },
    async submitApproval() {
      if (this.data.approvalSubmitting) return
      const form = this.data.form as ApprovalForm
      const required: Array<[FormField, string]> = [['foodName', '食物名称'], ['reason', '想吃理由']]
      const missing = required.find(([field]) => !form[field].trim())
      if (missing) { wx.showToast({ title: `请补充${missing[1]}`, icon: 'none' }); return }
      if (!form.isAnonymous && !form.authorName.trim()) { this.showNicknameSheet('submit'); return }
      const price = form.price.trim()
      if (price && (!Number.isFinite(Number(price)) || Number(price) < 0)) { wx.showToast({ title: '请输入有效价格', icon: 'none' }); return }
      if (!isApiConfigured()) { wx.showToast({ title: '请先配置后端服务', icon: 'none' }); return }
      this.setData({ approvalSubmitting: true })
      try {
        await requestApprovalSubscription()
        const imagePath = this.data.uploadedImage as string
        const image = this.data.uploadedImageSource || (imagePath ? await uploadApprovalImage(imagePath) : '')
        const item = await createApproval({
          authorName: form.isAnonymous ? '' : form.authorName.trim(),
          authorAvatar: form.isAnonymous ? '' : form.authorAvatar,
          isAnonymous: form.isAnonymous,
          title: form.foodName.trim(),
          ...(price ? { price: Number(price) } : {}),
          ...(form.calorie.trim() ? { calorie: Number(form.calorie) } : {}),
          reason: form.reason.trim(),
          alternative: form.alternative.trim(),
          intake: form.intake.trim(),
          image,
        })
        const approval = this.mapApiApproval({ ...item, authorAvatar: form.isAnonymous ? '' : this.data.avatarPreview, image: imagePath || item.image }, true)
        const approvals = [approval, ...(this.data.approvals as Approval[])]
        const createdRecord: MyRecord = { id: approval.id, isApproval: true, foodRecorded: false, title: approval.title, time: approval.time, calorie: approval.calorie, status: approval.status, statusLabel: approval.statusLabel, checkinResult: '' }
        this.setData({ approvals, filteredApprovals: this.filterApprovals(approvals, this.data.activeFilter as FilterKey), form: blankForm(), uploadedImage: '', uploadedImageSource: '', foodSuggestions: [], foodMatchHint: '', selectedFoodId: '', selectedFood: null, portionOptions: [], portionIndex: 0, calorieHint: '', calorieSource: 'manual' as CalorieSource, activeTab: 'square' as TabKey, formFocusAnchor: '', keyboardHeight: 0, pageScrollStyle: '' })
        this.applySavedRecord(createdRecord)
        await this.loadData()
        if (!(this.data.myRecords as MyRecord[]).some(record => record.id === createdRecord.id)) this.applySavedRecord(createdRecord)
        if (!(this.data.approvals as Approval[]).some(item => item.id === approval.id)) {
          const refreshedApprovals = [approval, ...(this.data.approvals as Approval[])]
          this.setData({ approvals: refreshedApprovals, filteredApprovals: this.filterApprovals(refreshedApprovals, this.data.activeFilter as FilterKey) })
        }
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
      this.setData({ recordApprovalId: '', form: blankForm(), uploadedImage: '', uploadedImageSource: '', foodSuggestions: [], foodMatchHint: '', selectedFoodId: '', selectedFood: null, portionOptions: [], portionIndex: 0, calorieHint: '', calorieSource: 'manual' as CalorieSource })
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
        const image = this.data.uploadedImageSource || (imagePath ? await uploadApprovalImage(imagePath) : '')
        const approvalId = this.data.recordApprovalId
        const saved = approvalId
          ? await submitApprovalFood(approvalId, { title: foodName, ...(calorie ? { calorie: Number(calorie) } : {}), image })
          : await createFoodRecord({ title: foodName, ...(calorie ? { calorie: Number(calorie) } : {}), image })
        const updated = mapApiRecord(saved)
        if (approvalId) {
          updated.isApproval = true
          updated.foodRecorded = true
          this.markApprovalFoodDecided(approvalId, 'eaten')
          // 旧服务只返回审批原记录；本次表单内容仍先用于当前页面展示，部署新服务后会持久化。
          updated.title = foodName
          updated.calorie = calorie || updated.calorie
        }
        this.applySavedRecord(updated)
        this.resetForm()
        this.setData({ activeTab: 'me' as TabKey, formFocusAnchor: '', keyboardHeight: 0, pageScrollStyle: '' })
        await this.loadData()
        this.applySavedRecord(updated)
        if (approvalId) this.markApprovalFoodDecided(approvalId, 'eaten')
        wx.showToast({ title: '已添加到今日记录', icon: 'success' })
      } catch (error) {
        console.warn('save food record failed', error)
        wx.showToast({ title: error instanceof Error ? error.message : '保存失败，请稍后重试', icon: 'none' })
      } finally {
        this.setData({ recordSubmitting: false })
      }
    },
    async checkIn(e: any) {
      if (this.data.recordActionId) return
      const result = e.currentTarget.dataset.result as '真香' | '后悔'
      const id = String(e.currentTarget.dataset.id || '')
      this.setData({ recordActionId: id })
      try {
        const updated = mapApiRecord(await submitCheckIn(id, result))
        this.applySavedRecord(updated)
        this.markApprovalFoodDecided(id, result === '真香' ? 'eaten' : 'skipped')
        await this.loadData()
        this.applySavedRecord(updated)
        this.markApprovalFoodDecided(id, result === '真香' ? 'eaten' : 'skipped')
        wx.showToast({ title: `已记录：${result}`, icon: 'success' })
      } catch (error) {
        console.warn('check in failed', error)
        wx.showToast({ title: error instanceof Error ? error.message : '打卡失败，请稍后重试', icon: 'none' })
      } finally {
        this.setData({ recordActionId: '' })
      }
    },
  },
})
