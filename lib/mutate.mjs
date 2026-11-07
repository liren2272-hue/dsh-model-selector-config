/**
 * dsh-model-selector-config —— 写通道：经 settings 服务热改 provider entry。
 *
 * 统一走 `settings.mutate(entry, ops, expectedRevision)`：
 *  - ops: [{op:'set',path:[...],value}, {op:'unset',path:[...]}]。数组索引 unset = 删元素。
 *  - expectedRevision = settings.describe() 对应 descriptor 的 `revision` 字段；冲突抛 SETTINGS_CONFLICT。
 *  - 只能写 volatile 路径。llm-pi-ai 的 providers 整体 volatile；workbuddy 的 regions 整体 volatile。
 *
 * 两类 provider 的可见性 / 默认档：
 *  - pi-ai 类（entry=llm-pi-ai）：
 *      隐藏/显示 = 从快照过滤 hidden，重写 ['providers',provider,'models'] 整数组（可逆）。
 *      默认档 = provider 级单值 ['providers',provider,'reasoning']（影响该 provider 全部模型；
 *      pi-ai modelFields 无 reasoning 字段，无法 per-model 设默认档）。
 *  - workbuddy 类（entry=dsh-connect-workbuddy）：
 *      隐藏/显示 = 改 ['regions','cn','enabledModelIds'] 白名单（非空时须至少留一个，否则
 *      host 兜底显示全目录）。默认档 = ['regions','cn','defaultThinkingEfforts',modelId]
 *      （workbuddy 原生 per-model 覆盖）+ 同步 lastCatalog[idx].reasoning.defaultEffort 回显。
 *
 * 可逆真源：state.snapshots（完整目录）+ state.hidden（隐藏集合），见 state.mjs / catalog.mjs。
 */

import { loadState, saveState } from './state.mjs'

const PI_AI_ENTRY = 'llm-pi-ai'
const WORKBUDDY_ENTRY = 'dsh-connect-workbuddy'

function getSettings(ctx) {
  const settings = typeof ctx?.get === 'function' ? ctx.get('settings') : undefined
  if (!settings || typeof settings.mutate !== 'function') {
    throw new Error('settings 服务不可用（ctx.get("settings") 未返回可 mutate 的服务）')
  }
  return settings
}

function findDescriptor(described, entry) {
  if (!Array.isArray(described)) return undefined
  return described.find((d) => d && d.ns === entry)
}

async function describeEntry(settings, entry) {
  const described = await settings.describe()
  const descriptor = findDescriptor(described, entry)
  if (!descriptor) {
    throw new Error(`entry "${entry}" 没有 volatile 字段或不可经 settings 配置`)
  }
  return descriptor
}

function modelId(m) {
  return m?.id ?? m?.model ?? m?.name
}

/**
 * 设置模型可见性。
 * @param {{provider:string, model:string, visible:boolean, kind?:string}} body
 */
export async function setVisibility(ctx, body) {
  const { provider, model, visible } = body
  const kind = body.kind || 'pi-ai'
  const state = await loadState(ctx)

  // 更新插件自持 hidden 集合（可逆真源）。
  const hidden = new Set(state.hidden?.[provider] ?? [])
  if (visible) hidden.delete(model)
  else hidden.add(model)
  state.hidden = state.hidden ?? {}
  state.hidden[provider] = [...hidden]

  const settings = getSettings(ctx)

  if (kind === 'workbuddy') {
    return setWorkbuddyVisibility(ctx, settings, state, provider, model, visible)
  }
  return setPiAiVisibility(ctx, settings, state, provider, visible)
}

/** pi-ai：从快照过滤 hidden，重写 providers.<p>.models 整数组。 */
async function setPiAiVisibility(ctx, settings, state, provider, _visible) {
  const snapshot = state.snapshots?.piAi?.[provider]
  if (!Array.isArray(snapshot)) {
    return { ok: false, error: `尚未建立 ${provider} 的完整目录快照，请先刷新模型列表` }
  }
  const hidden = new Set(state.hidden?.[provider] ?? [])
  const nextModels = snapshot.filter((m) => !(m && hidden.has(m.id)))
  const descriptor = await describeEntry(settings, PI_AI_ENTRY)
  const ops = [{ op: 'set', path: ['providers', provider, 'models'], value: nextModels }]
  await settings.mutate(PI_AI_ENTRY, ops, descriptor.revision)
  await saveState(ctx, state)
  return { ok: true }
}

/** workbuddy：改 regions.cn.enabledModelIds 白名单（非空须至少留一个）。 */
async function setWorkbuddyVisibility(ctx, settings, state, provider, model, visible) {
  const descriptor = await describeEntry(settings, WORKBUDDY_ENTRY)
  const region = descriptor?.value?.regions?.cn
  const snapshot = Array.isArray(state.snapshots?.workbuddy) ? state.snapshots.workbuddy : []
  const allIds = snapshot.map(modelId).filter(Boolean)

  // 现有白名单（空 = 全显示）。隐藏时若原为空，需先按全目录填充再剔除目标，
  // 否则对空名单 filter 得到空会误触「至少留一个」。
  const wasEmpty = !Array.isArray(region?.enabledModelIds) || region.enabledModelIds.length === 0
  let enabled = wasEmpty ? allIds.slice() : [...region.enabledModelIds]
  if (visible) {
    if (!enabled.includes(model)) enabled.push(model)
  } else {
    enabled = enabled.filter((id) => id !== model)
    // 白名单非空时不可清空，否则 host 兜底显示全目录（等于全显示）。
    if (enabled.length === 0 && allIds.length > 1) {
      return { ok: false, error: '至少保留一个可见模型（workbuddy 白名单不可为空）' }
    }
  }

  const ops = [{ op: 'set', path: ['regions', 'cn', 'enabledModelIds'], value: enabled }]
  await settings.mutate(WORKBUDDY_ENTRY, ops, descriptor.revision)
  await saveState(ctx, state)
  return { ok: true }
}

/**
 * 设置默认思考等级。
 *  - pi-ai 类：level 写 provider 级 ['providers',provider,'reasoning']（影响该 provider 全部模型）。
 *  - workbuddy 类：level 写 ['regions','cn','defaultThinkingEfforts',modelId]（per-model），
 *    并同步 lastCatalog[idx].reasoning.defaultEffort 供 UI 回显。
 * @param {{provider:string, model?:string, level:string, kind?:string}} body
 */
export async function setDefaultLevel(ctx, body) {
  const settings = getSettings(ctx)
  const { provider, model, level } = body
  const kind = body.kind || 'pi-ai'
  const entry = kind === 'workbuddy' ? WORKBUDDY_ENTRY : PI_AI_ENTRY

  // 记录用户意图到自持状态。
  const state = await loadState(ctx)
  state.defaults = state.defaults ?? {}
  if (kind === 'workbuddy') {
    state.defaults[provider] = state.defaults[provider] ?? {}
    state.defaults[provider][model] = level
  } else {
    state.defaults[provider] = level
  }
  await saveState(ctx, state)

  const descriptor = await describeEntry(settings, entry)

  let ops
  if (kind === 'workbuddy') {
    const catalog = descriptor?.value?.regions?.cn?.lastCatalog
    if (!Array.isArray(catalog)) {
      return { ok: false, error: `未在 ${entry}.regions.cn.lastCatalog 找到目录数组` }
    }
    const idx = catalog.findIndex((m) => modelId(m) === model)
    if (idx < 0) return { ok: false, error: `未在 workbuddy 目录里找到模型 "${model}"` }
    ops = [
      { op: 'set', path: ['regions', 'cn', 'defaultThinkingEfforts', model], value: level },
      { op: 'set', path: ['regions', 'cn', 'lastCatalog', idx, 'reasoning', 'defaultEffort'], value: level },
    ]
  } else {
    ops = [{ op: 'set', path: ['providers', provider, 'reasoning'], value: level }]
  }

  await settings.mutate(entry, ops, descriptor.revision)
  return { ok: true }
}
