# UnHungry 云托管后端 MVP

这是“肚子请等等”小程序的 Node.js + Express 后端。服务可以直接作为云托管容器运行。生产建议使用 `DB_DRIVER=mysql` 连接云托管 MySQL；未设置该开关时使用保留的 CloudBase 数据库实现，本地没有数据库配置时使用内存仓储。

## 本地运行

```bash
cd server
npm install
npm test
npm start
```

默认监听 `http://localhost:3000`。本地请求可以用 `x-dev-openid` 区分用户：

```bash
curl -H 'x-dev-openid: user-a' http://localhost:3000/health
```

## API

完整字段、校验规则、状态计算、错误码和“后端控制范围”见 [API.md](./API.md)。

所有业务响应使用 `{ "data": ... }`，失败响应使用 `{ "error": { "code": ..., "message": ... } }`。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/health` | 容器健康检查 |
| `GET` | `/api/v1/approvals?status=all\|pending\|approved\|rejected` | 审批广场 |
| `GET` | `/api/v1/foods?keyword=鸡蛋` | 食物热量检索 |
| `GET` | `/api/v1/approvals/:approvalId` | 查看审批单 |
| `POST` | `/api/v1/approvals` | 创建审批单 |
| `POST` | `/api/v1/approvals/:approvalId/votes` | 投票，`choice` 为 `approve` 或 `wait` |
| `GET` | `/api/v1/me/records` | 当前用户的饮食记录 |
| `POST` | `/api/v1/me/records` | 新增独立饮食记录 |
| `GET` | `/api/v1/me/stats` | 当前用户统计 |
| `POST` | `/api/v1/me/records/:approvalId/checkin` | 审批通过后打卡，`result` 为 `真香` 或 `后悔` |

创建审批单示例：

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

CloudBase 云托管会把微信用户身份注入 `x-wx-openid`。生产建议设置 `REQUIRE_OPENID=true`，服务在没有身份时返回 401；本地开发使用 `x-dev-openid`。内存仓储默认空库；食物库随服务端镜像部署。

## CloudBase 部署

### 云托管 MySQL（当前默认方案）

1. 创建云托管 MySQL 数据库，并执行 `data/mysql-schema.sql`。已有数据库在部署本次服务前执行一次 `data/migrations/20261027-unified.sql`，补齐当前 schema 的字段并保留历史审批单的匿名状态。
2. 在服务环境变量中配置 `DB_DRIVER=mysql`、`MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_DATABASE`、`MYSQL_USER` 和 `MYSQL_PASSWORD`。
3. 保留 `NODE_ENV=production` 和 `REQUIRE_OPENID=true`。MySQL 模式不需要 `TCB_ENV_ID` 才能访问业务数据，但建议仍保留环境 ID供云调用和文件服务使用。

`@cloudbase/node-sdk` 仍保留在依赖中。将 `DB_DRIVER` 改回空值即可切回 CloudBase 仓储。

1. 在 CloudBase 环境中创建数据库，并为 `approvals`、`approval_votes`、`user_records` 创建集合。
2. 将 `server` 目录作为云托管服务目录，使用其中的 `Dockerfile` 构建，服务端口填 `3000`。
3. 配置环境变量 `TCB_ENV_ID`、`NODE_ENV=production`、`REQUIRE_OPENID=true`。
4. 如启用小程序订阅消息，再配置 `.env.example` 中的微信 AppID、AppSecret、模板 ID 和模板字段名；发起人须接受小程序中的一次性订阅授权。
5. 为数据库建立以下索引：
   - `approvals`: `status + createdAt`
   - `approval_votes`: `_id`（投票唯一键，值为 `审批单ID:用户openid`）
   - `user_records`: `_openid + createdAt`、`approvalId + _openid`
6. 在 `miniprogram/config.ts` 填入 CloudBase 环境 ID 和云托管服务名，小程序通过 `wx.cloud.callContainer` 调用服务并使用微信用户身份。

当前 MVP 只保存必要字段，图片字段保存小程序上传后的云文件 ID；支付、亲友群、内容审核和管理员能力留到后续版本。
