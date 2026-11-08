/**
 * dsh-model-selector-config —— 在共享 llm 服务实例上装一层薄覆盖（overlay）。
 *
 * 为什么不写各 adapter 的 settings.mutate（v1 做法）：
 *   - pi-ai / workbuddy / qoder / trae 的「隐藏」「默认档」字段名、路径、key 类型全不一样，
 *     硬编码两个 entry 既不可扩展（问题 3：Qoder 等注册的平台没显示）、又强迫「同一平台
 *     共用一个档」（问题 2：pi-ai 只有 provider 级 reasoning 字段，无法表达 per-model）。
 *   - 覆盖统一在 llm 服务的两个读方法上做，任何 adapter 一视同仁、自动适配。
 *
 * 两个覆盖点（都经 ctx.get('llm') 取到的同一实例；模型选择器 buildModelCatalog 与
 * session 发送路径 resolveCallFor 也都走这两个方法，所以表、选择器、实际请求天然一致）：
 *   1) listModels(provider)            —— 过滤掉 hidden[provider] 里的模型（隐藏=不进选择器）。
 *   2) resolveModelInfoFor(reg,model)  —— 注入 defaults[provider][model] 作为该模型的
 *      defaultEffort。它是 resolveModelInfo() 与 resolveCallFor() 的共同下游，注入一次，
 *      目录回显与真实请求都生效；且 pi-ai 的 modelFields 无 per-model 字段的限制被绕过。
 *
 * 可逆真源：adapter 自己的目录永不改。插件只记「过滤谁 / 覆盖谁」（state.json），
 * 原始方法保存在 handle.orig，readCatalog 用 orig.listModels 取全量（含隐藏项）供 UI 恢复。
 *
 * 全部 try/catch 兜底：llm 服务缺失、方法缺失、state 读取失败都退化为「不覆盖」，
 * 绝不让插件把宿主带崩。写操作后调 emitAdaptersUpdated() 让客户端选择器刷新。
 */

import { loadState } from './state.mjs'

const OVERLAY_KEY = Symbol.for('@local/dsh-model-selector-config/overlay')

/**
 * 进程内 state 缓存：resolveModelInfoFor 每次调用都要读，缓存避免重复磁盘 I/O。
 * 按 ctx 身份分键（宿主里 ctx 恒定；离线自测可同时存在多套 fake 系统互不串味），
 * 全局 generation 让任何写操作（bumpOverlay）一次性作废所有缓存。
 */
let generation = 0
const stateCache = new WeakMap()
export function bumpOverlay() { generation++ }

async function currentState(ctx) {
  const key = ctx && typeof ctx === 'object' ? ctx : process.env
  const entry = stateCache.get(key)
  if (entry && entry.generation === generation) return entry.state
  const state = await loadState(ctx)
  stateCache.set(key, { generation, state })
  return state
}

export function llmService(ctx) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get('llm') : undefined
  } catch {
    return undefined
  }
}

/**
 * 幂等安装覆盖。返回 handle { llm, orig, ctx }；不可用返回 null。
 * orig.listModels / orig.resolveModelInfoFor 是未包装的原始方法（readCatalog 取全量用）。
 */
export function ensureOverlay(ctx) {
  const llm = llmService(ctx)
  if (!llm) return null
  if (llm[OVERLAY_KEY]) return llm[OVERLAY_KEY]
  if (typeof llm.listModels !== 'function' || typeof llm.resolveModelInfoFor !== 'function') return null

  const orig = {
    listModels: llm.listModels,
    resolveModelInfoFor: llm.resolveModelInfoFor,
  }
  const handle = { llm, orig, ctx }
  Object.defineProperty(llm, OVERLAY_KEY, { value: handle, configurable: true, enumerable: false })

  // (1) 可见性过滤
  llm.listModels = async function (provider) {
    const all = await orig.listModels.call(this, provider)
    try {
      const hidden = new Set((await currentState(ctx)).hidden?.[provider] ?? [])
      if (hidden.size === 0) return all
      return all.filter((m) => m && !hidden.has(m.id))
    } catch {
      return all /* state 读失败 → 不隐藏，保守 */
    }
  }

  // (2) 每模型独立默认档注入
  llm.resolveModelInfoFor = async function (registration, model, signal) {
    const info = await orig.resolveModelInfoFor.call(this, registration, model, signal)
    try {
      const provider = registration?.provider?.id
      const level = (await currentState(ctx)).defaults?.[provider]?.[model]
      if (!level || !info?.reasoning?.efforts) return info
      // 只对「该模型确实支持这个档」注入，避免注入非法档导致 UNSUPPORTED_REASONING_EFFORT。
      if (!info.reasoning.efforts.some((e) => e && e.id === level)) return info
      return { ...info, reasoning: { ...info.reasoning, defaultEffort: level } }
    } catch {
      return info /* state 读失败 → 用原生默认，保守 */
    }
  }

  return handle
}

/** 通知客户端模型选择器刷新（官方 registerAdapter 提交后也是发这个事件）。 */
export function emitAdaptersUpdated(ctx) {
  const llm = llmService(ctx)
  try {
    if (llm && typeof llm.emitAdaptersUpdated === 'function') llm.emitAdaptersUpdated()
  } catch {
    /* 事件桥不可用时静默，不影响写操作本身 */
  }
}

/** readCatalog 用：取某 provider 的全量模型（未经隐藏过滤）。 */
export async function listAllModels(ctx, provider) {
  const handle = ensureOverlay(ctx)
  if (!handle) return null
  try {
    return await handle.orig.listModels.call(handle.llm, provider)
  } catch {
    return null /* provider 暂不可用 → 跳过该分组 */
  }
}
