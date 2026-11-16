# AGENTS.md

## 这是什么

magpie / OpenCode 的**供应商插件**：把 BlueNeo Cloud 接进 magpie，负责登录（账号密码或 web 会话 token）、读额度、每日签到、列模型。

- 单文件、零依赖、纯 ESM（`index.mjs`，约 440 行）。插件宿主是 **Bun**（首次添加插件时 magpie 自己下载），Node 也能跑测试。
- `package.json` 的 `name` 是 `opencode-blueneo-auth`（发布名），目录名/仓库名是 `magpie-blueneo`。应用里显示的 BlueNeo 名称来自 `package.json` 的 `magpie` 字段。
- `blueneo.md` 是从 BlueNeo 控制台抓下来的接口/额度笔记，**不是代码**，改查接口时先看它。
- 本目录**不是 git 仓库**（`git status` 会报错），不要假设有 git 历史可查。

## 契约以官方文档为准

**https://usemagpie.ai/docs/zh/plugins** ——`auth`/`config`/`provider`/`chat.headers` 是 OpenCode 的，`auth.usage`/`auth.refresh`/`auth.checkin`/`magpie` 字段是 magpie 加的（OpenCode 会忽略，所以一个包能同时服务两边）。改钩子签名或返回值前先对照这一页，别从本文件反推。

## 命令

```bash
node index.test.mjs        # 跑测试（推荐，输出干净）
bun test                   # 同一批测试；退出码正确，但汇总行会写 "0 pass 0 fail"，别信汇总，看每行 ok/FAIL
magpie plugin add ./       # 装到本机，文件夹就地加载
magpie plugin login blueneo
magpie plugin logout blueneo
magpie provider test blueneo            # 每种 API 发一个很小的请求
magpie quota blueneo                    # usage 钩子的输出
```

没有 lint / build / CI。改完 `node index.test.mjs` 全绿是唯一硬门槛。

**在沙箱里试**，别碰自己真在用的 magpie（登录信息、插件都在里面）：

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add ./ && m plugin --json      # 方式、账号、模型、加载错误
m plugin login blueneo && m provider test blueneo && m quota
```

## 代码地图（index.mjs）

| 行 | 内容 |
| --- | --- |
| 1-7 | `PROVIDER` / `BASE`（推理网关）/ `DASH`（控制台）/ `BEIJING` / `VARIANTS` |
| 10-25 | `modelEntries`：为网关返回的任意型号补齐 API、推理与工具能力、六档思考 |
| 27-32 | `title`、`num`、`fmt` |
| 38 | `api(session, path, init, ms)`：控制台接口唯一出口，带 Bearer JWT 和超时 |
| 53-63 | `iso`、`spanSec`：把无时区时间当北京时间 |
| 66-102 | `groupPacks`、`packSummary`、`usedPct`：加量包合并与百分比 |
| 104-136 | `jwtExp`、`login`：账号密码登录，JWT 只当过期时间来源 |
| 139-158 | `pickKey`、`creds`、`catalog` |
| 162 | `readUsage`：并发读 5 个接口，逐个兜住错误，产出 windows |
| 256 | `BlueNeoAuthPlugin`：插件工厂（导出为 named + default） |
| 442 | `_internal`：测试用的纯函数导出 |

`BlueNeoAuthPlugin({ client })` 返回的钩子：

```js
{
  config,                       // 注入默认 provider（npm: @ai-sdk/openai → /responses；models 为空，登录后动态发现）
  auth: {
    provider, refreshLead,
    methods: [ {type:"oauth", prompts, authorize}, {type:"api", prompts, authorize} ],
    refresh(auth), loader(getAuth), usage(getAuth), checkin(getAuth),
  },
  provider: { id, models(provider, {auth}) },
}
```

## 不能改坏的契约

- **入口模块导出的每个函数都会被当作插件调用**。所以只能用 `export const BlueNeoAuthPlugin` + `export default`，辅助函数一律经 `_internal` 对象导出（`export const _internal = {…}` 是一整个对象，不算函数）。加一个裸 `export const foo = () => {}` 会让它被当插件跑。
- 不要从入口文件导出 `client.auth.set` 之类的副作用工具；需要按账号存状态就按拿到的 `auth` 存，别放模块级变量（所有账号共享同一个宿主进程）。
- **oauth 的 `authorize` 必须先返回一个 flow**（`url?` + `instructions` + `method` + `callback()`），不能直接返回 success。magpie 不接受。
- `usage` 的窗口字段：`name` / `used`（百分比）/ `amount` + `limit` + `unit`（数量）/ `resetsAt` / `span` / `runsOutAt` / `runsOut` / `aside` / `display`。给了 `amount`/`limit` 就别传 `used`，magpie 自己算百分比、自己排版；**唯一例外是一点没用过（amount 为 0）**，magpie 只保留非零数字、那行会空着，必须自己补 `display`。
- 厂商没给 `used` 就不要传，**不能用 0 表示"不知道"**。
- `aside: true` 的窗口照常显示，但路由不读它：用完不会让账号停用。真正会卡住账号的窗口不要设 `aside`。
- `usage` / `checkin` / `provider.models` 用 `throw Object.assign(new Error(...), { signIn: "expired" })` 表示会话失效；`usage` 也可以直接返回 `signIn: "expired"`。重新登录前 magpie 不再往这个账号发请求。
- 签到结局是枚举：`claimed` / `done` / `captcha` / `ineligible` / `inactive` / `failed`，签名 `checkin(getAuth, provider)`。**Geetest 一律 `captcha`，不在插件里解**，请用户去网页签。返回别的值或抛异常都算 `failed`（当天稍后重试）。
- `refresh(auth, provider)` 的返回值是**合并**进账号（不同于 `client.auth.set` 的整条替换），所以只返回 `access` / `expires` 不会丢掉存着的密码。带 `signIn: "expired"` 的错误会标记账号并停止重试。
- `provider.models` 出错必须回落 `provider.models`（让 magpie 保留旧列表），不要抛——抛的话 magpie 也会回退，但账号不会被标记，两者语义不同。
- `loader` 里 `apiKey` 由 AI SDK 按包的方式发（本项目是 `Authorization: Bearer`）；`baseURL` 优先于模型和供应商的 `api`。

## BlueNeo 上游坑

- **控制台接口一律 HTTP 200，成败看 body 的 `code` 字符串（`"200"`）**。别用 `res.ok` 判断控制台接口；只有推理网关 `/v1/models` 用 HTTP 状态码。
- 站点时间戳是北京时间且不带时区（`2026-11-25T16:19:32`），`iso()` 负责补 `+08:00`，已有 `Z`/偏移则保留。不要用 `new Date(s)` 直接解析。
- 金额是字符串，可能为 `"0E-8"`，一律走 `num()`。
- 接口会间歇性断连或拖到几十秒（`credit_plan/account`、`my_packs` 实测有）。`readUsage` 的做法是每个请求单独 `soft()` 兜住 + 重试一次；一个接口坏掉只少一张卡。单次 20s，`settle-switches` 只等 8s，读不到就当三个来源都开着。
- 加量包按 `sp_name` 合并，只看 `status === 1`（停用不参与路由）；`aside` 标记由 `settle-switches` 决定。
- 登录页的 Geetest 只在前端，`POST /api/auth/login` 服务端不校验；登录后从 `api_key/list` 取 key（优先描述含 `default`，否则最新）。
- 2FA 账号登不了，只能走「Web 会话 token」方法。

## 代码风格

- 无依赖、无构建：只用 Node/Bun 内置（`fetch`、`AbortSignal.timeout`、`Buffer`）。加依赖要先想清楚。
- 注释写**中文**，只写代码说不出来的 why（业务规则、上游怪癖）；不要解释 what。
- 纯函数放模块顶层并导出到 `_internal`，测试只测 `_internal`——不 mock fetch，不写网络测试。
- 新增非平凡逻辑（分支/解析/金额计算）就在 `index.test.mjs` 加一条 `t(...)`：自定义 `t()` 打 ok/FAIL 并设 `process.exitCode`，断言用 `eq()`。
- 模型名单只读 `/v1/models`，不内置型号列表、不按型号分支。`modelEntries` 为全部返回模型统一补齐六档；目录只补元数据，失败不阻断新模型；网关失败保留宿主已有列表。

## 已知技术债

- `usedPct`（第 102 行）只被测试引用，主代码不用它——magpie 现在自己按 `amount`/`limit` 算百分比。清理时连 `_internal` 导出和对应测试一起删。

## 安全

- 登录后 `plugin-auth.json`（magpie 配置目录，权限 600）存 **API key、web 会话 JWT、账号密码（续期用）、用户名**。不要把它复制进仓库、贴进 issue、或写进日志。
- 日志只写用户名和错误消息（`client.app.log`，service `blueneo`），绝不写 token / key / 密码。
- 插件发出的请求带的是用户的对话和工具结果：只发往 BlueNeo，不要记进日志。
- `blueneo.md` 里的 API key 已脱敏，保持脱敏；不要把完整 key 提交进这个文件。
