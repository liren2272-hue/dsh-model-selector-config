/**
 * dsh-model-selector-config —— 模型选择器配置插件（宿主侧）。
 *
 * 职责：
 *  - 经 webServer 暴露两条只读路由，把当前各 provider 的模型清单（含 reasoning 可选档 +
 *    默认档）读给设置卡片：
 *      GET /api/model-selector-config/providers   —— 全部 provider + 模型 + reasoning。
 *  - 暴露写路由，把卡片的「可见性 / 默认思考等级」改动经 settings 服务热写回 provider
 *    entry（volatile 字段，无需重启）：
 *      POST /api/model-selector-config/visibility      —— { provider, model, visible }
 *      POST /api/model-selector-config/default-level   —— { provider, model?, level }
 *
 * 写通道统一走 `ctx.get('settings').mutate(entry, ops, expectedRevision)`：
 *  - pi-ai 类 entry = 'llm-pi-ai'，providers 整体 volatile，默认档是 provider 级单值
 *    `reasoning`，隐藏模型 = 从 models 数组移除该条目。
 *  - workbuddy 类 entry = 'dsh-connect-workbuddy'，regions.<r>.lastCatalog[]，默认档是
 *    per-model `reasoning.defaultEffort`，隐藏 = 从 lastCatalog 移除该条目。
 *
 * 零 @deepseek-ai/* 硬依赖：只用 node: 内置模块 + ctx.get() 软取服务。所有异步挂 .catch，
 * 任何异常都不外泄到宿主进程（Cordis 代理陷阱：未 inject 的 ctx.<name> 裸读会抛，故一律 ctx.get）。
 */

export const name = 'dsh-model-selector-config'
export const inject = ['webServer']

const NS = 'model-selector-config'
const PI_AI_ENTRY = 'llm-pi-ai'
const WORKBUDDY_ENTRY = 'dsh-connect-workbuddy'

function logger(ctx) {
  const log = typeof ctx?.get === 'function' ? ctx.get('logger') : undefined
  return {
    info: (...args) => log?.info?.(...args),
    warn: (...args) => log?.warn?.(...args),
    error: (...args) => log?.error?.(...args),
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
  } catch {
    /* 连接已断开，忽略 */
  }
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

/* ------------------------------------------------------------------ *
 * 读通道：读当前 provider / 模型 / reasoning 清单。
 * 数据源优先用 llm 服务的模型目录（真实生效值），回退到 settings.describe。
 * 实现见 lib/catalog.mjs（待子代理确认 API 后定稿）。
 * ------------------------------------------------------------------ */
import { readCatalog } from './catalog.mjs'

/* ------------------------------------------------------------------ *
 * 写通道：经 settings.mutate 热改 provider entry。
 * 实现见 lib/mutate.mjs。
 * ------------------------------------------------------------------ */
import { setVisibility, setDefaultLevel } from './mutate.mjs'

export async function apply(ctx, _config = {}) {
  const log = logger(ctx)

  const register = (path, handler) => {
    ctx.inject(['webServer'], (webCtx) => {
      try {
        webCtx.webServer.register({ kind: 'exact', path, handler })
      } catch (error) {
        log.warn?.(`[${NS}] 路由注册失败 ${path}：${String(error?.message ?? error)}`)
      }
    })
  }

  // 读：全部 provider + 模型 + reasoning。
  register(`/api/${NS}/providers`, async (_request, response) => {
    try {
      const catalog = await readCatalog(ctx)
      writeJson(response, 200, { ok: true, ...catalog })
    } catch (error) {
      writeJson(response, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  // 写：可见性。
  register(`/api/${NS}/visibility`, async (request, response) => {
    const body = await safeJson(request)
    if (!body || typeof body.provider !== 'string' || typeof body.model !== 'string') {
      writeJson(response, 400, { ok: false, error: '需要 provider 与 model' })
      return
    }
    try {
      const result = await setVisibility(ctx, body)
      writeJson(response, result.ok ? 200 : 500, result)
    } catch (error) {
      writeJson(response, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  // 写：默认思考等级。
  register(`/api/${NS}/default-level`, async (request, response) => {
    const body = await safeJson(request)
    if (!body || typeof body.provider !== 'string' || typeof body.level !== 'string') {
      writeJson(response, 400, { ok: false, error: '需要 provider 与 level' })
      return
    }
    try {
      const result = await setDefaultLevel(ctx, body)
      writeJson(response, result.ok ? 200 : 500, result)
    } catch (error) {
      writeJson(response, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  log.info?.(`[${NS}] 已注册模型选择器配置路由`)
}
