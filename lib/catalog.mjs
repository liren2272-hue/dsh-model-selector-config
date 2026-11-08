/**
 * dsh-model-selector-config —— 读通道：与「模型选择器」同源枚举全部平台与模型。
 *
 * 数据源（与 dsh-api-session-controller::buildModelCatalog 完全一致）：
 *   llm.listProviders()                      → 所有已注册 adapter 的平台（含 Qoder / trae 等
 *                                              插件动态注册的平台，问题 3 的根因修复）
 *   orig.listModels(provider)                → 该平台全量模型（未经过隐藏过滤，供 UI 恢复隐藏项）
 *   llm.resolveModelInfo(provider, model)    → 该模型真实生效的 reasoning（efforts + defaultEffort）
 *                                              经 overlay 注入后，defaultEffort = 用户为该模型
 *                                              单独设的档；没设过的模型保持各自原生默认（问题 2）。
 *
 * 关键：visible 由 state.hidden 计算，efforts/defaultLevel 由「生效」info 计算，二者互不干扰；
 * 隐藏的模型仍列出（visible:false），点一下即可恢复，天然可逆。任一模型/平台 resolve 失败
 * 只降级该行（efforts 空），不拖垮整张表（Qoder 连不上时平台与模型仍能显示）。
 *
 * 返回形状（客户端卡片）：
 * { ok:true, groups:[ { provider, label, models:[
 *      { id, name, visible, efforts:[level,...], defaultLevel? } ] } ] }
 */

import { loadState } from './state.mjs'
import { ensureOverlay, listAllModels, llmService } from './overlay.mjs'

/** 让每个模型的 resolve 互不阻塞，且不让单个失败冒泡。 */
async function safeResolve(llm, provider, model) {
  try {
    if (!llm || typeof llm.resolveModelInfo !== 'function') return null
    return await llm.resolveModelInfo(provider, model)
  } catch {
    return null
  }
}

export async function readCatalog(ctx) {
  const state = await loadState(ctx)
  const llm = llmService(ctx)
  const handle = ensureOverlay(ctx)

  if (!llm || typeof llm.listProviders !== 'function') {
    return { ok: false, error: 'llm 服务不可用（ctx.get("llm") 未返回 listProviders）' }
  }

  // 平台清单：与模型选择器 buildModelCatalog 的 listProviders() 完全同源。
  let providers
  try {
    providers = llm.listProviders()
  } catch (error) {
    return { ok: false, error: `llm.listProviders 失败：${String(error?.message ?? error)}` }
  }
  if (!Array.isArray(providers)) providers = []

  // displayName 兜底（listConfigurableProviders 含声明但未挂载的平台，仅作标签增强）。
  let displayNames = {}
  try {
    if (typeof llm.listConfigurableProviders === 'function') {
      for (const e of llm.listConfigurableProviders() || []) {
        if (e && typeof e.provider === 'string' && typeof e.displayName === 'string') {
          displayNames[e.provider] = e.displayName
        }
      }
    }
  } catch { /* 标签增强，失败可忽略 */ }

  const groups = []
  for (const provider of providers) {
    const id = provider?.id
    if (typeof id !== 'string' || !id) continue
    // 全量模型（未经隐藏过滤）；provider 暂不可用时跳过，不让整表失败。
    const all = handle ? await listAllModels(ctx, id) : null
    const models = Array.isArray(all) ? all : []
    if (models.length === 0) continue

    const hidden = new Set(state.hidden?.[id] ?? [])
    const infos = await Promise.all(models.map((m) => safeResolve(llm, id, m?.id)))

    const groupModels = models.map((m, i) => {
      const modelId = typeof m?.id === 'string' ? m.id : undefined
      if (!modelId) return null
      const r = infos[i]?.reasoning
      const efforts = Array.isArray(r?.efforts)
        ? r.efforts.map((e) => e?.id).filter((x) => typeof x === 'string' && x)
        : []
      return {
        id: modelId,
        name: typeof m?.name === 'string' && m.name ? m.name : modelId,
        visible: !hidden.has(modelId),
        efforts,
        defaultLevel: r?.defaultEffort ?? undefined,
        // 区分「用户单独设过档」与「只是 adapter 原生默认」：客户端据此把
        // 「跟随默认」显示为选中态，并允许一键清掉覆盖回到原生默认（可逆）。
        hasOverride: typeof state.defaults?.[id]?.[modelId] === 'string' && !!state.defaults[id][modelId],
      }
    }).filter(Boolean)

    groups.push({
      provider: id,
      label: (typeof provider?.name === 'string' && provider.name) || displayNames[id] || id,
      models: groupModels,
    })
  }

  return { ok: true, groups }
}
