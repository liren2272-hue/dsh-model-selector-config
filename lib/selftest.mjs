/**
 * dsh-model-selector-config —— 离线自测（假 ctx + 假 settings/llm）。
 *
 * 跑法（DSH runtime node）：node.exe lib/selftest.mjs
 *
 * 验证：
 *  1. readCatalog 首次从 describe 建立快照，组装 groups，visible 按 hidden/enabledModelIds 算。
 *  2. setVisibility(pi-ai hidden)：更新 hidden + 用快照过滤重写 models（隐藏项从生效数组消失）。
 *  3. setVisibility(pi-ai visible)：恢复——重写为完整快照（隐藏项回来），可逆。
 *  4. setDefaultLevel(pi-ai)：写 provider 级 ['providers',p,'reasoning']。
 *  5. setVisibility(workbuddy)：改 enabledModelIds 白名单；清空时拒绝（至少留一个）。
 *  6. setDefaultLevel(workbuddy)：写 defaultThinkingEfforts[modelId] + lastCatalog[idx].reasoning.defaultEffort。
 *
 * 假 settings 用内存 describe/mutate，假 llm.resolveModelInfo 返回固定 reasoning。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log('  ok  ' + name) }
  else { fail++; console.log('  FAIL ' + name) }
}

function makeFakeSettings() {
  const descriptor = {
    ns: 'llm-pi-ai',
    revision: 7,
    value: {
      providers: {
        officeace: {
          displayName: 'OfficeAce',
          reasoning: 'medium',
          models: [
            { id: 'm1', name: 'Model 1', reasoningEfforts: { low: 'low', high: 'high' } },
            { id: 'm2', name: 'Model 2' },
            { id: 'm3', name: 'Model 3', reasoningEfforts: { max: 'max' } },
          ],
        },
      },
    },
  }
  const wb = {
    ns: 'dsh-connect-workbuddy',
    revision: 3,
    value: {
      regions: {
        cn: {
          enabledModelIds: [],
          defaultThinkingEfforts: {},
          lastCatalog: [
            { id: 'w1', name: 'W1', reasoning: { supportedEfforts: ['high'], defaultEffort: 'high' } },
            { id: 'w2', name: 'W2', reasoning: { supportedEfforts: ['low', 'medium'], defaultEffort: 'low' } },
          ],
        },
      },
    },
  }
  const calls = []
  return {
    calls,
    descriptors: { 'llm-pi-ai': descriptor, 'dsh-connect-workbuddy': wb },
    async describe() { return [descriptor, wb] },
    async mutate(ns, ops, expectedRevision) {
      calls.push({ ns, ops, expectedRevision })
      const d = this.descriptors[ns]
      for (const op of ops) {
        if (op.op === 'set') {
          let node = d.value
          for (let i = 0; i < op.path.length - 1; i++) node = node[op.path[i]]
          node[op.path[op.path.length - 1]] = op.value
        }
      }
      d.revision += 1
    },
  }
}

function makeFakeLlm() {
  return {
    async resolveModelInfo(provider, model) {
      const map = {
        m1: { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } },
        m2: { reasoning: undefined },
        m3: { reasoning: { efforts: [{ id: 'max' }], defaultEffort: undefined } },
      }
      return map[model] ?? {}
    },
  }
}

function makeCtx(env, settings) {
  const llm = makeFakeLlm()
  const services = { settings, llm }
  return { env, get(name) { return services[name] }, _settings: settings }
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'msc-selftest-'))
  const env = { DSH_HOME: dir }

  const { readCatalog } = await import('./catalog.mjs')
  const { setVisibility, setDefaultLevel } = await import('./mutate.mjs')
  const { loadState, saveState } = await import('./state.mjs')

  // === pi-ai ===
  {
    const settings = makeFakeSettings()
    const ctx = makeCtx(env, settings)
    const res = await readCatalog(ctx)
    check('readCatalog ok', res.ok === true)
    const g = res.groups.find((x) => x.provider === 'officeace')
    check('有 officeace 分组', !!g)
    check('officeace 3 个模型', g.models.length === 3)
    check('m1 默认档 low（来自 llm）', g.models.find((m) => m.id === 'm1').defaultLevel === 'low')
    check('m1 efforts 来自 llm [low,high]', JSON.stringify(g.models.find((m) => m.id === 'm1').efforts) === '["low","high"]')
    check('m2 无 reasoning → efforts 空', g.models.find((m) => m.id === 'm2').efforts.length === 0)
    check('m3 efforts 回退声明 [max]', JSON.stringify(g.models.find((m) => m.id === 'm3').efforts) === '["max"]')
    check('初始全部 visible', g.models.every((m) => m.visible === true))
  }

  // 隐藏 m2 → 快照仍是 3 个，生效数组过滤掉 m2，但 readCatalog 仍列出 m2（visible:false）
  {
    const settings = makeFakeSettings()
    const ctx = makeCtx(env, settings)
    await readCatalog(ctx) // 建立快照
    const res = await setVisibility(ctx, { provider: 'officeace', model: 'm2', visible: false, kind: 'pi-ai' })
    check('setVisibility hidden ok', res.ok === true)
    const call = settings.calls.find((c) => c.ops.some((o) => o.path.join('.') === 'providers.officeace.models'))
    check('mutate 了 providers.officeace.models', !!call)
    check('revision 传入 7', call && call.expectedRevision === 7)
    const models = call.ops[0].value
    check('生效数组过滤掉 m2（剩 m1,m3）', models.length === 2 && !models.some((m) => m.id === 'm2'))
    // 再读：快照仍含 m2，visible=false
    const cat = await readCatalog(ctx)
    const g = cat.groups.find((x) => x.provider === 'officeace')
    const m2 = g.models.find((m) => m.id === 'm2')
    check('快照仍含 m2（可逆）', !!m2)
    check('m2 visible=false', m2.visible === false)
  }

  // 恢复 m2 → 生效数组回到完整 3 个
  {
    const settings = makeFakeSettings()
    const ctx = makeCtx(env, settings)
    await readCatalog(ctx)
    await setVisibility(ctx, { provider: 'officeace', model: 'm2', visible: false, kind: 'pi-ai' })
    const res = await setVisibility(ctx, { provider: 'officeace', model: 'm2', visible: true, kind: 'pi-ai' })
    check('setVisibility visible ok', res.ok === true)
    const lastModels = settings.calls.filter((c) => c.ops.some((o) => o.path.join('.') === 'providers.officeace.models')).pop().ops[0].value
    check('恢复后 3 个模型都在', lastModels.length === 3 && lastModels.some((m) => m.id === 'm2'))
  }

  // 默认档 provider 级
  {
    const settings = makeFakeSettings()
    const ctx = makeCtx(env, settings)
    await readCatalog(ctx)
    const res = await setDefaultLevel(ctx, { provider: 'officeace', model: 'm1', level: 'xhigh', kind: 'pi-ai' })
    check('setDefaultLevel(pi-ai) ok', res.ok === true)
    const call = settings.calls.find((c) => c.ops.some((o) => o.path.join('.') === 'providers.officeace.reasoning'))
    check('mutate 了 provider 级 reasoning', !!call)
    check('写入值 xhigh', call && call.ops[0].value === 'xhigh')
    check('revision 传入', call && typeof call.expectedRevision === 'number')
  }

  // === workbuddy ===
  {
    const settings = makeFakeSettings()
    const ctx = makeCtx(env, settings)
    const cat = await readCatalog(ctx)
    const g = cat.groups.find((x) => x.kind === 'workbuddy')
    check('有 workbuddy 分组', !!g)
    check('workbuddy 2 个模型', g.models.length === 2)
    check('白名单空 → 全 visible', g.models.every((m) => m.visible === true))
    check('w1 defaultLevel high', g.models.find((m) => m.id === 'w1').defaultLevel === 'high')
  }
  {
    const settings = makeFakeSettings()
    const ctx = makeCtx(env, settings)
    await readCatalog(ctx)
    const res = await setVisibility(ctx, { provider: 'workbuddy', model: 'w1', visible: false, kind: 'workbuddy' })
    check('workbuddy hide ok', res.ok === true)
    const call = settings.calls.find((c) => c.ops.some((o) => o.path.join('.') === 'regions.cn.enabledModelIds'))
    check('mutate 了 enabledModelIds', !!call)
    check('白名单剔除 w1（剩 w2）', call && JSON.stringify(call.ops[0].value) === '["w2"]')
    // 清空拒绝：再把 w2 也隐藏
    const res2 = await setVisibility(ctx, { provider: 'workbuddy', model: 'w2', visible: false, kind: 'workbuddy' })
    check('清空白名单被拒绝（至少留一个）', res2.ok === false)
  }
  {
    const settings = makeFakeSettings()
    const ctx = makeCtx(env, settings)
    await readCatalog(ctx)
    const res = await setDefaultLevel(ctx, { provider: 'workbuddy', model: 'w1', level: 'medium', kind: 'workbuddy' })
    check('setDefaultLevel(workbuddy) ok', res.ok === true)
    const call = settings.calls.find((c) => c.ops.some((o) => o.path.join('.') === 'regions.cn.defaultThinkingEfforts.w1'))
    check('mutate 了 defaultThinkingEfforts.w1', !!call)
    check('写入值 medium', call && call.ops[0].value === 'medium')
    const echo = settings.calls.find((c) => c.ops.some((o) => o.path.join('.') === 'regions.cn.lastCatalog.0.reasoning.defaultEffort'))
    check('同步 lastCatalog 回显', !!echo && echo.ops.find((o) => o.path.join('.') === 'regions.cn.lastCatalog.0.reasoning.defaultEffort').value === 'medium')
  }

  // === Cordis 代理陷阱回归（负向对照）===
  // 真实宿主里 ctx 是 ReflectService 代理：未 inject 的 `ctx.env` 裸读会抛
  // `cannot get property "env" without inject`。上面所有假 ctx 都是普通对象，
  // `.env` 直接可读，永远抓不到这个故障——所以这里显式造一个会抛的 getter。
  {
    const settings = makeFakeSettings()
    const llm = makeFakeLlm()
    const trapCtx = {
      get(name) { return { settings, llm, env }[name] },
      get env() { throw new Error('cannot get property "env" without inject') },
    }
    const res = await loadState(trapCtx)
    check('trap ctx: loadState 走 ctx.get("env") 不抛', !!res && !!res.snapshots)
    const p = await saveState(trapCtx, res)
    check('trap ctx: saveState 走 ctx.get("env") 不抛', typeof p === 'string' && p.includes('state.json'))
  }
  // 完全没有 env 服务：get('env') 返回 undefined 且 ctx.env 抛 → 退回 process.env，不抛
  {
    const settings = makeFakeSettings()
    const llm = makeFakeLlm()
    const noEnvCtx = {
      get(name) { return { settings, llm }[name] },
      get env() { throw new Error('cannot get property "env" without inject') },
    }
    let threw = false
    try { await loadState(noEnvCtx) } catch { threw = true }
    check('无 env 服务：loadState 退回 process.env 不抛', threw === false)
  }

  await rm(dir, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
