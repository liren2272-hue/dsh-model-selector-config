/**
 * dsh-model-selector-config —— 模型选择器配置插件（宿主侧，v2）。
 *
 * 三个对外路由（客户端卡片依赖，契约保持不变）：
 *   GET  /api/model-selector-config/providers       —— 与模型选择器同源的全部平台 + 模型 + reasoning。
 *   POST /api/model-selector-config/visibility       —— { provider, model, visible }
 *   POST /api/model-selector-config/default-level    —— { provider, model, level }（每模型独立）
 *
 * 生效机制：插件启动时经 ctx.inject(['llm'], ...) 在共享 llm 服务实例上装一层薄覆盖
 * （overlay.mjs）——listModels 过滤隐藏项、resolveModelInfoFor 注入每模型默认档。
 * 覆盖对 pi-ai / workbuddy / qoder / trae 等所有 adapter 一视同仁，自动适配新平台；
 * 模型选择器（buildModelCatalog）、目录回显、真实请求（resolveCallFor）都走这两个方法，
 * 因此「这张表 / 选择器 / 实际发的档」三者天然一致，改动即时生效、无需重启。
 *
 * 零 @deepseek-ai/* 硬依赖：只用 node: 内置模块 + ctx.get() 软取服务。
 * Cordis 代理陷阱：未 inject 的 ctx.<name> 裸读会抛，故一律 ctx.get / ctx.inject。
 * 所有异步挂 .catch，任何异常都不外泄到宿主进程。
 */

export const name = 'dsh-model-selector-config'
export const inject = ['webServer']

const NS = 'model-selector-config'

import { readCatalog } from './catalog.mjs'
import { setVisibility, setDefaultLevel } from './mutate.mjs'
import { ensureOverlay } from './overlay.mjs'
import { stateInfo } from './state.mjs'

function logger(ctx) {
  const log = typeof ctx?.get === 'function' ? ctx.get('logger') : undefined
  return {
    info: (...args) => { try { log?.info?.(...args) } catch {} },
    warn: (...args) => { try { log?.warn?.(...args) } catch {} },
  }
}

function writeJson(response, status, body) {
  const payload = JSON.stringify(body)
  try {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
    })
    response.end(payload)
  } catch { /* 连接已断开，忽略 */ }
}

async function safeJson(request) {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    if (raw.length === 0) return {}
    return JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
}

export async function apply(ctx, _config = {}) {
  const log = logger(ctx)

  // 尽早安装覆盖：llm 服务一就绪就装（幂等），保证隐藏项在模型选择器首次渲染时
  // 就已过滤、每模型默认档在首次请求时即生效，不必等用户打开设置页。
  // 用反应式 ctx.inject 而非静态 inject 数组，避免与 llm 的加载顺序形成依赖死锁。
  try {
    ctx.inject(['llm'], () => {
      try { ensureOverlay(ctx) } catch (error) {
        log.warn?.(`[${NS}] overlay 安装失败：${String(error?.message ?? error)}`)
      }
    })
  } catch (error) {
    log.warn?.(`[${NS}] ctx.inject(llm) 失败：${String(error?.message ?? error)}`)
  }

  const register = (path, handler) => {
    ctx.inject(['webServer'], (webCtx) => {
      try {
        webCtx.webServer.register({ kind: 'exact', path, handler })
      } catch (error) {
        log.warn?.(`[${NS}] 路由注册失败 ${path}：${String(error?.message ?? error)}`)
      }
    })
  }

  // 读：全部平台 + 模型 + reasoning（与模型选择器同源）。
  register(`/api/${NS}/providers`, async (_request, response) => {
    try {
      const catalog = await readCatalog(ctx)
      writeJson(response, 200, { ok: true, ...catalog, storage: await stateInfo(ctx) })
    } catch (error) {
      writeJson(response, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  // 写：可见性。
  register(`/api/${NS}/visibility`, async (request, response) => {
    const body = await safeJson(request)
    if (!body || typeof body.provider !== 'string' || typeof body.model !== 'string' || typeof body.visible !== 'boolean') {
      writeJson(response, 400, { ok: false, error: '需要 provider、model 与 visible' })
      return
    }
    try {
      const result = await setVisibility(ctx, body)
      writeJson(response, result.ok ? 200 : 500, result)
    } catch (error) {
      writeJson(response, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  // 写：默认思考等级（每模型独立，必须带 model）。
  register(`/api/${NS}/default-level`, async (request, response) => {
    const body = await safeJson(request)
    if (!body || typeof body.provider !== 'string' || typeof body.model !== 'string' || typeof body.level !== 'string') {
      writeJson(response, 400, { ok: false, error: '需要 provider、model 与 level' })
      return
    }
    try {
      const result = await setDefaultLevel(ctx, body)
      writeJson(response, result.ok ? 200 : 500, result)
    } catch (error) {
      writeJson(response, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  log.info?.(`[${NS}] 已注册模型选择器配置路由（v2：同源枚举 + 每模型默认档）`)
}
