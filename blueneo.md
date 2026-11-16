# BlueNeo Cloud 账号信息

来源：https://www.blueneo.cloud/dashboard/overview（抓取日期 2026-11-10 前后）

## 接入

- Base URL：`https://llm-api.blueneo.cloud`
- 端点：OpenAI 兼容 `/v1/chat/completions`
- API Key：`sk-3c180••••••••••••2fa4`（页面脱敏，仅前缀 `sk-3c180` + 后缀 `2fa4`；完整值需去「API 密钥」页取）
- 同一把密钥通用，模型任选，见「模型中心」

curl 示例：

```bash
curl https://llm-api.blueneo.cloud/v1/chat/completions \
  -H "Authorization: Bearer $BLUENEO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "Kimi K2.7 Code", "messages": [{"role": "user", "content": "Hello!"}]}'
```

## 额度

| 来源 | 状态 | 已用 | 总额 |
| --- | --- | --- | --- |
| Tokens Plan（Flux，月付） | 启用 | 0.01 | 20,000 |
| 加量包 | 停用 | 286.03 | 26,000 |
| 算能包 | 停用 | 0 | 1,200 |

- 仅 Tokens Plan 计入可用额度；停用来源不参与新请求，仍可兜底扣减
- Tokens Plan：下次重置 / 订阅失效 `2026-11-25 16:19:32`
- 加量包 4 个生效中：
  - BIG CHECKIN — 剩 5,000，到期 2026-11-17 09:13:21
  - App内测用户包-1 — 剩 20,000，到期 2099-12-31 22:01:51
  - SMALL CHECKIN — 剩 500，到期 2026-11-16 09:19:16
  - （第 4 个未展开，需点「查看全部」）
- 算能包：累计获得 1,200，累计消耗 0，最近更新 2026-11-10 00:02:02

## 导航栏

概览 / API 密钥 / 用量统计 / 用量明细 / 模型中心 / 订阅空间 / AI 工坊 / 邀请中心 / 每日签到 / 用户中心 / 系统通知 / 帮助与支持 / 订阅总览 / 我的订阅 / 快速开始

## 待补

- 完整 API key（API 密钥页）
- 模型列表（模型中心）
- 加量包第 4 项
- 用量明细