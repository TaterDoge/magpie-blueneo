import { _internal } from "./index.mjs"

const t = (name, fn) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`)
    process.exitCode = 1
  }
}

const eq = (a, b) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`)
}

t("北京时间补时区", () => eq(_internal.iso("2026-11-25T16:19:32"), "2026-11-25T08:19:32.000Z"))
t("iso 保留已有偏移", () => eq(_internal.iso("2026-11-25T16:19:32Z"), "2026-11-25T16:19:32.000Z"))
t("金额字符串 0E-8", () => eq(_internal.num("0E-8"), 0))
t("已用百分比", () => eq(_internal.usedPct(500, 1000), 50))
t("总额为 0 不给 used", () => eq(_internal.usedPct(0, 0), undefined))

t("加量包同名合并、取最早到期、跳过停用", () => {
  const g = _internal.groupPacks([
    { sp_name: "SMALL CHECKIN", balance_amount: "500", total_amount: "500", end_time: "2026-11-16T09:19:16", status: 1 },
    { sp_name: "SMALL CHECKIN", balance_amount: "213.97", total_amount: "500", end_time: "2026-11-15T13:42:51", status: 1 },
    { sp_name: "SMALL CHECKIN", balance_amount: "0E-8", total_amount: "500", end_time: "2026-11-14T09:07:19", status: 2 },
    { sp_name: "BIG CHECKIN", balance_amount: "5000", total_amount: "5000", end_time: "2026-11-17T09:13:21", status: 1 },
  ])
  eq(g.map((x) => x.name), ["SMALL CHECKIN", "BIG CHECKIN"])
  eq(g[0].balance, 713.97)
  eq(g[0].count, 2)
  eq(g[0].end, "2026-11-15T05:42:51.000Z")
})

t("窗口跨度按周期算", () => eq(_internal.spanSec("2026-10-26T16:19:32", "2026-11-25T16:19:32"), 30 * 24 * 3600))

t("思考档位六档全开放", () =>
  eq(_internal.VARIANTS, { none: {}, low: {}, medium: {}, high: {}, xhigh: {}, max: {} }))

t("任意新型号无需预置就带 API、推理能力和六档", () => {
  const ids = ["unseen-family-v99", "brand-new-model"]
  const models = _internal.modelEntries(ids, {}, new Map())
  eq(Object.keys(models), ids)
  for (const id of ids) {
    eq(models[id].id, id)
    eq(models[id].api, { id, url: "https://llm-api.blueneo.cloud/v1", npm: "@ai-sdk/openai" })
    eq(models[id].capabilities, { reasoning: true, toolcall: true })
    eq(Object.keys(models[id].variants), ["none", "low", "medium", "high", "xhigh", "max"])
    eq(models[id].limit, undefined)
  }
  eq(models["brand-new-model"].name, "Brand NEW Model")
})

t("动态列表只用网关清单，并保留旧模型的其他元数据", () => {
  const base = {
    name: "Cached Name",
    api: { id: "upstream-id", url: "https://llm-api.blueneo.cloud/custom/v1", npm: "@ai-sdk/openai-compatible" },
    capabilities: { reasoning: false, toolcall: false, input: { text: true, image: true } },
    variants: { high: {} },
    limit: { context: 128000, output: 64000 },
  }
  const cat = new Map([["new-model", { display_name: "New Model", context_window_size: "1000" }]])
  const models = _internal.modelEntries(["new-model"], { "new-model": base, "not-in-gateway": {} }, cat)
  const m = models["new-model"]
  eq(Object.keys(models), ["new-model"])
  eq(m.name, "New Model")
  eq(m.api, base.api)
  eq(m.capabilities, { reasoning: true, toolcall: true, input: { text: true, image: true } })
  eq(Object.keys(m.variants), ["none", "low", "medium", "high", "xhigh", "max"])
  eq(m.limit, { context: 1000000, output: 64000 })
  eq(base.capabilities.reasoning, false)
  eq(base.limit.context, 128000)
  eq(Object.keys(base.variants), ["high"])
})

t("缺少目录或上下文无效时保留旧名称与限制", () => {
  const base = { name: "Custom Name", limit: { context: 32000, output: 64000 } }
  const catalogs = [new Map(), ...[undefined, "0", "bad", "-1"].map((context_window_size) =>
    new Map([["new-model", { context_window_size }]]))]
  for (const cat of catalogs) {
    const m = _internal.modelEntries(["new-model"], { "new-model": base }, cat)["new-model"]
    eq(m.name, "Custom Name")
    eq(m.limit, { context: 32000, output: 64000 })
  }
})

// JWT 里只有 exp，取不到就当作不会过期
const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`
t("从 JWT 取过期时间", () => eq(_internal.jwtExp(jwt({ exp: 1794879802 })), 1794879802000))
t("坏 JWT 给 0", () => eq(_internal.jwtExp("nope"), 0))

t("两种登录方式的凭据统一", () => {
  eq(_internal.creds({ type: "oauth", access: "J", apiKey: "K" }), { key: "K", session: "J" })
  eq(_internal.creds({ type: "api", key: "K", metadata: { session: "J" } }), { key: "K", session: "J" })
  eq(_internal.creds({ type: "api", key: "K", metadata: undefined }), { key: "K", session: undefined })
  eq(_internal.creds(undefined), { key: undefined, session: undefined })
})
t("概览页的加量包是生效中包的合计", () => {
  // 实测概览：286.03 / 26,000，4 个生效中
  const s = _internal.packSummary([
    { sp_name: "BIG CHECKIN", balance_amount: "5000", total_amount: "5000", end_time: "2026-11-17T09:13:21", status: 1 },
    { sp_name: "App内测用户包-1", balance_amount: "20000", total_amount: "20000", end_time: "2099-12-31T22:01:51", status: 1 },
    { sp_name: "SMALL CHECKIN", balance_amount: "500", total_amount: "500", end_time: "2026-11-16T09:19:16", status: 1 },
    { sp_name: "SMALL CHECKIN", balance_amount: "213.96997", total_amount: "500", end_time: "2026-11-15T13:42:51", status: 1 },
    { sp_name: "SMALL CHECKIN", balance_amount: "0E-8", total_amount: "500", end_time: "2026-11-14T09:07:19", status: 2 },
  ])
  eq(s.total, 26000)
  eq(Math.round(s.used * 100) / 100, 286.03)
  eq(Math.round(s.left * 100) / 100, 25713.97)
  eq(s.count, 4)
  eq(s.runsOutAt, "2026-11-15T05:42:51.000Z")
  eq(Math.round(s.runsOut * 100) / 100, 213.97)
})
