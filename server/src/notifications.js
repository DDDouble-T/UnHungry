const DEFAULT_PAGE = 'pages/index/index'
const ACCESS_TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/token'
const SEND_MESSAGE_URL = 'https://api.weixin.qq.com/cgi-bin/message/subscribe/send'
const STATUS_LABELS = { pending: '待审批', approved: '已通过', rejected: '先等等' }

function text(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

function defaultData({ approval, choice, reason, fields }) {
  const action = choice === 'approve' ? '支持这顿饭' : '建议先等等'
  return {
    [fields.title]: { value: text(approval.title, 20) },
    [fields.status]: { value: text(STATUS_LABELS[approval.status] || '待审批', 5) },
    [fields.detail]: { value: text(`${action}：${reason}`, 20) },
  }
}

class WechatSubscribeMessenger {
  constructor({
    appId = process.env.WECHAT_APP_ID,
    appSecret = process.env.WECHAT_APP_SECRET,
    templateId = process.env.WECHAT_SUBSCRIBE_TEMPLATE_ID,
    page = process.env.WECHAT_SUBSCRIBE_PAGE || DEFAULT_PAGE,
    fields = {
      title: process.env.WECHAT_SUBSCRIBE_TITLE_FIELD || 'thing1',
      status: process.env.WECHAT_SUBSCRIBE_STATUS_FIELD || 'phrase2',
      detail: process.env.WECHAT_SUBSCRIBE_DETAIL_FIELD || 'thing3',
    },
    request = globalThis.fetch,
    logger = console,
  } = {}) {
    this.appId = appId
    this.appSecret = appSecret
    this.templateId = templateId
    this.page = page
    this.fields = fields
    this.request = request
    this.logger = logger
    this.accessToken = null
    this.accessTokenExpiresAt = 0
  }

  get enabled() {
    return Boolean(this.appId && this.appSecret && this.templateId && this.request)
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) return this.accessToken
    const query = new URLSearchParams({ grant_type: 'client_credential', appid: this.appId, secret: this.appSecret })
    const response = await this.request(`${ACCESS_TOKEN_URL}?${query}`, { method: 'GET' })
    const body = await response.json()
    if (!response.ok || body.errcode || !body.access_token) {
      throw new Error(`获取微信 access_token 失败：${body.errmsg || response.status}`)
    }
    this.accessToken = body.access_token
    this.accessTokenExpiresAt = Date.now() + Math.max(0, Number(body.expires_in || 7200) - 60) * 1000
    return this.accessToken
  }

  async sendApprovalUpdate({ openid, approval, choice, reason }) {
    if (!this.enabled || !openid || !approval) return { sent: false, reason: 'not_configured' }
    const accessToken = await this.getAccessToken()
    const response = await this.request(`${SEND_MESSAGE_URL}?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        touser: openid,
        template_id: this.templateId,
        page: this.page,
        miniprogram_state: process.env.NODE_ENV === 'production' ? 'formal' : 'trial',
        lang: 'zh_CN',
        data: defaultData({ approval, choice, reason, fields: this.fields }),
      }),
    })
    const body = await response.json()
    if (!response.ok || body.errcode) {
      throw new Error(`发送微信订阅消息失败：${body.errmsg || response.status}`)
    }
    return { sent: true }
  }
}

function createNotifier(options) {
  const messenger = new WechatSubscribeMessenger(options)
  return {
    sendApprovalUpdate(payload) {
      if (!messenger.enabled) return Promise.resolve({ sent: false, reason: 'not_configured' })
      return messenger.sendApprovalUpdate(payload)
    },
  }
}

module.exports = { WechatSubscribeMessenger, createNotifier, defaultData }
