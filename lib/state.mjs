/**
 * dsh-model-selector-config —— 插件自持状态（可逆真源 + 持久化加固，v2.2）。
 *
 * 结构（v2，自包含、与 llm 服务目录解耦）：
 * {
 *   hidden:   { [providerId]: [modelId, ...] },          // 隐藏的模型（可逆，不过滤即恢复）
 *   defaults: { [providerId]: { [modelId]: level } }     // 每模型独立默认思考档
 * }
 *
 * 为什么不再存 snapshots：
 *   v1 的「隐藏」是重写 pi-ai 的 providers.<p>.models / workbuddy 的 enabledModelIds，
 *   真源会被过滤数组污染，必须另存完整快照才能恢复。v2 改为在共享 llm 服务实例上覆盖
 *   listModels() 做可见性过滤、覆盖 resolveModelInfoFor() 注入每模型默认档（见 overlay.mjs），
 *   真源始终是 adapter 自己的目录，插件只记「要过滤谁 / 要覆盖谁」，天然可逆、天然与
 *   模型选择器一致（两者都走 ctx.llm.listModels / resolveModelInfo）。
 *
 * 落盘沿用 dsh-api-rules 惯例：$DSH_HOME/.model-selector-config/state.json，tmp+rename 原子写。
 * 读 env 一律走 ctx.get('env')（Cordis 代理：裸读 ctx.env 未 inject 会抛）。
 *
 * ── v2.2 持久化加固（用户反馈「改完插件配置没保存，只好重弄一次」）────────────────
 *  1) 读-改-写串行化：卡片每次点击都会立即发一个 POST，快速连点会两个请求同时基于同一份
 *     旧 state 各改各的，后写的覆盖先写的 → 部分改动「看起来没保存」。mutateState() 用
 *     按 ctx 分键的异步锁把整段 read-modify-write 排成队列，杜绝 lost update。
 *  2) 唯一 tmp 名：旧版所有写操作共用 state.json.tmp，并发时互相踩踏 / rename ENOENT。
 *  3) 覆盖前留 .bak：任何一次写坏/误删都能回滚；loadState 主文件损坏时自动从 .bak 恢复，
 *     而不是像旧版那样静默返回 EMPTY（那样下一次写就会把配置彻底清空）。
 *  4) 每个进程首次写盘再留一份时间戳快照（最多 5 份），防 .bak 本身也被后续写覆盖。
 *  5) stateInfo() 把落盘路径 / 最后保存时间回显给卡片，让「配置到底存没存」肉眼可查。
 */

import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import {
  readFile, writeFile, mkdir, rename, copyFile, stat, unlink, readdir,
} from 'node:fs/promises'

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

/** 取环境变量表：ctx.get('env') → ctx.env（try/catch 兜代理陷阱）→ process.env。 */
function resolveEnv(ctx) {
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get('env') : undefined
    if (viaGet && typeof viaGet === 'object') return viaGet
  } catch { /* env 服务未注册 */ }
  try {
    if (ctx && typeof ctx === 'object' && ctx.env && typeof ctx.env === 'object') return ctx.env
  } catch { /* Cordis 代理陷阱，忽略 */ }
  return process.env
}

export const EMPTY = Object.freeze({ hidden: {}, defaults: {} })

/**
 * 归一化 / 迁移：
 *  - hidden：保留数组形态（v1 的 hidden 键仍是有效 modelId，直接沿用）。
 *  - defaults：只保留 {modelId:level} 对象形态（v2）。v1 的 provider 级字符串（如
 *    defaults.codearts="max"）是「整平台共用一个档」的旧行为，正是要修掉的 bug，
 *    这里显式丢弃，不迁移成 per-model，避免把「一起动」的旧值又灌回去。
 *  - snapshots：v1 遗留，v2 不再需要，丢弃。
 */
export function normalize(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {}
  const hidden = {}
  if (p.hidden && typeof p.hidden === 'object' && !Array.isArray(p.hidden)) {
    for (const [key, value] of Object.entries(p.hidden)) {
      if (Array.isArray(value)) hidden[key] = value.filter((id) => typeof id === 'string')
    }
  }
  const defaults = {}
  if (p.defaults && typeof p.defaults === 'object' && !Array.isArray(p.defaults)) {
    for (const [key, value] of Object.entries(p.defaults)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const per = {}
        for (const [model, level] of Object.entries(value)) {
          if (typeof level === 'string' && level) per[model] = level
        }
        if (Object.keys(per).length) defaults[key] = per
      }
      // 旧的字符串（provider 级）形态：丢弃
    }
  }
  return { hidden, defaults }
}

/** 主文件坏掉时，退回上一版完好配置；只有「真的没有配置文件」才返回空。 */
export async function loadState(ctx) {
  const target = statePath(resolveEnv(ctx))
  const candidates = [target, target + '.bak']
  for (let i = 0; i < candidates.length; i++) {
    const file = candidates[i]
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw)
      if (i > 0) {
        console.warn(`[model-selector-config] state.json 读取失败，已从 ${basename(file)} 恢复配置`)
      }
      return normalize(parsed)
    } catch (error) {
      if (i === 0 && error?.code !== 'ENOENT') {
        console.warn(`[model-selector-config] state.json 读取/解析失败：${String(error?.message ?? error)}`)
      }
    }
  }
  return { hidden: {}, defaults: {} }
}

let tmpSeq = 0
const snapshotDone = new Set()

/** 每个进程首次写盘留一份时间戳快照，最多保留 5 份（纯保险，失败不影响主流程）。 */
async function sessionSnapshot(target, dir) {
  const key = dirname(target)
  if (snapshotDone.has(key)) return
  snapshotDone.add(key)
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  try { await copyFile(target, `${target}.bak.${ts}`) } catch { return }
  try {
    const all = (await readdir(dir))
      .filter((n) => /^state\.json\.bak\.\d{8}-\d{6}$/.test(n))
      .sort()
    while (all.length > 5) {
      const name = all.shift()
      try { await unlink(join(dir, name)) } catch { /* 忽略 */ }
    }
  } catch { /* 清理失败不影响写入 */ }
}

export async function saveState(ctx, state) {
  const dir = pluginHome(resolveEnv(ctx))
  const target = statePath(resolveEnv(ctx))
  const payload = JSON.stringify(normalize(state), null, 2) + '\n'
  await mkdir(dir, { recursive: true })

  // 覆盖前留下「上一版完好配置」：任何一次写坏/误删都能回滚。
  try { await copyFile(target, target + '.bak') } catch { /* 首次写入没有旧文件 */ }
  try { await sessionSnapshot(target, dir) } catch { /* 快照是保险，失败不阻断 */ }

  // 唯一 tmp 名：避免并发写共用同一个 .tmp 互相踩踏。
  const tmp = `${target}.${process.pid}.${++tmpSeq}.tmp`
  await writeFile(tmp, payload, 'utf8')
  // Windows 上并发 rename 到同一目标、或被杀软/文件监听短暂占用，会抛 EPERM/EBUSY/EACCES。
  // 这类是瞬时共享冲突，短暂退避重试即可，绝不能让一次抖动丢掉用户这次改动。
  let lastError
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rename(tmp, target)
      return target
    } catch (error) {
      lastError = error
      const code = error && error.code
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)))
        continue
      }
      break
    }
  }
  try { await unlink(tmp) } catch { /* 忽略 */ }
  throw lastError
}

/** 供卡片回显：配置存哪、最后保存时间、体积。读不到也不抛。 */
export async function stateInfo(ctx) {
  const target = statePath(resolveEnv(ctx))
  try {
    const st = await stat(target)
    return { path: target, savedAt: st.mtime.toISOString(), size: st.size }
  } catch {
    return { path: target, savedAt: null, size: 0 }
  }
}

const writeLocks = new WeakMap()
const lockFallback = process.env

/**
 * 串行化「读-改-写」，杜绝快速连点造成的 lost update。
 *
 * mutator(state) 可同步/异步；返回 { ok:false, ... } 表示放弃写入（例如「不能把最后一个
 * 可见模型隐藏」的安全护栏），此时不落盘，调用方也不应广播刷新事件。
 */
export async function mutateState(ctx, mutator) {
  const key = ctx && typeof ctx === 'object' ? ctx : lockFallback
  const prev = writeLocks.get(key) || Promise.resolve()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  writeLocks.set(key, gate)
  await prev
  try {
    const state = await loadState(ctx)
    const result = await mutator(state)
    if (result && result.ok === false) return result
    await saveState(ctx, state)
    return result && typeof result === 'object' ? result : { ok: true }
  } finally {
    release()
    if (writeLocks.get(key) === gate) writeLocks.delete(key)
  }
}
