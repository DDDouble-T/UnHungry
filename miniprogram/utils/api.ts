import { CLOUDBASE_ENV_ID, CLOUD_SERVICE_NAME } from '../config'

export interface ApiApproval {
  id: string
  authorName: string
  authorAvatar: string
  isAnonymous: boolean
  status: 'pending' | 'approved' | 'rejected'
  title: string
  price: number | null
  calorie: number | null
  reason: string
  alternative: string
  intake: string
  image: string
  createdAt: string
  support: number
  against: number
  totalVotes: number
  supportRate: number
  tags: string[]
  emoji: string
}

export interface ApiFood {
  id: string
  name: string
  aliases: string[]
  calorieRange: [number, number]
  defaultPortion: string
  portions: Array<{ label: string; calorie: number }>
  per100g?: number
  source?: string
  category?: string
}

export interface ApiRecord {
  id: string
  recordId?: string
  foodRecorded?: boolean
  title: string
  time: string
  calorie: number | null
  status: 'pending' | 'approved' | 'rejected' | 'logged'
  statusLabel: string
  checkinResult: string
}

export interface ApiStats {
  submittedCount: number
  approvedCount: number
  approvalRate: number
  todayCalories: number
  calorieQuota: number
  savedCalories: number
  topRejected: string
}

export interface ApiApprovalMessage {
  id: string
  text: string
  createdAt: string
}

interface ApiResponse<T> {
  data?: T
  error?: { message?: string }
}

interface ContainerOptions {
  config: { env: string }
  path: string
  method: 'GET' | 'POST'
  header: Record<string, string>
  data?: Record<string, unknown>
}

interface ContainerResult {
  statusCode: number
  data: ApiResponse<unknown> | string
}

type ContainerClient = {
  callContainer(options: ContainerOptions): Promise<ContainerResult>
}

export function isApiConfigured() {
  return Boolean(CLOUDBASE_ENV_ID && CLOUD_SERVICE_NAME)
}

async function request<T>(path: string, method: 'GET' | 'POST' = 'GET', data?: Record<string, unknown>): Promise<T> {
  if (!isApiConfigured()) throw new Error('尚未配置 CloudBase 云托管')

  // typings 版本尚未声明 callContainer；运行时由微信小程序 CloudBase SDK 提供。
  const cloud = wx.cloud as unknown as ContainerClient
  if (typeof cloud.callContainer !== 'function') throw new Error('当前微信基础库不支持云托管调用')
  const response = await cloud.callContainer({
    config: { env: CLOUDBASE_ENV_ID },
    path,
    method,
    header: { 'X-WX-SERVICE': CLOUD_SERVICE_NAME },
    ...(data ? { data } : {}),
  })
  const body = typeof response.data === 'string' ? JSON.parse(response.data) as ApiResponse<T> : response.data as ApiResponse<T>
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(body.error && body.error.message ? body.error.message : '服务暂时不可用')
  }
  if (!('data' in body)) throw new Error('服务返回的数据格式不正确')
  return body.data as T
}

export function fetchApprovals() {
  return request<ApiApproval[]>('/api/v1/approvals?status=all&limit=100')
}

export function fetchApproval(approvalId: string) {
  return request<ApiApproval>(`/api/v1/approvals/${encodeURIComponent(approvalId)}`)
}

export function fetchFoods(keyword: string) {
  return request<ApiFood[]>(`/api/v1/foods?keyword=${encodeURIComponent(keyword)}&limit=5`)
}

export function createApproval(input: {
  authorName: string
  authorAvatar: string
  isAnonymous: boolean
  title: string
  price?: number
  calorie?: number
  reason: string
  alternative: string
  intake: string
  image: string
}) {
  return request<ApiApproval>('/api/v1/approvals', 'POST', input)
}

export function createApprovalVote(approvalId: string, input: { choice: 'approve' | 'wait'; reason: string }) {
  return request<ApiApproval>(`/api/v1/approvals/${encodeURIComponent(approvalId)}/votes`, 'POST', input)
}

export function fetchRecords() {
  return request<ApiRecord[]>('/api/v1/me/records')
}

export function fetchStats() {
  return request<ApiStats>('/api/v1/me/stats')
}

export function fetchApprovalMessages() {
  return request<ApiApprovalMessage[]>('/api/v1/me/approval-messages?limit=10')
}

export function createFoodRecord(input: { title: string; calorie?: number; image?: string; approvalId?: string }) {
  return request<ApiRecord>('/api/v1/me/records', 'POST', input)
}

export async function recordApprovalFood(approvalId: string, input: { title: string; calorie?: number; image?: string }) {
  try {
    return await request<ApiRecord>(`/api/v1/me/records/${encodeURIComponent(approvalId)}/food`, 'POST', input)
  } catch (error) {
    // 兼容尚未部署新路由的旧云托管版本：打卡原审批，避免退回新增记录接口造成重复行。
    if (error instanceof Error && error.message === '接口不存在') return checkIn(approvalId, '真香')
    throw error
  }
}

export function checkIn(approvalId: string, result: '真香' | '后悔') {
  return request<ApiRecord>(`/api/v1/me/records/${encodeURIComponent(approvalId)}/checkin`, 'POST', { result })
}

export async function uploadApprovalImage(filePath: string) {
  const result = await wx.cloud.uploadFile({
    cloudPath: `approvals/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
    filePath,
  })
  return result.fileID
}

export async function uploadAuthorAvatar(filePath: string) {
  const result = await wx.cloud.uploadFile({
    cloudPath: `avatars/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
    filePath,
  })
  return result.fileID
}

export async function resolveImageUrls(images: string[]) {
  const fileIds = [...new Set(images.filter(image => image.startsWith('cloud://')))]
  if (!fileIds.length) return new Map<string, string>()
  const result = await wx.cloud.getTempFileURL({ fileList: fileIds })
  return new Map((result.fileList || []).map(file => [file.fileID, file.tempFileURL]))
}

export async function resolveApprovalImages(items: ApiApproval[]) {
  const urls = await resolveImageUrls(items.flatMap(item => [item.image || '', item.authorAvatar || '']))
  return items.map(item => ({ ...item, image: urls.get(item.image) || item.image, authorAvatar: urls.get(item.authorAvatar) || item.authorAvatar || '' }))
}
