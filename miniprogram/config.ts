// 在微信公众平台创建订阅消息模板后填入模板 ID。
export const APPROVAL_SUBSCRIBE_TEMPLATE_ID = ''

// 填入 CloudBase 环境 ID 和云托管服务名后，广场读写会切换到真实后端。
export const CLOUDBASE_ENV_ID = ''
export const CLOUD_SERVICE_NAME = ''

export function requestApprovalSubscription(): Promise<boolean> {
  if (!APPROVAL_SUBSCRIBE_TEMPLATE_ID) return Promise.resolve(false)
  return new Promise(resolve => {
    wx.requestSubscribeMessage({
      tmplIds: [APPROVAL_SUBSCRIBE_TEMPLATE_ID],
      success: result => resolve(result[APPROVAL_SUBSCRIBE_TEMPLATE_ID] === 'accept'),
      fail: error => {
        console.warn('requestSubscribeMessage failed', error)
        resolve(false)
      },
    })
  })
}
