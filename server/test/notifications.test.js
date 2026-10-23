const test = require('node:test')
const assert = require('node:assert/strict')
const { WechatSubscribeMessenger, createNotifier } = require('../src/notifications')

test('subscription sender gets and reuses an access token and sends configured template fields', async () => {
  const requests = []
  const messenger = new WechatSubscribeMessenger({
    appId: 'app-id',
    appSecret: 'app-secret',
    templateId: 'template-id',
    fields: { title: 'thing1', status: 'phrase2', detail: 'thing3' },
    request: async (url, options) => {
      requests.push({ url, options })
      return {
        ok: true,
        async json() {
          return url.includes('/token?') ? { access_token: 'token-1', expires_in: 7200 } : { errcode: 0 }
        },
      }
    },
  })

  const result = await messenger.sendApprovalUpdate({
    openid: 'owner-1',
    approval: { _id: 'approval-1', title: '烤冷面', status: 'approved' },
    choice: 'approve',
    reason: '今天运动过了',
  })

  assert.deepEqual(result, { sent: true })
  assert.equal(requests.length, 2)
  assert.match(requests[1].url, /subscribe\/send\?access_token=token-1$/)
  const sent = JSON.parse(requests[1].options.body)
  assert.equal(sent.touser, 'owner-1')
  assert.equal(sent.template_id, 'template-id')
  assert.equal(sent.page, 'pages/index/index')
  assert.deepEqual(sent.data, {
    thing1: { value: '烤冷面' },
    phrase2: { value: '已通过' },
    thing3: { value: '支持这顿饭：今天运动过了' },
  })

  await messenger.sendApprovalUpdate({
    openid: 'owner-2', approval: { _id: 'approval-2', title: '豆花', status: 'rejected' }, choice: 'wait', reason: '先吃正餐',
  })
  assert.equal(requests.length, 3, 'cached token should avoid a second token request')
})

test('notifier reports disabled when required WeChat credentials are missing', async () => {
  const notifier = createNotifier({ appId: 'app-id', appSecret: '', templateId: 'template-id' })
  assert.deepEqual(await notifier.sendApprovalUpdate({}), { sent: false, reason: 'not_configured' })
})

test('WeChat API errors are surfaced to the caller', async () => {
  const messenger = new WechatSubscribeMessenger({
    appId: 'app-id', appSecret: 'app-secret', templateId: 'template-id',
    request: async url => ({
      ok: true,
      async json() { return url.includes('/token?') ? { access_token: 'token-1', expires_in: 7200 } : { errcode: 43101, errmsg: '用户拒绝接收消息' } },
    }),
  })
  await assert.rejects(
    () => messenger.sendApprovalUpdate({ openid: 'owner-1', approval: { title: '豆花', status: 'approved' }, choice: 'approve', reason: '可以' }),
    /用户拒绝接收消息/,
  )
})
