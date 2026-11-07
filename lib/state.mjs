/**
 * dsh-model-selector-config —— 插件自持状态（快照 / hidden / defaults）。
 *
 * 惯例（学 dsh-api-rules）：自建 JSON 文件放 $DSH_HOME（env['DSH_HOME'] 或 ~/.dsh）下
 * 插件私有目录，tmp/rename 原子写。不用 settings 服务（那是 Config-schema 表单，非 KV）。
 *
 * 结构：
 * {
 *   snapshots: {
 *     piAi:     { [providerId]: [完整 model 对象,...] },  // pi-ai models 完整目录快照
 *     workbuddy:[完整 catalog 对象,...]                    // workbuddy lastCatalog 快照
 *   },
 *   hidden:   { [providerId]: [modelId, ...] },   // 被隐藏的模型（可逆真源）
 *   defaults: { [providerId]: level | { [modelId]: level } }  // 用户设的默认档意图
 * }
 *
 * 【为什么需要 snapshots】pi-ai 的「隐藏」是重写 providers.<p>.models 为过滤数组，而该数组
 * 正是 readCatalog 读完整目录的同一来源。若不另存快照，隐藏的模型会从真源消失、永远无法恢复。
 * 所以：首次 describe 读全量建立快照；之后 describe 只用来补全新增模型（merge，快照没有的才加，
 * 隐藏的不从快照删）。hidden 过滤只在写回生效数组时做。显示=写回完整快照、隐藏=写回过滤快照，
 * 二者都可逆。
 * workbuddy 不需要 models 快照做可见性（走 enabledModelIds 白名单，lastCatalog 不被过滤），
 * 但仍存一份 catalog 快照以便 UI 稳定 + 补全新模型。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'

function dshHome(env = process.env) {
  const explicit = env['DSH_HOME']
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  return join(homedir(), '.dsh')
}

function pluginHome(env = process.env) {
  return join(dshHome(env), '.model-selector-config')
}

function statePath(env = process.env) {
  return join(pluginHome(env), 'state.json')
}

/**
 * 取环境变量表。
 *
 * 真实宿主里 ctx 是 Cordis 代理：未 inject 的 `ctx.env` 裸读会抛
 * `cannot get property "env" without inject`（ReflectService 的 proxy trap），
 * 所以优先走 `ctx.get('env')`；离线自测的 ctx 是普通对象，`ctx.env` 直接可用，
 * 用 try/catch 兜住；都没有就退回 process.env。
 */
function resolveEnv(ctx) {
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get('env') : undefined
    if (viaGet && typeof viaGet === 'object') return viaGet
  } catch { /* env 服务未注册，继续兜底 */ }
  try {
    if (ctx && typeof ctx === 'object' && ctx.env && typeof ctx.env === 'object') return ctx.env
  } catch { /* Cordis 代理陷阱：未 inject 的 ctx.env 裸读会抛，忽略 */ }
  return process.env
}

const EMPTY = Object.freeze({ snapshots: { piAi: {}, workbuddy: [] }, hidden: {}, defaults: {} })

export async function loadState(ctx) {
  const env = resolveEnv(ctx)
  try {
    const raw = await readFile(statePath(env), 'utf8')
    const parsed = JSON.parse(raw)
    return normalize(parsed)
  } catch {
    return { snapshots: { piAi: {}, workbuddy: [] }, hidden: {}, defaults: {} }
  }
}

function normalize(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {}
  const snap = p.snapshots && typeof p.snapshots === 'object' ? p.snapshots : {}
  return {
    snapshots: {
      piAi: snap.piAi && typeof snap.piAi === 'object' ? snap.piAi : {},
      workbuddy: Array.isArray(snap.workbuddy) ? snap.workbuddy : [],
    },
    hidden: p.hidden && typeof p.hidden === 'object' ? p.hidden : {},
    defaults: p.defaults && typeof p.defaults === 'object' ? p.defaults : {},
  }
}

export async function saveState(ctx, state) {
  const env = resolveEnv(ctx)
  const dir = pluginHome(env)
  const target = statePath(env)
  const n = normalize(state)
  const payload = JSON.stringify(n, null, 2)
  await mkdir(dir, { recursive: true })
  const tmp = target + '.tmp'
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, target)
  return target
}
