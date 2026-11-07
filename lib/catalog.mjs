/**
 * dsh-model-selector-config —— 读通道：读当前各 provider 的模型清单 + reasoning。
 *
 * 数据源：
 *  - settings.describe()：读 entry 声明的 providers/lastCatalog。仅用于 **补全新增模型** 到快照
 *    （快照里没有的才加）。绝不用被过滤的 live 数组当完整目录来源（会破坏可逆性，见 state.mjs）。
 *  - state.snapshots：pi-ai / workbuddy 的完整模型目录快照（首次 describe 读全量建立）。
 *    这是 UI 可操作基础，含隐藏项。
 *  - llm.resolveModelInfo(provider, model)（进程内直调，非 Remote）：读真实生效的
 *    reasoning.defaultEffort。用于 UI 回显当前默认档。失败降级。
 *  - state.hidden：算每模型 visible 标记（快照全部返回，hidden 的标 visible:false）。
 *
 * 返回形状（给客户端卡片）：
 * { ok:true, groups: [ { provider, label, kind, reasoningLevels?, models:[
 *      { id, name, visible, efforts:[level,...], defaultLevel? } ] } ] }
 */

import { loadState, saveState } from './state.mjs'

const PI_AI_ENTRY = 'llm-pi-ai'
const WORKBUDDY_ENTRY = 'dsh-connect-workbuddy'
/** pi-ai 的 THINKING_LEVELS（档位全集，供 provider 级默认档下拉用）。 */
const PI_AI_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function getSettings(ctx) {
  return typeof ctx?.get === 'function' ? ctx.get('settings') : undefined
}

function getLlm(ctx) {
  return typeof ctx?.get === 'function' ? ctx.get('llm') : undefined
}

function findDescriptor(described, entry) {
  return Array.isArray(described) ? described.find((d) => d && d.ns === entry) : undefined
}

/** 读 llm 某 provider 某模型的生效 reasoning。失败返回 undefined。 */
async function resolveReasoning(llm, provider, model) {
  if (!llm || typeof llm.resolveModelInfo !== 'function') return undefined
  try {
    const info = await llm.resolveModelInfo(provider, model)
    const r = info?.reasoning
    if (!r) return undefined
    return {
      efforts: Array.isArray(r.efforts) ? r.efforts.map((e) => e?.id).filter(Boolean) : [],
      defaultEffort: r.defaultEffort,
    }
  } catch {
    return undefined
  }
}

/** 从声明的 reasoningEfforts 键回退出可选档列表。 */
function declaredEfforts(model) {
  const declared = model?.reasoningEfforts
  return declared && typeof declared === 'object' && !Array.isArray(declared) ? Object.keys(declared) : []
}

export async function readCatalog(ctx) {
  const settings = getSettings(ctx)
  const llm = getLlm(ctx)
  if (!settings || typeof settings.describe !== 'function') {
    return { ok: false, error: 'settings 服务不可用' }
  }

  let described = []
  try {
    described = await settings.describe()
  } catch (error) {
    return { ok: false, error: `settings.describe 失败：${String(error?.message ?? error)}` }
  }

  const state = await loadState(ctx)
  let stateDirty = false

  // ---- pi-ai 类：merge live providers → 快照（只补新增，不删隐藏）----
  const piDescriptor = findDescriptor(described, PI_AI_ENTRY)
  const providers = piDescriptor?.value?.providers
  if (providers && typeof providers === 'object') {
    state.snapshots.piAi = state.snapshots.piAi ?? {}
    for (const [providerId, profile] of Object.entries(providers)) {
      const liveModels = Array.isArray(profile?.models) ? profile.models : []
      const snap = Array.isArray(state.snapshots.piAi[providerId]) ? state.snapshots.piAi[providerId] : []
      const snapIds = new Set(snap.map((m) => m?.id).filter(Boolean))
      for (const m of liveModels) {
        if (m && typeof m.id === 'string' && !snapIds.has(m.id)) {
          snap.push({ ...m })
          snapIds.add(m.id)
          stateDirty = true
        }
      }
      state.snapshots.piAi[providerId] = snap
    }
  }

  // ---- workbuddy：merge live lastCatalog → 快照 ----
  const wbDescriptor = findDescriptor(described, WORKBUDDY_ENTRY)
  const liveCatalog = wbDescriptor?.value?.regions?.cn?.lastCatalog
  if (Array.isArray(liveCatalog)) {
    const snap = Array.isArray(state.snapshots.workbuddy) ? state.snapshots.workbuddy : []
    const snapIds = new Set(snap.map((m) => m?.id).filter(Boolean))
    for (const m of liveCatalog) {
      const id = m?.id ?? m?.model ?? m?.name
      if (id && typeof id === 'string' && !snapIds.has(id)) {
        snap.push({ ...m })
        snapIds.add(id)
        stateDirty = true
      }
    }
    state.snapshots.workbuddy = snap
  }

  if (stateDirty) await saveState(ctx, state)

  const groups = []

  // ---- 组装 pi-ai 分组（快照为真源，visible 从 hidden 集合算）----
  for (const [providerId, snap] of Object.entries(state.snapshots.piAi)) {
    if (!Array.isArray(snap) || snap.length === 0) continue
    const hidden = new Set(state.hidden?.[providerId] ?? [])
    const liveGroup = providers?.[providerId]
    const liveList = await Promise.all(
      snap.map((m) => (m && typeof m.id === 'string' ? resolveReasoning(llm, providerId, m.id) : Promise.resolve(undefined))),
    )
    const groupModels = []
    snap.forEach((m, i) => {
      if (!m || typeof m.id !== 'string') return
      const live = liveList[i]
      let efforts = live?.efforts
      if (!efforts || efforts.length === 0) efforts = declaredEfforts(m)
      groupModels.push({
        id: m.id,
        name: m.name || m.id,
        visible: !hidden.has(m.id),
        efforts,
        defaultLevel: live?.defaultEffort ?? undefined,
      })
    })
    groups.push({
      provider: providerId,
      label: liveGroup?.displayName || providerId,
      kind: 'pi-ai',
      reasoningLevels: PI_AI_LEVELS,
      models: groupModels,
    })
  }

  // ---- 组装 workbuddy 分组 ----
  const wbSnap = state.snapshots.workbuddy
  if (Array.isArray(wbSnap) && wbSnap.length > 0) {
    const providerId = 'workbuddy'
    const enabled = wbDescriptor?.value?.regions?.cn?.enabledModelIds
    const enabledSet = Array.isArray(enabled) && enabled.length > 0 ? new Set(enabled) : null
    const hidden = new Set(state.hidden?.[providerId] ?? [])
    const groupModels = []
    for (const m of wbSnap) {
      const id = m?.id ?? m?.model ?? m?.name
      if (!id || typeof id !== 'string') continue
      const r = m?.reasoning
      const efforts = Array.isArray(r?.supportedEfforts) ? r.supportedEfforts : []
      const visible = hidden.has(id) ? false : enabledSet ? enabledSet.has(id) : true
      groupModels.push({
        id,
        name: m?.name || id,
        visible,
        efforts,
        defaultLevel: r?.defaultEffort ?? undefined,
      })
    }
    groups.push({
      provider: providerId,
      label: 'Workbuddy',
      kind: 'workbuddy',
      reasoningLevels: undefined,
      models: groupModels,
    })
  }

  return { ok: true, groups }
}
