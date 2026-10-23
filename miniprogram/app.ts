// app.ts
import { CLOUDBASE_ENV_ID } from './config'

App<IAppOption>({
  globalData: {},
  onLaunch() {
    if (CLOUDBASE_ENV_ID) {
      wx.cloud.init({ env: CLOUDBASE_ENV_ID, traceUser: true })
    }
    // 展示本地存储能力
    const logs = wx.getStorageSync('logs') || []
    logs.unshift(Date.now())
    wx.setStorageSync('logs', logs)
  },
})
