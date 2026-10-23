# UnHungry 后端接口文档

本文档以 `server/src/app.js`、`server/src/validation.js` 和 `server/src/repository.js` 的当前实现为准。

## 1. 后端控制范围

后端是业务规则和持久化数据的最终来源，当前负责：

- 审批单的创建、查询、状态筛选和展示字段组装。
- 投票的选项校验、理由必填、同一用户重复投票拦截，以及审批状态计算。
- 审批状态变化后，发起人的个人记录同步变化。
- 当前用户的审批记录和统计数据。
- 只有审批通过的记录才允许打卡，且打卡结果只能是 `真香` 或 `后悔`。
- 请求身份识别、参数校验、错误码和请求追踪 ID。

后端当前不负责：

- 食物热量推荐。小程序目前从 `miniprogram/data/foods.js` 本地读取。
- 图片上传。接口只保存已经上传完成的云文件 ID 或 URL 字符串。
- 个人饮食记录（不关联审批单）的新增接口。当前页面的“添加今日已吃食物”仍只写前端内存。
- 亲友群、支付、内容审核和管理员后台。

投票 API 会在成功写入后尝试向审批发起人发送一次小程序订阅消息。发起人需在小程序端接受对应模板的一次性订阅；未配置微信凭据或消息发送失败不会影响投票结果。小程序页面当前仍使用本地演示状态，尚未调用这些业务 API，因此生产通知还需要先完成页面 API 接入。

> 广场示例审批只保存在小程序前端，不写入后端。后端接口返回的审批均为真实用户提交的数据。

## 2. 通用约定

- 默认地址：`http://localhost:3000`。
- 所有 JSON 成功响应：`{ "data": ... }`。
- 所有 JSON 失败响应：`{ "error": { "code": "...", "message": "...", "details": {} } }`。
- 请求头：`Content-Type: application/json`。
- 生产环境由 CloudBase 云托管注入 `x-wx-openid`。本地开发可使用 `x-dev-openid`；生产环境建议设置 `REQUIRE_OPENID=true`，未识别身份时返回 401。
- 每个响应都会带 `x-request-id`。客户端报错时应记录它，便于服务端排查。
- 后端生成的 `id` 是字符串 UUID；前端目前的类型仍写成 `number`，接入时需要改成 `string`。

## 3. 接口列表

| 方法 | 路径 | 是否需要用户身份 | 作用 |
| --- | --- | --- | --- |
| GET | `/health` | 否 | 容器健康检查 |
| GET | `/api/v1` | 否 | 查看 API 版本和入口 |
| GET | `/api/v1/approvals` | 否 | 查询审批广场 |
| GET | `/api/v1/approvals/:approvalId` | 否 | 查询一张审批单 |
| POST | `/api/v1/approvals` | 是 | 创建审批单，并创建发起人的个人记录 |
| POST | `/api/v1/approvals/:approvalId/votes` | 是 | 对待审批单投票 |
| GET | `/api/v1/me/records` | 是 | 查询当前用户的审批记录 |
| GET | `/api/v1/me/stats` | 是 | 查询当前用户统计 |
| POST | `/api/v1/me/records/:approvalId/checkin` | 是 | 对已通过的审批记录打卡 |

### 3.1 健康和版本

`GET /health`

返回服务状态、当前存储模式（`memory` 或 `cloudbase`）和服务时间。

`GET /api/v1`

返回 API 名称、版本和业务入口列表。

### 3.2 查询审批广场

`GET /api/v1/approvals?status=all&limit=50`

查询参数：

| 参数 | 类型 | 默认值 | 规则 |
| --- | --- | --- | --- |
| `status` | string | `all` | `all`、`pending`、`approved`、`rejected` |
| `limit` | integer | `50` | 1 到 100 |

返回 `data` 数组。每项字段：`id`、`status`、`statusLabel`、`title`、`price`、`calorie`、`reason`、`alternative`、`intake`、`image`、`createdAt`、`support`、`against`、`totalVotes`、`supportRate`、`tags`、`emoji`。

`GET /api/v1/approvals/:approvalId` 返回同样的审批单对象。不存在时返回 `404 NOT_FOUND`。

### 3.3 创建审批单

`POST /api/v1/approvals`

请求体：

```json
{
  "title": "烤冷面",
  "price": 15,
  "calorie": 420,
  "reason": "今天辛苦了",
  "alternative": "鸡蛋蔬菜卷",
  "intake": "午餐吃了沙拉",
  "image": "cloud://..."
}
```

字段规则：

| 字段 | 必填 | 类型和限制 |
| --- | --- | --- |
| `title`（或 `foodName`） | 是 | 字符串，最多 40 字符 |
| `price` | 否 | 0 到 100000 的数字 |
| `calorie` | 否 | 0 到 10000 的数字，缺省为 `null` |
| `reason` | 是 | 字符串，最多 200 字符 |
| `alternative` | 否 | 字符串，最多 100 字符 |
| `intake` | 否 | 字符串，最多 100 字符 |
| `image` | 否 | 字符串，最多 2048 字符 |

成功返回 `201` 和初始状态为 `pending` 的审批单。后端同时创建一条属于当前用户的 `user_records` 记录。

### 3.4 投票

`POST /api/v1/approvals/:approvalId/votes`

请求体：

```json
{ "choice": "approve", "reason": "今天运动量够，偶尔吃一次没关系" }
```

`choice` 只能是：

- `approve`：支持吃，`support + 1`。
- `wait`：建议等等，`against + 1`。

`reason` 必填，最多 200 字符。同一 `approvalId + 用户身份` 只能投一次；审批单不是 `pending` 时不能继续投票。

状态计算规则：

```text
supportRate = round(support / (support + against) * 100)
supportRate >= 50        => approved
against > support        => rejected
其他                      => pending
```

状态变成 `approved` 或 `rejected` 后，发起人的 `user_records.status` 会同步更新。成功返回 `201` 和更新后的审批单。

### 3.5 我的记录和统计

`GET /api/v1/me/records`

只返回当前身份创建的记录，按 `createdAt` 倒序。字段为：`id`（审批单 ID）、`recordId`、`title`、`time`、`calorie`、`status`、`statusLabel`、`checkinResult`。

`GET /api/v1/me/stats`

返回：

```json
{
  "submittedCount": 1,
  "approvedCount": 1,
  "approvalRate": 100,
  "todayCalories": 420,
  "calorieQuota": 1600,
  "savedCalories": 0,
  "topRejected": ""
}
```

统计只基于当前用户的审批记录：通过率按已提交记录计算，今日热量按当天记录的 `calorie` 求和，被拒绝最多按被拒绝记录的食物名称统计。

### 3.6 审批后打卡

`POST /api/v1/me/records/:approvalId/checkin`

请求体：

```json
{ "result": "真香" }
```

`result` 只能是 `真香` 或 `后悔`。记录不存在返回 `404 NOT_FOUND`，审批未通过返回 `409 CHECKIN_NOT_ALLOWED`。成功返回更新后的记录。

## 4. 错误码

| HTTP | code | 触发条件 |
| --- | --- | --- |
| 400 | `INVALID_BODY` | 请求体不是 JSON 对象 |
| 400 | `INVALID_FIELD` | 字段缺失、类型错误或超出范围 |
| 400 | `INVALID_ID` | 路径 ID 格式错误 |
| 400 | `INVALID_CHOICE` | 投票选项不是 `approve` 或 `wait` |
| 400 | `INVALID_RESULT` | 打卡结果不合法 |
| 400 | `INVALID_STATUS` / `INVALID_LIMIT` | 查询参数不合法 |
| 400 | `INVALID_JSON` | 请求体不是合法 JSON |
| 401 | `AUTH_REQUIRED` | 生产环境没有用户身份 |
| 404 | `NOT_FOUND` | 路由或审批/记录不存在 |
| 409 | `DUPLICATE_VOTE` | 当前用户已经投过该审批单 |
| 409 | `APPROVAL_CLOSED` | 审批单已经结束 |
| 409 | `CHECKIN_NOT_ALLOWED` | 审批未通过，不能打卡 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超过 64KB |

## 5. 数据集合和部署控制项

CloudBase 使用三个集合：

- `approvals`：审批单主体、状态和投票汇总。
- `approval_votes`：单次投票；文档 ID 为 `审批单 ID:用户 openid`，用于防重复投票。
- `user_records`：发起人的个人审批记录和打卡结果。

生产至少配置：`TCB_ENV_ID`（或 `CLOUDBASE_ENV_ID`）、`NODE_ENV=production`、`REQUIRE_OPENID=true`。启用订阅消息还需配置 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`WECHAT_SUBSCRIBE_TEMPLATE_ID`。模板数据字段默认使用 `thing1`、`phrase2`、`thing3`，须按公众平台实际模板配置 `WECHAT_SUBSCRIBE_TITLE_FIELD`、`WECHAT_SUBSCRIBE_STATUS_FIELD`、`WECHAT_SUBSCRIBE_DETAIL_FIELD`。建议建立索引：

- `approvals`: `status + createdAt`
- `user_records`: `_openid + createdAt`、`approvalId + _openid`
- `approval_votes`: `_id`

