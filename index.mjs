const PROVIDER = "blueneo"
const BASE = "https://llm-api.blueneo.cloud/v1"
const DASH = "https://www.blueneo.cloud"
const BEIJING = "+08:00"

// 统一开放六档，不按型号筛选；上游实际执行的推理强度由网关决定。
const VARIANTS = Object.fromEntries(["none", "low", "medium", "high", "xhigh", "max"].map((v) => [v, {}]))

// 新型号没有 config 条目，也要补齐 OpenCode Model 的 api 和 capabilities，不能只写扁平 reasoning。
const modelEntries = (ids, models, cat) => Object.fromEntries(
  ids.map((id) => {
    const base = models[id] ?? {}
    const c = cat.get(id)
    const context = num(c?.context_window_size) * 1000
    return [id, {
      ...base,
      id,
      name: c?.display_name ?? base.name ?? title(id),
      api: { id, url: BASE, npm: "@ai-sdk/openai", ...base.api },
      capabilities: { ...base.capabilities, reasoning: true, toolcall: true },
      variants: VARIANTS,
      ...(context > 0 ? { limit: { ...base.limit, context } } : {}),
    }]
  }),
)

const title = (id) =>
  id.split(/[-_.]/).map((w) => (w.length <= 3 && /^[a-z0-9]+$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(" ")

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

const fmt = (v) => num(v).toLocaleString("en-US", { maximumFractionDigits: 2 })

// BlueNeo 的接口一律 HTTP 200，成败在 body.code
const TIMEOUT = 20000 // 单次请求的上限；一个窗口读两次
const SWITCHES_TIMEOUT = 8000 // 开关只是装饰，慢就别等它

const api = async (session, path, init = {}, ms = TIMEOUT) => {
  const res = await fetch(DASH + path, {
    method: init.body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
    body: init.body,
    signal: init.signal ?? AbortSignal.timeout(ms),
  })
  try {
    return await res.json()
  } catch {
    return { code: String(res.status), message: `BlueNeo answered ${res.status}` }
  }
}

// 站点给的是北京时间，不带时区
const iso = (s) => {
  if (!s) return undefined
  const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s}${BEIJING}`)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

const spanSec = (from, to) => {
  const a = new Date(iso(from) ?? 0).getTime()
  const b = new Date(iso(to) ?? 0).getTime()
  return a && b && b > a ? Math.round((b - a) / 1000) : undefined
}

// 加量包按名字合并：同名的多笔，余额相加、取最早到期
const groupPacks = (packs) => {
  const by = new Map()
  for (const p of packs ?? []) {
    if (p?.status !== 1) continue
    const k = p.sp_name ?? "加量包"
    const g = by.get(k) ?? { name: k, balance: 0, total: 0, end: undefined, count: 0 }
    g.balance += num(p.balance_amount)
    g.total += num(p.total_amount)
    g.count += 1
    const end = iso(p.end_time)
    if (end && (!g.end || end < g.end)) g.end = end
    by.set(k, g)
  }
  return [...by.values()].sort((a, b) => String(a.end).localeCompare(String(b.end)))
}

// 概览页的加量包是一行：只算生效中的包，已用 / 总额相加
const packSummary = (packs) => {
  const g = groupPacks(packs)
  // 最早作废的那一笔按单个包算，合并后的组会把到期时间抹平
  const soon = g.length
    ? (packs ?? [])
      .filter((p) => p?.status === 1 && iso(p.end_time))
      .map((p) => ({ end: iso(p.end_time), balance: num(p.balance_amount) }))
      .sort((a, b) => a.end.localeCompare(b.end))[0]
    : undefined
  return {
    used: g.reduce((s, x) => s + x.total - x.balance, 0),
    total: g.reduce((s, x) => s + x.total, 0),
    left: g.reduce((s, x) => s + x.balance, 0),
    count: g.reduce((s, x) => s + x.count, 0),
    runsOutAt: soon?.end,
    runsOut: soon?.balance,
  }
}

const usedPct = (left, total) => (total > 0 ? Math.min(100, Math.max(0, Math.round((1 - left / total) * 10000) / 100)) : undefined)

const jwtExp = (token) => {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString()).exp * 1000
  } catch {
    return 0
  }
}

// 账号密码登录：拿 web 会话 JWT。登录页的 Geetest 在前端，服务端不校验
const login = async (account, password, signal) => {
  let body
  try {
    const res = await fetch(`${DASH}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { type: 3, account, password } }),
      signal: signal ?? AbortSignal.timeout(TIMEOUT),
    })
    body = await res.json()
  } catch (e) {
    return { error: `连不上 BlueNeo：${e.message}` }
  }
  if (body.code !== "200") {
    const msg = body.message ?? "登录失败"
    return { error: msg, captcha: /人机验证|验证码|geetest/i.test(msg) || /验证/.test(msg) }
  }
  const d = body.data
  if (d?.requires_2fa === true || d?.is_2fa_enabled === true)
    return { error: "这个账号开了两步验证，插件登不了，请改用「Web 会话 token」方式" }
  const token = typeof d === "string" ? d : d?.token ?? d?.access_token ?? d?.jwt
  if (!token) return { error: "登录成功但没拿到 token" }
  return { token, expires: jwtExp(token) }
}

// 账号自己的密钥，优先 default，其次最新的
const pickKey = async (session) => {
  const r = await api(session, "/api/api_key/list", { body: "{}" })
  const live = (r.data ?? []).filter((k) => k?.api_key && (!k.valid_end_time || new Date(iso(k.valid_end_time) ?? 0) > new Date()))
  if (!live.length) return undefined
  const pick = live.find((k) => /default/i.test(k.desc ?? "")) ??
    live.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
  return pick?.api_key
}

// 两种登录方式存的东西不同，这里统一成网关 key + web 会话 token
const creds = (auth) =>
  auth?.type === "api"
    ? { key: auth.key, session: auth.metadata?.session }
    : { key: auth?.apiKey, session: auth?.access }

const catalog = async (session) => {
  if (!session) return new Map()
  const r = await api(session, "/api/model/prices")
  return new Map((r.data ?? []).map((m) => [m.model_name, m]))
}

// 额度总览：概览页的三张卡 + 签到。BlueNeo 忙时单个接口会几十秒或直接断，
// 所以每个都单独兜住、各试两次，坏一个只少一张卡，不连累整块
const readUsage = async (auth, session, log) => {
  const soft = async (path, init, ms = TIMEOUT) => {
    for (let i = 0; i < 2; i++) {
      try {
        return await api(session, path, init, ms)
      } catch (e) {
        if (i === 1) return { code: "net", message: e.message }
      }
    }
  }

  const [plan, packs, checkin, periodic, switches] = await Promise.all([
    soft("/api/credit_plan/account"),
    soft("/api/asset/my_packs", { body: "{}" }),
    soft("/api/checkin/status"),
    soft("/api/asset/periodic_account"),
    soft("/api/users/settle-switches", {}, SWITCHES_TIMEOUT),
  ])

  if (plan.code === "401") return { windows: [], signIn: "expired", error: "web 会话过期了，重新登录一次" }
  if (plan.code !== "200") {
    log(`usage: ${plan.message ?? plan.code}`)
    return { windows: [], error: `读额度失败：${plan.message ?? plan.code}` }
  }

  const p = plan.data ?? {}
  const sw = switches.data ?? {}
  // Trae 的写法：只给 amount/limit/unit，数量和百分比由 magpie 自己排；停用状态标在名字里
  const on = (v) => v !== 0 // 开关读不到时不硬说停用
  const name = (label, enabled, note) => (enabled ? label : `${label}（已停用${note ? `，${note}` : ""}）`)
  // magpie 只保留非零的 amount；一点没用的窗口得自己写一行数字，不然那行会是空的
  const zero = (amount, limit, unit) => (amount > 0 ? {} : { display: `0 / ${fmt(limit)} ${unit}` })
  const windows = []

  // 概览页的三张卡：已用 / 总额 Credit
  const total = num(p.base_quota)
  const left = num(p.base_balance)
  if (total > 0) {
    windows.push({
      name: name("Tokens Plan", on(sw.is_credit_plan_settled), `剩 ${fmt(left)}`),
      amount: Math.max(0, total - left),
      limit: total,
      unit: "Credit",
      ...zero(total - left, total, "Credit"),
      resetsAt: iso(p.next_reset_time),
      span: spanSec(p.current_period_start, p.current_period_end),
    })
  }

  const addon = packSummary(packs.data)
  if (addon.total > 0) {
    windows.push({
      name: name("加量包", on(sw.is_addon_pack_settled), `${addon.count} 个生效中`),
      amount: addon.used,
      limit: addon.total,
      unit: "Credit",
      ...zero(addon.used, addon.total, "Credit"),
      runsOutAt: addon.runsOutAt,
      runsOut: addon.runsOut,
      aside: !on(sw.is_addon_pack_settled),
    })
  }

  const compute = periodic.data ?? {}
  const acquired = num(compute.lifetime_acquired) || num(p.compute_pack_balance)
  if (acquired > 0) {
    windows.push({
      name: name("算能包", on(sw.is_compute_pack_settled), `剩 ${fmt(num(compute.balance))}`),
      amount: num(compute.total_consumed),
      limit: acquired,
      unit: "Credit",
      ...zero(num(compute.total_consumed), acquired, "Credit"),
      aside: !on(sw.is_compute_pack_settled),
    })
  }

  const c = checkin.data
  if (c?.total_days) {
    const credited = (c.records ?? []).reduce((s, r) => s + num(r.reward_credit), 0)
    windows.push({
      name: `签到 · 连签 ${c.continuous_days} 天`,
      display: `${c.checked_today ? "今日已签" : "今日未签"} · 累计 ${fmt(credited)} 额度`,
      aside: true,
    })
  }

  return {
    plan: p.current_plan?.plan_level_name,
    user: auth.username ?? auth.metadata?.username ?? auth.accountId,
    until: iso(p.current_period_end),
    windows,
  }
}

export const BlueNeoAuthPlugin = async ({ client } = {}) => {
  // 登录失败的原因只有用户能看到一次，顺手写进 magpie 日志，出问题时能查
  const log = (message) => {
    try {
      client?.app?.log?.({ body: { service: "blueneo", level: "error", message } })
    } catch { }
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "BlueNeo Cloud",
        npm: "@ai-sdk/openai", // Responses（/v1/responses）；思考档位只有这条协议有
        api: BASE,
        models: {},
      }
    },

    auth: {
      provider: PROVIDER,
      refreshLead: 60 * 60 * 1000, // JWT 只活 7 天，提前一小时用存下的密码重登
      methods: [
        {
          type: "oauth",
          label: "BlueNeo 账号登录",
          prompts: [
            { type: "text", key: "account", message: "用户名或邮箱" },
            { type: "password", key: "password", message: "登录密码" },
          ],
          async authorize(inputs, { signal } = {}) {
            const account = String(inputs?.account ?? "").trim()
            const password = String(inputs?.password ?? "")
            if (!account || !password) return { type: "failed", error: "用户名和密码都要填" }

            // oauth 方式必须先给出一个 flow，magpie 不接受 authorize 直接返回 success
            return {
              instructions: "用你填的账号密码自动登录，不打开浏览器",
              method: "auto",
              async callback() {
                const r = await login(account, password, signal)
                if (r.error) {
                  log(`login ${account}: ${r.error}`)
                  return {
                    type: "failed",
                    error: r.captcha ? `${r.error} · 改用「Web 会话 token」方式登录` : r.error,
                  }
                }

                const apiKey = await pickKey(r.token)
                if (!apiKey) return { type: "failed", error: "这个账号没有可用的 API key，先去 BlueNeo 的「API 密钥」页建一把" }

                const me = await api(r.token, "/api/users/detail")
                const username = me.data?.username ?? me.data?.display_name ?? account
                return { type: "success", access: r.token, refresh: password, expires: r.expires, accountId: username, username, apiKey }
              },
            }
          },
        },
        {
          type: "api",
          label: "Web 会话 token（备用）",
          placeholder: "document.cookie 里那个 JWT",
          prompts: [
            { type: "password", key: "session", message: "Web 会话 token", placeholder: "document.cookie 里那个 JWT" },
          ],
          async authorize(inputs) {
            const key = String(inputs?.key ?? inputs?.apiKey ?? "").trim()
            const session = String(inputs?.session ?? "").trim()
            if (!key) return { type: "failed", error: "API key 必填；额度要再填 Web 会话 token" }

            try {
              const res = await fetch(`${BASE}/models`, {
                headers: { authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(TIMEOUT),
              })
              if (!res.ok) {
                log(`key check: HTTP ${res.status}`)
                return { type: "failed", error: `BlueNeo 拒绝了这把 key（HTTP ${res.status}）` }
              }
            } catch (e) {
              log(`key check: ${e.message}`)
              return { type: "failed", error: `连不上 BlueNeo：${e.message}` }
            }

            // token 只影响额度/签到，留空也能用模型
            let username
            if (session) {
              const me = await api(session, "/api/users/detail")
              if (me.code !== "200") {
                log(`session check: ${me.message ?? me.code}`)
                return { type: "failed", error: "Web 会话 token 无效或已过期，去 BlueNeo 重新登录再复制" }
              }
              username = me.data?.username ?? me.data?.display_name
            }

            return { type: "success", key, accountId: username, metadata: session ? { session, username } : undefined }
          },
        },
      ],

      async refresh(auth) {
        if (auth?.type !== "oauth" || !auth.username || !auth.refresh) return
        const r = await login(auth.username, auth.refresh)
        // 密码变了或被要求验证码，就别再重试，让用户重新登录
        if (r.error) throw Object.assign(new Error(r.error), { signIn: "expired" })
        return { access: r.token, expires: r.expires, apiKey: (await pickKey(r.token)) ?? auth.apiKey }
      },

      async loader(getAuth) {
        const auth = await getAuth()
        const { key } = creds(auth)
        if (!key) return {}
        return { baseURL: BASE, apiKey: key }
      },

      async usage(getAuth) {
        const auth = await getAuth()
        const session = creds(auth).session
        if (!session) return { windows: [], error: "没有 web 会话 token，读不到额度" }

        try {
          return await readUsage(auth, session, log)
        } catch (e) {
          // 一个请求超时就让整个钩子抛错的话，面板只会默默留着旧快照，看不出发生过什么
          log(`usage: ${e.message}`)
          return { windows: [], error: `读额度失败：${e.message}` }
        }
      },


      async checkin(getAuth) {
        const auth = await getAuth()
        const session = creds(auth).session
        if (!session) return { outcome: "failed", message: "没有 web 会话 token，签不了" }

        const status = await api(session, "/api/checkin/status")
        if (status.code === "401") throw Object.assign(new Error("BlueNeo 拒绝了 web 会话"), { signIn: "expired" })
        if (status.code !== "200") return { outcome: "failed", message: status.message ?? "读不到签到状态" }

        const s = status.data ?? {}
        if (!s.activity) return { outcome: "inactive" }
        if (!s.eligible) return { outcome: "ineligible" }
        if (s.checked_today) return { outcome: "done", streak: s.continuous_days, message: `连签 ${s.continuous_days} 天` }

        // geetest 现场解不出来，按 magpie 的约定交给用户去网页签
        if (s.geetest_required)
          return { outcome: "captcha", message: `BlueNeo 要求人机验证，去网页签到 · 已连签 ${s.continuous_days} 天` }

        const r = await api(session, "/api/checkin", { body: "{}" })
        if (r.code !== "200") {
          if (/人机验证|geetest|验证/i.test(r.message ?? "")) return { outcome: "captcha", message: r.message }
          return { outcome: "failed", message: r.message ?? "签到失败" }
        }

        const d = r.data ?? {}
        return { outcome: "claimed", credit: num(d.reward_credit ?? d.credit), streak: d.continuous_days ?? s.continuous_days, message: d.reward_name }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const { key, session } = creds(auth)
        if (!key) return provider.models
        try {
          const res = await fetch(`${BASE}/models`, {
            headers: { authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(TIMEOUT),
          })
          if (!res.ok) return provider.models // magpie 保留原来的列表
          const ids = ((await res.json()).data ?? []).map((m) => m.id)
          if (!ids.length) return provider.models
          // 目录只补名称和上下文，失败不能挡住网关发现的新型号。
          const cat = await catalog(session).catch(() => new Map())
          return modelEntries(ids, provider.models, cat)
        } catch {
          return provider.models
        }
      },
    },
  }
}

export default BlueNeoAuthPlugin

export const _internal = { num, fmt, iso, spanSec, groupPacks, packSummary, usedPct, jwtExp, creds, VARIANTS, modelEntries }
