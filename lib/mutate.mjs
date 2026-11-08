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

    // 安全护栏：不允许把某平台的最后一个可见模型也隐藏掉（该平台会从选择器整体消失，
    // 易误以为「配置坏了」）。provider 暂时不可查时跳过护栏，不阻断写入。
    if (!visible) {
      const all = ensureOverlay(ctx) ? await listAllModels(ctx, provider) : null
      if (Array.isArray(all) && all.length > 0) {
        const remaining = all.filter((m) => m && !hidden.has(m.id)).length
        if (remaining === 0) {
          return { ok: false, error: '至少保留一个可见模型（该平台不能全部隐藏）' }
        }
      }
    }
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
