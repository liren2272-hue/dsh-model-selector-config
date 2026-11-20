/**
 * dsh-model-selector-config —— 写通道：只改插件自持状态，不碰任何 adapter 配置。
 *
 * v2 与 v1 的根本区别：
 *   v1 把「隐藏 / 默认档」经 settings.mutate 写进各 adapter 的 volatile 字段
 *   （pi-ai providers.<p>.models / reasoning，workbuddy enabledModelIds / defaultThinkingEfforts）。
 *   这既导致「只认得两个硬编码 entry」（问题 3），又受 pi-ai 只有 provider 级
 *   reasoning 字段所限而「同平台所有模型一起动」（问题 2）。
 *   v2 改为把意图写进自己的 state.json，由 overlay.mjs 在共享 llm 服务的
 *   listModels / resolveModelInfoFor 上生效——对所有 adapter 一视同仁、每模型独立、
 *   可逆、且与模型选择器 / 实际请求同源。
 *
 * v2.2：写操作统一走 state.mutateState() 串行化「读-改-写」，杜绝快速连点时的
 * lost update（用户反馈「改完插件配置没保存，只好重弄一次」的直接根因之一）。
 * 护栏 / 校验失败由 mutator 返回 {ok:false} 放弃写入，不落盘也不广播刷新事件。
 *
 * 兼容：body.kind（旧客户端会传）被忽略；body.model 对 default-level 为必需（每模型）。
 */

import { mutateState } from './state.mjs'
import { ensureOverlay, bumpOverlay, emitAdaptersUpdated, listAllModels } from './overlay.mjs'

/**
 * 设置模型可见性。
 * @param {{provider:string, model:string, visible:boolean, kind?:string}} body
 */
export async function setVisibility(ctx, body) {
  const { provider, model, visible } = body
  const result = await mutateState(ctx, async (state) => {
    const hidden = new Set(state.hidden?.[provider] ?? [])
    if (visible) hidden.delete(model)
    else hidden.add(model)
    state.hidden = state.hidden ?? {}
    state.hidden[provider] = [...hidden]
    // v2.4：移除「至少保留一个可见模型」护栏——用户可整平台隐藏（平台级批量开关
    // 与全局 allVisible 随时恢复），hidden 数据原样保留，完全可逆。
    return { ok: true }
  })
  if (result && result.ok) {
    bumpOverlay()
    emitAdaptersUpdated(ctx)
  }
  return result
}

/**
 * 设置某模型的默认思考等级（每模型独立，互不牵连）。
 * @param {{provider:string, model:string, level:string, kind?:string}} body
 */
export async function setDefaultLevel(ctx, body) {
  const { provider, model, level } = body
  if (typeof model !== 'string' || !model) {
    return { ok: false, error: '需要 model（默认档按模型独立设置）' }
  }
  const result = await mutateState(ctx, async (state) => {
    state.defaults = state.defaults ?? {}
    const per = { ...(state.defaults[provider] ?? {}) }
    // level==='auto' = 「跟随默认」：清掉该模型的覆盖，回到 adapter 原生默认档。
    if (level === 'auto') delete per[model]
    else per[model] = level
    if (Object.keys(per).length === 0) delete state.defaults[provider]
    else state.defaults[provider] = per
    return { ok: true }
  })
  if (result && result.ok) {
    bumpOverlay()
    emitAdaptersUpdated(ctx)
  }
  return result
}

/**
 * v2.3 全局「显示全部」开关。只切一个布尔，hidden / defaults 数据一律不动：
 * 打开 = overlay.listModels 不再按 hidden 过滤（模型库全部可见），
 * 关闭 = 立刻恢复原来的隐藏配置，完全可逆。
 * @param {{allVisible:boolean}} body
 */
export async function setAllVisible(ctx, body) {
  if (typeof body?.allVisible !== 'boolean') {
    return { ok: false, error: '需要 allVisible（布尔）' }
  }
  const allVisible = body.allVisible
  const result = await mutateState(ctx, async (state) => {
    state.allVisible = allVisible
    return { ok: true, allVisible }
  })
  if (result && result.ok) {
    bumpOverlay()
    emitAdaptersUpdated(ctx)
  }
  return result
}

/**
 * v2.4 平台级批量「全部隐藏 / 全部显示」。
 *   visible=false：把该 provider 的全部模型（listAllModels 取未经隐藏过滤的全量）
 *                 写进 hidden[provider]，整个平台从选择器消失；
 *   visible=true ：清空 hidden[provider]，该平台所有模型恢复显示。
 * 只动这一个平台的 hidden 数组，其他平台 / defaults / allVisible 一律不碰，可逆。
 * @param {{provider:string, visible:boolean}} body
 */
export async function setProviderVisibility(ctx, body) {
  if (typeof body?.provider !== 'string' || !body.provider) {
    return { ok: false, error: '需要 provider（字符串）' }
  }
  if (typeof body?.visible !== 'boolean') {
    return { ok: false, error: '需要 visible（布尔）' }
  }
  const { provider, visible } = body
  // visible=false 需要该平台全量模型清单，先取（取不到就不写，避免留下不完整状态）。
  let allIds = null
  if (!visible) {
    const all = ensureOverlay(ctx) ? await listAllModels(ctx, provider) : null
    if (!Array.isArray(all)) {
      return { ok: false, error: `无法获取 ${provider} 的模型清单（平台暂不可查）` }
    }
    allIds = all.map((m) => m && m.id).filter((id) => typeof id === 'string' && id)
  }
  const result = await mutateState(ctx, async (state) => {
    state.hidden = state.hidden ?? {}
    if (visible) {
      delete state.hidden[provider]
    } else {
      state.hidden[provider] = [...allIds]
    }
    return { ok: true, provider, visible }
  })
  if (result && result.ok) {
    bumpOverlay()
    emitAdaptersUpdated(ctx)
  }
  return result
}
