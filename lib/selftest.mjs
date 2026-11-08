/**
 * dsh-model-selector-config —— 离线自测（v2）。
 *
 * 用「与真实 dsh-llm 同形」的假 llm 服务 + 隔离的临时 DSH_HOME，验证四个修复：
 *   #3 动态枚举：listProviders() 里出现的平台（含 Qoder / workbuddy）全部出现在表里；
 *   #2 每模型独立默认档：改 A 不影响 B；
 *      可见性可逆：隐藏 = listModels 过滤、readCatalog 仍列（visible:false）、恢复即可见；
 *      写入经 emitAdaptersUpdated 通知选择器刷新。
 *
 * 关键：包含「TRUE-RED 负向对照」——把每个修复单独回滚，确认对应的绿灯断言会变红。
 * 若回滚后仍绿，说明该断言不灵敏、主套件结果无意义，本自测主动判失败。
 *
 * 跑法：
 *   C:/Users/15940/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe selftest.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalize, loadState, saveState, stateInfo, mutateState } from './state.mjs'
import { ensureOverlay, bumpOverlay } from './overlay.mjs'
import { readCatalog } from './catalog.mjs'
import { setVisibility, setDefaultLevel } from './mutate.mjs'
import * as indexModule from './index.mjs'

let passed = 0
let failed = 0
const failures = []
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok   ' + msg) }
  else { failed++; failures.push(msg); console.log('  FAIL ' + msg) }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  ok(a === e, `${msg}  [got ${a}]`)
}

const L = (...ids) => ids.map((id) => ({ id, name: id }))

/** 与真实 dsh-llm 同形的假服务：listModels / resolveModelInfoFor / resolveModelInfo / 事件。 */
function makeProviders() {
  return {
    codearts: {
      name: 'CodeArts', models: [
        { id: 'GLM-5.2', name: 'GLM-5.2', reasoning: { efforts: L('minimal', 'low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'max' } },
        { id: 'kimi-k3', name: 'Kimi K3', reasoning: { efforts: L('low', 'medium', 'high'), defaultEffort: 'high' } },
      ],
    },
    qoder: { // 插件动态注册平台（问题 3 的核心）
      name: 'Qoder', models: [
        { id: 'qfmodel', name: 'Qoder Fast', reasoning: { efforts: L('off', 'low', 'high'), defaultEffort: 'low' } },
        { id: 'qsmodel', name: 'Qoder Smart', reasoning: { efforts: L('off', 'low', 'high'), defaultEffort: 'off' } },
      ],
    },
    workbuddy: { // 又一个动态平台
      name: 'WorkBuddy', models: [
        { id: 'hy4free', name: 'HY4 Free', reasoning: { efforts: L('low', 'high'), defaultEffort: 'low' } },
      ],
    },
    plain: { name: 'NoReasoning', models: [{ id: 'p1', name: 'P1' }] }, // 无 reasoning
  }
}

function makeLlm(providers) {
  const adapters = new Map()
  for (const [id, p] of Object.entries(providers)) {
    adapters.set(id, { provider: { id, name: p.name }, models: p.models })
  }
  const llm = {
    _events: [],
    listProviders() { return [...adapters.values()].map(({ provider }) => ({ ...provider })) },
    async listModels(provider) {
      const reg = adapters.get(provider)
      if (!reg) throw new Error(`no adapter registered for provider "${provider}"`)
      return reg.models.map((m) => ({ provider, id: m.id, name: m.name }))
    },
    async resolveModelInfoFor(registration, model) {
      const reg = adapters.get(registration.provider.id)
      const m = reg.models.find((x) => x.id === model)
      if (!m) throw new Error('model not found')
      const info = { provider: registration.provider.id, id: model, name: m.name }
      if (m.reasoning) {
        info.reasoning = {
          efforts: m.reasoning.efforts.map((e) => ({ ...e })),
          ...(m.reasoning.defaultEffort ? { defaultEffort: m.reasoning.defaultEffort } : {}),
        }
      }
      return info
    },
    async resolveModelInfo(provider, model) {
      return this.resolveModelInfoFor(adapters.get(provider), model)
    },
    listConfigurableProviders() { return [] },
    emitAdaptersUpdated() { this._events.push('adapters-updated') },
  }
  return llm
}

/** 普通 ctx：get() 返回服务、裸属性也可读、inject 立即回调。 */
function makeCtx(llm, env, webServer) {
  const services = { llm }
  if (webServer) services.webServer = webServer
  const ctx = {
    env,
    get(name) { return name === 'env' ? env : services[name] },
    inject(_deps, cb) { if (typeof cb === 'function') cb(ctx); return ctx },
  }
  return ctx
}

/** Cordis 代理陷阱 ctx：裸读服务属性会抛，只有 get()/inject() 可用。 */
function trappingCtx(llm, env) {
  const services = { llm }
  const target = {
    get(name) { return name === 'env' ? env : services[name] },
    inject(_deps, cb) { if (typeof cb === 'function') cb(proxy); return proxy },
  }
  const trapNames = new Set(['llm', 'settings', 'webServer', 'logger', 'env'])
  const proxy = new Proxy(target, {
    get(t, prop, recv) {
      if (prop === 'get' || prop === 'inject') return Reflect.get(t, prop, recv)
      if (typeof prop === 'string' && trapNames.has(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return Reflect.get(t, prop, recv)
    },
  })
  return proxy
}

function freshHome(label) {
  const dir = mkdtempSync(join(tmpdir(), `msc-selftest-${label}-`))
  return { dir, env: { DSH_HOME: dir } }
}

const homes = []
function makeSystem(label, { trap = false } = {}) {
  const { dir, env } = freshHome(label)
  homes.push(dir)
  const llm = makeLlm(makeProviders())
  const ctx = trap ? trappingCtx(llm, env) : makeCtx(llm, env)
  return { llm, ctx, env }
}

async function main() {
  console.log('== 1. state.normalize 迁移（丢弃 v1 的「整平台共用档」字符串 + snapshots）==')
  {
    const n = normalize({
      hidden: { codearts: ['kimi-k3', 42] },
      defaults: { codearts: 'max', qoder: { qfmodel: 'high' }, bad: 7 },
      snapshots: { piAi: {}, workbuddy: [] },
    })
    eq(n, { hidden: { codearts: ['kimi-k3'] }, defaults: { qoder: { qfmodel: 'high' } } },
      'provider 级字符串档被丢弃、非字符串 modelId 被过滤、snapshots 被丢弃')
    eq(normalize(null), { hidden: {}, defaults: {} }, '空输入归一化为 EMPTY 形状')
  }

  console.log('== 2. 动态枚举（问题 3）：表里平台 == listProviders() ==')
  {
    const { llm, ctx } = makeSystem('enum')
    ensureOverlay(ctx)
    const cat = await readCatalog(ctx)
    ok(cat.ok === true, `readCatalog ok（error=${cat.error ?? '无'}）`)
    eq(cat.groups.map((g) => g.provider).sort(), ['codearts', 'plain', 'qoder', 'workbuddy'],
      '4 个平台全部出现（含 qoder / workbuddy，不再只认 2 个硬编码 entry）')
    const qoder = cat.groups.find((g) => g.provider === 'qoder')
    eq(qoder.label, 'Qoder', '平台名取 provider.name / displayName')
    eq(qoder.models.map((m) => m.id), ['qfmodel', 'qsmodel'], 'qoder 两个模型都在')
    const plain = cat.groups.find((g) => g.provider === 'plain')
    eq(plain.models[0].efforts, [], '无 reasoning 的模型 efforts 为空数组')
    const glm = cat.groups.find((g) => g.provider === 'codearts').models.find((m) => m.id === 'GLM-5.2')
    eq(glm.defaultLevel, 'max', '未设默认档时回显原生 defaultEffort')
  }

  console.log('== 3. 每模型独立默认档（问题 2）：改 A 不动 B ==')
  {
    const { llm, ctx } = makeSystem('perm')
    ensureOverlay(ctx)
    const r1 = await setDefaultLevel(ctx, { provider: 'qoder', model: 'qfmodel', level: 'high' })
    ok(r1.ok === true, 'setDefaultLevel(qfmodel=high) 成功')
    const r2 = await setDefaultLevel(ctx, { provider: 'codearts', model: 'GLM-5.2', level: 'low' })
    ok(r2.ok === true, 'setDefaultLevel(GLM-5.2=low) 成功')

    const cat = await readCatalog(ctx)
    const q = cat.groups.find((g) => g.provider === 'qoder').models
    eq(q.find((m) => m.id === 'qfmodel').defaultLevel, 'high', 'qfmodel 独立=high')
    eq(q.find((m) => m.id === 'qsmodel').defaultLevel, 'off', 'qsmodel 不受影响，保持原生 off')
    const c = cat.groups.find((g) => g.provider === 'codearts').models
    eq(c.find((m) => m.id === 'GLM-5.2').defaultLevel, 'low', 'GLM-5.2 独立=low')
    eq(c.find((m) => m.id === 'kimi-k3').defaultLevel, 'high', 'kimi-k3 不受影响，保持原生 high')

    // 真实请求路径 resolveCallFor 也走 resolveModelInfoFor → 注入同样生效
    const qf = await llm.resolveModelInfo('qoder', 'qfmodel')
    eq(qf.reasoning.defaultEffort, 'high', 'resolveModelInfo 路径也拿到注入的档（覆盖 resolveCallFor）')
    const qs = await llm.resolveModelInfo('qoder', 'qsmodel')
    eq(qs.reasoning.defaultEffort, 'off', 'resolveModelInfo 对未设模型保持原生档')

    // 必须带 model：缺省要拒绝（避免退回「整平台一个档」）
    const r3 = await setDefaultLevel(ctx, { provider: 'qoder', level: 'low' })
    ok(r3.ok === false && /model/.test(r3.error), '缺 model 被拒绝（防止退回 provider 级共用档）')

    // hasOverride + 「跟随默认」一键清覆盖（可逆）
    const before = await readCatalog(ctx)
    ok(before.groups.find((g) => g.provider === 'qoder').models.find((m) => m.id === 'qfmodel').hasOverride === true,
      '设过的模型 hasOverride=true')
    ok(before.groups.find((g) => g.provider === 'qoder').models.find((m) => m.id === 'qsmodel').hasOverride === false,
      '没设过的模型 hasOverride=false')
    await setDefaultLevel(ctx, { provider: 'qoder', model: 'qfmodel', level: 'auto' })
    const after = await readCatalog(ctx)
    eq(after.groups.find((g) => g.provider === 'qoder').models.find((m) => m.id === 'qfmodel').defaultLevel, 'low',
      'auto 后回到 adapter 原生默认 low')
    eq(after.groups.find((g) => g.provider === 'qoder').models.find((m) => m.id === 'qfmodel').hasOverride, false,
      'auto 后 hasOverride=false')
    eq(after.groups.find((g) => g.provider === 'codearts').models.find((m) => m.id === 'GLM-5.2').defaultLevel, 'low',
      '清 qoder 覆盖不影响另一平台 codearts 的独立设置')
  }

  console.log('== 4. 可见性可逆 + 过滤器 + 护栏 + 事件通知 ==')
  {
    const { llm, ctx } = makeSystem('vis')
    ensureOverlay(ctx)
    const hide = await setVisibility(ctx, { provider: 'codearts', model: 'kimi-k3', visible: false })
    ok(hide.ok === true, '隐藏 kimi-k3 成功')
    const filtered = await llm.listModels('codearts')
    eq(filtered.map((m) => m.id), ['GLM-5.2'], 'listModels 过滤掉隐藏模型（模型选择器据此不显示）')
    const cat = await readCatalog(ctx)
    const kimi = cat.groups.find((g) => g.provider === 'codearts').models.find((m) => m.id === 'kimi-k3')
    eq(kimi.visible, false, 'readCatalog 仍列出隐藏模型且 visible:false（可逆所需）')
    const show = await setVisibility(ctx, { provider: 'codearts', model: 'kimi-k3', visible: true })
    ok(show.ok === true, '恢复 kimi-k3 成功')
    eq((await llm.listModels('codearts')).map((m) => m.id), ['GLM-5.2', 'kimi-k3'], '恢复后 listModels 重新包含')
    ok(llm._events.includes('adapters-updated'), '写操作触发 emitAdaptersUpdated（客户端选择器会刷新）')

    // 护栏：不允许把某平台最后一个可见模型也隐藏
    const last = await setVisibility(ctx, { provider: 'plain', model: 'p1', visible: false })
    ok(last.ok === false && /至少保留一个/.test(last.error), '隐藏平台唯一模型被护栏拒绝')
  }

  console.log('== 5. 注入合法性守卫：非法档不注入（防 UNSUPPORTED_REASONING_EFFORT）==')
  {
    const { llm, ctx } = makeSystem('guard')
    ensureOverlay(ctx)
    await setDefaultLevel(ctx, { provider: 'codearts', model: 'GLM-5.2', level: 'off' }) // off 不在该模型 efforts
    const info = await llm.resolveModelInfo('codearts', 'GLM-5.2')
    eq(info.reasoning.defaultEffort, 'max', '非法档 off 被忽略，保持原生 max（不会污染真实请求）')
  }

  console.log('== 6. Cordis 代理陷阱安全：裸读服务属性会抛，代码一律用 get()/inject() ==')
  {
    const { llm, ctx } = makeSystem('trap', { trap: true })
    let threw = null
    try {
      ensureOverlay(ctx)
      const cat = await readCatalog(ctx)
      ok(cat.ok === true && cat.groups.length === 4, 'trap ctx 下 readCatalog 正常且全平台可见')
      await setVisibility(ctx, { provider: 'qoder', model: 'qfmodel', visible: false })
      await setDefaultLevel(ctx, { provider: 'qoder', model: 'qsmodel', level: 'high' })
      ok((await llm.listModels('qoder')).every((m) => m.id !== 'qfmodel'), 'trap ctx 下隐藏过滤生效')
    } catch (e) { threw = e }
    ok(threw === null, `trap ctx 全流程无裸读崩溃（${threw ? threw.message : '无异常'}）`)
  }

  console.log('== 7. TRUE-RED 负向对照：回滚修复必须变红 ==')
  {
    // 固定绿灯断言：隐藏生效（listModels 过滤）+ 每模型档注入生效。
    const green = (list, dflt) => list.length === 1 && list[0] === 'GLM-5.2' && dflt === 'high'

    // 走一遍真实写操作（setVisibility 的护栏内部会 ensureOverlay 幂等安装），
    // 然后按需把某个包装「还原成原始方法」= 精确回滚该修复，再读结果。
    async function writes(ctx) {
      await setVisibility(ctx, { provider: 'codearts', model: 'kimi-k3', visible: false })
      await setDefaultLevel(ctx, { provider: 'qoder', model: 'qfmodel', level: 'high' })
    }
    async function observe(llm) {
      const list = (await llm.listModels('codearts')).map((m) => m.id)
      const dflt = (await llm.resolveModelInfo('qoder', 'qfmodel')).reasoning.defaultEffort
      return { list, dflt }
    }

    // (A) 回滚整个 overlay（两个包装都还原成原始方法）= 修复完全不在：应观察到两个 bug
    {
      const { llm, ctx } = makeSystem('red-none')
      const handle = ensureOverlay(ctx)
      await writes(ctx)
      llm.listModels = handle.orig.listModels
      llm.resolveModelInfoFor = handle.orig.resolveModelInfoFor
      const { list, dflt } = await observe(llm)
      ok(!green(list, dflt) && list.includes('kimi-k3') && dflt === 'low',
        'A 两个包装都还原：绿灯断言变红（隐藏未过滤 / 档未注入）→ 证明断言灵敏')
    }

    // (B) 仅回滚 listModels 包装：只有可见性 bug 回来，每模型档仍绿
    {
      const { llm, ctx } = makeSystem('red-vis')
      const handle = ensureOverlay(ctx)
      await writes(ctx)
      llm.listModels = handle.orig.listModels // 回滚可见性修复
      const { list, dflt } = await observe(llm)
      ok(!green(list, dflt) && list.includes('kimi-k3') && dflt === 'high',
        'B 仅回滚 listModels：可见性变红、每模型档仍绿 → 两修复各自独立')
    }

    // (C) 仅回滚 resolveModelInfoFor 包装：只有每模型档 bug 回来，可见性仍绿
    {
      const { llm, ctx } = makeSystem('red-effort')
      const handle = ensureOverlay(ctx)
      await writes(ctx)
      llm.resolveModelInfoFor = handle.orig.resolveModelInfoFor // 回滚每模型档修复
      const { list, dflt } = await observe(llm)
      ok(!green(list, dflt) && !list.includes('kimi-k3') && dflt === 'low',
        'C 仅回滚 resolveModelInfoFor：可见性仍绿、每模型档变红 → 两修复各自独立')
    }

    // (D) 主绿灯（完整修复，不回滚）必须绿
    {
      const { llm, ctx } = makeSystem('red-green')
      ensureOverlay(ctx)
      await writes(ctx)
      const { list, dflt } = await observe(llm)
      ok(green(list, dflt), 'D 完整修复：绿灯断言成立')
    }
  }

  console.log('== 8. loadState / saveState 往返（隔离 DSH_HOME，不碰真机 state.json）==')
  {
    const { dir, env } = freshHome('roundtrip')
    homes.push(dir)
    const ctx = makeCtx(makeLlm(makeProviders()), env)
    const s = await loadState(ctx)
    eq(s, { hidden: {}, defaults: {} }, '初始为空')
    s.hidden.qoder = ['qfmodel']
    s.defaults.qoder = { qsmodel: 'high' }
    await saveState(ctx, s)
    bumpOverlay()
    const back = await loadState(ctx)
    eq(back, { hidden: { qoder: ['qfmodel'] }, defaults: { qoder: { qsmodel: 'high' } } }, '落盘往返一致')
  }

  console.log('== 9. index.mjs apply()：3 路由注册 + 路由真实可用 + 契约 ==')
  {
    const { llm, ctx, env } = makeSystem('index')
    const routes = []
    const webServer = { register(r) { routes.push(r) } }
    const services = { llm, webServer }
    const appCtx = {
      env,
      webServer, // webCtx.webServer 裸读：child ctx 经 inject(['webServer']) 注入后合法
      get(name) { return name === 'env' ? env : services[name] },
      inject(_deps, cb) { if (typeof cb === 'function') cb(appCtx); return appCtx },
    }
    ok(indexModule.name === 'dsh-model-selector-config', 'export name 正确')
    eq(indexModule.inject, ['webServer'], 'export inject 只声明 webServer')
    ok(typeof indexModule.apply === 'function', 'export apply 是函数')
    await indexModule.apply(appCtx)
    eq(routes.map((r) => r.path).sort(), [
      '/api/model-selector-config/providers',
      '/api/model-selector-config/visibility',
      '/api/model-selector-config/default-level',
    ].sort(), '3 条路由路径全部注册')
    const getRoute = routes.find((r) => r.path.endsWith('/providers'))
    const visRoute = routes.find((r) => r.path.endsWith('/visibility'))
    const lvlRoute = routes.find((r) => r.path.endsWith('/default-level'))
    let status, body
    const res = {
      writeHead(s) { status = s },
      end(p) { try { body = JSON.parse(p) } catch { body = null } },
    }
    // GET providers：返回的平台就是 listProviders()（含 qoder）
    await getRoute.handler({}, res)
    ok(status === 200 && body.ok === true && body.groups.some((g) => g.provider === 'qoder'),
      'GET providers 返回同源全平台（含 qoder）')
    ok(body.storage && typeof body.storage.path === 'string' && body.storage.path.endsWith('state.json'),
      'GET providers 回显 storage（配置存哪 / 何时存 / 体积）')
    // POST visibility：真实写入生效
    const req = (obj) => (async function* () { yield Buffer.from(JSON.stringify(obj)) })()
    await visRoute.handler(req({ provider: 'qoder', model: 'qfmodel', visible: false }), res)
    ok(status === 200 && body.ok === true, 'POST visibility 成功')
    ok((await llm.listModels('qoder')).every((m) => m.id !== 'qfmodel'), 'POST visibility 后 listModels 真过滤')
    // POST default-level：缺 model 应 400（契约：每模型独立）
    await lvlRoute.handler(req({ provider: 'qoder', level: 'high' }), res)
    ok(status === 400, 'POST default-level 缺 model 返回 400')
    // 带 model 成功
    await lvlRoute.handler(req({ provider: 'qoder', model: 'qsmodel', level: 'high' }), res)
    ok(status === 200 && body.ok === true, 'POST default-level 带 model 成功')
    eq((await llm.resolveModelInfo('qoder', 'qsmodel')).reasoning.defaultEffort, 'high',
      'POST default-level 后每模型档真生效')
  }

  console.log('== 10. v2.2 持久化加固：并发写不丢（TRUE-RED）+ .bak 回滚 + stateInfo ==')
  {
    const { dir, env } = freshHome('persist')
    homes.push(dir)
    const ctx = makeCtx(makeLlm(makeProviders()), env)

    // (RED) 旧版无锁 read-modify-write：用 barrier 强制两次写都基于同一份空 state，
    // 后写必然覆盖先写 -> 丢一次改动。断言「两者都在」必须变红，证明它真能抓到 lost update。
    let readers = 0
    let releaseRead
    const readGate = new Promise((r) => { releaseRead = r })
    async function legacyWrite(model, level) {
      const s = await loadState(ctx)
      readers++
      if (readers === 2) releaseRead()
      await readGate
      s.defaults.qoder = { ...(s.defaults.qoder || {}), [model]: level }
      await saveState(ctx, s)
    }
    await Promise.all([
      legacyWrite('qfmodel', 'high'),
      legacyWrite('qsmodel', 'low'),
    ])
    const legacy = await loadState(ctx)
    const redLost = !(legacy.defaults.qoder?.qfmodel === 'high' && legacy.defaults.qoder?.qsmodel === 'low')
    ok(redLost, 'RED 对照：旧版无锁并发写丢掉了一次改动（断言灵敏，非假绿）')

    // (GREEN) 同样两次并发写，改走 mutateState() 串行化：第二次读到第一次的落盘结果，两个都在。
    await saveState(ctx, { hidden: {}, defaults: {} })
    await Promise.all([
      mutateState(ctx, (s) => { s.defaults.qoder = { ...(s.defaults.qoder || {}), qfmodel: 'high' }; return { ok: true } }),
      mutateState(ctx, (s) => { s.defaults.qoder = { ...(s.defaults.qoder || {}), qsmodel: 'low' }; return { ok: true } }),
    ])
    const green = await loadState(ctx)
    ok(green.defaults.qoder?.qfmodel === 'high' && green.defaults.qoder?.qsmodel === 'low',
      'GREEN：mutateState 串行化后两次并发写都保留（lost update 修复生效）')

    // mutator 返回 {ok:false} 必须放弃写入（护栏不落盘、不污染配置）。
    const before = await loadState(ctx)
    const aborted = await mutateState(ctx, (s) => { s.defaults.qoder.shouldNotPersist = 'x'; return { ok: false, error: 'guard' } })
    const after = await loadState(ctx)
    ok(aborted.ok === false && JSON.stringify(before) === JSON.stringify(after),
      'mutator 返回 ok:false 时放弃写入（护栏不落盘）')

    // .bak 自动回滚：写两次让 .bak = 当前完好配置，再写坏主文件，loadState 应从 .bak 恢复。
    await saveState(ctx, { hidden: { qoder: ['qsmodel'] }, defaults: {} })
    await saveState(ctx, { hidden: { qoder: ['qsmodel'] }, defaults: {} })
    const target = join(dir, '.model-selector-config', 'state.json')
    writeFileSync(target, '{ this is not valid json', 'utf8')
    const recovered = await loadState(ctx)
    eq(recovered, { hidden: { qoder: ['qsmodel'] }, defaults: {} },
      '主文件损坏时自动从 state.json.bak 恢复，不再静默返回空配置')

    // stateInfo 回显
    const info = await stateInfo(ctx)
    ok(info.path.endsWith('state.json') && info.size > 0 && typeof info.savedAt === 'string',
      'stateInfo 回显落盘路径 / 最后保存时间 / 体积')
  }
}

try {
  await main()
} catch (e) {
  failed++
  failures.push('未捕获异常：' + (e?.stack ?? String(e)))
  console.error(e)
} finally {
  for (const d of homes) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1) }
else console.log('ALL SCENARIOS PASS')
