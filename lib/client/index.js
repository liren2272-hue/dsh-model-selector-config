/**
 * dsh-model-selector-config —— 客户端设置卡片（v2，oil 重设计）。
 *
 * 设计北极星：让「模型选择器」这张配置表和真正的选择器看起来同源、可信、可逐模型独立控制，
 * 深色/浅色都由真实 --dsw-* token 自动翻转，卡片本身不写任何主题色覆盖。
 *
 * 与 v1 的关键差别（对应用户四个问题）：
 *  - 平台清单来自服务端 readCatalog（同源枚举 llm.listProviders），Qoder/trae 等插件注册
 *    的平台自动出现（问题 3）；客户端不再认识任何硬编码 provider。
 *  - 默认档是每模型独立的一个 <select>，互相不牵连（问题 2）；「使用原生默认」显示该模型
 *    当前实际生效的档位，选它即清除自定义覆盖、回到原生默认。
 *  - 只用真实 token、focus 用非透明 token、小字号用 secondary 保证浅色对比度（问题 1）。
 *  - 全新视觉：logo / 工具条 / 搜索 / 分组 / 每模型开关 + 等级下拉 / 状态机 / 说明脚注（问题 4）。
 *
 * 交互契约（据独立 UX 评审修正）：
 *  - 每次改动即时自动保存（POST 成功后重新 GET 回填），搜索只是纯过滤、绝不丢失编辑；
 *  - 状态芯片诚实：读取中 / 已同步 / 保存中 / 保存失败；不谎称「已同步」；
 *  - 整条分组头可折叠（aria-expanded + 键盘可用）；**默认全部折叠**（平台太多），手动展开的
 *    选择跨搜索保留；搜索时命中的分组自动展开便于直接看结果；另有「全部展开/全部折叠」一键按钮；
 *  - 隐藏行的等级下拉保持可用（可预配置），用「已隐藏」标签明示状态，不再用 bare disabled；
 *  - 图例说明开关与下拉各管什么。
 *
 * 纯 React DOM（createElement，非 JSX）+ 组件级 <style>；t(key) 是函数、扁平点号 key。
 */
;(function () {
  'use strict'
  if (typeof window === 'undefined' || !window.__ModuleLoader__) return

  window.__ModuleLoader__.load({
    id: '@local/dsh-model-selector-config',
    factory: function (require) {
      const React = require('react')

      const inject = ['slots', 'locale']
      const name = 'dsh-model-selector-config'

      /* ---------------- i18n（扁平点号 key；t(key, vars) 是函数） ---------------- */
      const zh = {
        'title': '模型选择器配置',
        'desc': '与模型选择器同源显示全部平台；逐个模型独立控制「是否在选择器中显示」以及「默认思考等级」。',
        'legend': '开关 = 是否在选择器中显示　·　右侧 = 默认思考等级',
        'search': '搜索平台或模型…',
        'reload': '重新读取',
        'reloadTitle': '重新从模型选择器读取（改动已自动保存）',
        'status.loading': '读取中…',
        'status.synced': '已同步',
        'status.saving': '保存中…',
        'status.error': '保存失败',
        'status.loadError': '读取失败',
        'count.platforms': '个平台',
        'count.models': '个模型',
        'count.hidden': '个已隐藏',
        'count.enabled': '已开启',
        'storage.saved': '配置已保存',
        'storage.never': '尚未保存配置',
        'storage.last': '最后保存',
        'storage.title': '配置落盘位置',
        'visible.of': '显示',
        'fold.show': '展开',
        'fold.hide': '折叠',
        'foldAll.expand': '全部展开',
        'foldAll.collapse': '全部折叠',
        'switch.show': '在选择器中显示',
        'switch.hide': '在选择器中隐藏',
        'level.auto': '使用原生默认',
        'level.custom': '已自定义',
        'level.customTitle': '该模型的默认档为你单独设定；选「使用原生默认」可清除自定义',
        'level.none': '该模型不提供思考等级',
        'hidden.tag': '已隐藏',
        'foot': '每个模型的默认等级彼此独立，改一个不会带动其他模型；选「使用原生默认」即清除自定义、恢复该模型原生档位。改动即时生效。',
        'notice.saved': '已自动保存',
        'notice.hidden': '已隐藏',
        'notice.shown': '已显示',
        'notice.restored': '已恢复原生默认',
        'err.load': '读取失败',
        'err.save': '保存失败',
        'empty': '没有匹配的平台或模型',
        'lv.off': '关闭',
        'lv.minimal': '极简',
        'lv.low': '低',
        'lv.medium': '中',
        'lv.high': '高',
        'lv.xhigh': '较高',
        'lv.max': '最高',
      }
      const en = {
        'title': 'Model Selector Settings',
        'desc': 'Shows every platform from the same source as the model selector. Independently control, per model, whether it appears in the selector and its default thinking level.',
        'legend': 'Toggle = show in the selector　·　Right = default thinking level',
        'search': 'Search platforms or models…',
        'reload': 'Reload',
        'reloadTitle': 'Re-read from the model selector (changes are auto-saved)',
        'status.loading': 'Loading…',
        'status.synced': 'Synced',
        'status.saving': 'Saving…',
        'status.error': 'Save failed',
        'status.loadError': 'Load failed',
        'count.platforms': 'platforms',
        'count.models': 'models',
        'count.hidden': 'hidden',
        'count.enabled': 'Enabled',
        'storage.saved': 'Config saved',
        'storage.never': 'Config not saved yet',
        'storage.last': 'Last saved',
        'storage.title': 'Config file location',
        'visible.of': 'shown',
        'fold.show': 'Expand',
        'fold.hide': 'Collapse',
        'foldAll.expand': 'Expand all',
        'foldAll.collapse': 'Collapse all',
        'switch.show': 'Show in the selector',
        'switch.hide': 'Hide from the selector',
        'level.auto': 'Use native default',
        'level.custom': 'Customized',
        'level.customTitle': 'You set this model’s default level yourself; choose "Use native default" to clear it',
        'level.none': 'No thinking levels for this model',
        'hidden.tag': 'Hidden',
        'foot': 'Each model’s default level is independent — changing one never moves the others. Choosing "Use native default" clears your override and restores the native level. Changes apply instantly.',
        'notice.saved': 'Saved automatically',
        'notice.hidden': 'Hidden',
        'notice.shown': 'Shown',
        'notice.restored': 'Restored native default',
        'err.load': 'Load failed',
        'err.save': 'Save failed',
        'empty': 'No matching platforms or models',
        'lv.off': 'Off',
        'lv.minimal': 'Minimal',
        'lv.low': 'Low',
        'lv.medium': 'Medium',
        'lv.high': 'High',
        'lv.xhigh': 'Extra high',
        'lv.max': 'Max',
      }

      function apply(ctx) {
        try {
          const namespace = 'settings.model-selector-config'
          ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-model-selector-config: copy')
          const t = ctx.locale.bind(namespace)
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              { name: 'plugins.bundle.config', key: '@local/dsh-model-selector-config', locale: namespace },
              function () {
                return React.createElement(ModelSelectorCard, { React: React, t: t })
              },
            ),
          )
        } catch (e) {
          console.error('[dsh-model-selector-config] client apply failed:', e)
        }
      }

      return { apply, inject, name }
    },
  })

  /* ================================================================== *
   * CSS：只用 app.asar 里真实存在的 --dsw-* token（带兜底），深浅色靠
   * body / body[data-ds-dark-theme] 的 token 翻转，本卡片不写主题覆盖。
   * ================================================================== */
  var CSS = [
    '.msc-root{color:var(--dsw-alias-label-primary,CanvasText);font-family:inherit;font-size:13px;line-height:1.5}',
    '.msc-card{',
    '  background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2,transparent));',
    '  border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4,transparent));',
    '  border-radius:var(--dsw-radius-xl,20px);padding:20px 22px 16px;',
    '}',
    '.msc-head{display:flex;align-items:flex-start;gap:13px}',
    '.msc-logo{flex:none;width:40px;height:40px;border-radius:var(--dsw-radius-lg,16px);display:flex;align-items:center;justify-content:center;',
    '  background:var(--dsw-alias-state-business-tertiary,#e4edfd);color:var(--dsw-alias-state-business-primary,#4176e6)}',
    '.msc-logo svg{width:22px;height:22px;display:block}',
    '.msc-headtxt{min-width:0;flex:1}',
    '.msc-title{margin:1px 0 3px;font-size:16px;font-weight:600;letter-spacing:-.01em;color:var(--dsw-alias-label-primary,CanvasText)}',
    '.msc-desc{margin:0;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.msc-headact{display:flex;align-items:center;gap:8px;flex:none;padding-top:2px}',
    '.msc-sync{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:11.5px;',
    '  color:var(--dsw-alias-label-secondary,#61666b);border:1px solid var(--dsw-alias-border-l2,#0000001a);',
    '  border-radius:999px;padding:4px 10px;background:var(--dsw-alias-bg-layer-1,transparent)}',
    '.msc-sync.err{color:var(--dsw-alias-state-error-primary,#ec1313);border-color:var(--dsw-alias-state-error-primary,#ec1313)}',
    '.msc-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);flex:none}',
    '.msc-dot.busy{background:var(--dsw-alias-label-tertiary,#81858c)}',
    '.msc-dot.err{background:var(--dsw-alias-state-error-primary,#ec1313)}',
    '.msc-iconbtn{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;',
    '  color:var(--dsw-alias-label-secondary,#61666b);background:var(--dsw-alias-bg-layer-1,transparent);',
    '  border:1px solid var(--dsw-alias-border-l3,#0000001f);border-radius:var(--dsw-radius-sm,8px)}',
    '.msc-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,transparent);color:var(--dsw-alias-label-primary,CanvasText)}',
    /* 焦点：不能依赖 --dsw-focus-ring-color（宿主里是 transparent），直接用真实非透明 token */
    '.msc-iconbtn:focus-visible,.msc-search input:focus-visible,.msc-select select:focus-visible,.msc-ghead:focus-visible,.msc-switch:focus-visible,.msc-bulkbtn:focus-visible{',
    '  outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:2px}',
    '.msc-iconbtn svg{width:15px;height:15px;display:block}',
    '.msc-toolbar{display:flex;align-items:center;gap:12px;margin:16px 0 2px}',
    '.msc-search{position:relative;flex:1;min-width:0}',
    '.msc-search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);width:14px;height:14px;color:var(--dsw-alias-label-tertiary,#81858c);pointer-events:none}',
    '.msc-search input{width:100%;font:inherit;font-size:12.5px;padding:8px 10px 8px 32px;',
    '  color:var(--dsw-alias-label-primary,CanvasText);background:var(--dsw-alias-bg-layer-1,transparent);',
    '  border:1px solid var(--dsw-alias-border-l3,#0000001f);border-radius:var(--dsw-radius-md,12px)}',
    /* 小字号用 secondary，浅色下 5.8:1（tertiary 在浅色仅 3.7:1，评审 #2） */
    '.msc-search input::placeholder{color:var(--dsw-alias-label-secondary,#61666b)}',
    '.msc-search input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4176e6)}',
    '.msc-count{font-size:11.5px;color:var(--dsw-alias-label-secondary,#61666b);white-space:nowrap}',
    '.msc-bulkbtn{font:inherit;font-size:11.5px;padding:5px 9px;cursor:pointer;white-space:nowrap;',
    '  color:var(--dsw-alias-label-secondary,#61666b);background:transparent;',
    '  border:1px solid var(--dsw-alias-border-l3,#0000001f);border-radius:var(--dsw-radius-sm,8px)}',
    '.msc-bulkbtn:hover{color:var(--dsw-alias-label-primary,CanvasText);background:var(--dsw-alias-interactive-bg-hover,transparent)}',
    '.msc-subbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:6px 8px 0}',
    '.msc-legend{font-size:11.5px;color:var(--dsw-alias-label-secondary,#61666b);margin:0;min-width:0}',
    '.msc-storage{display:inline-flex;align-items:center;gap:6px;flex:none;font-size:11px;white-space:nowrap;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.msc-storage-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary,#22c55e)}',
    '.msc-storage-dot.empty{background:var(--dsw-static-neutral-bluish-600,#81858c)}',
    '.msc-divider{height:1px;background:var(--dsw-alias-border-l2,#0000001a);margin:12px 0 4px}',
    '.msc-group{margin-top:6px}',
    '.msc-ghead{display:flex;align-items:center;gap:8px;width:100%;padding:9px 8px;border:0;background:transparent;',
    '  cursor:pointer;text-align:left;border-radius:var(--dsw-radius-md,12px);color:inherit;font:inherit}',
    '.msc-ghead:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}',
    '.msc-foldbtn{flex:none;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;',
    '  background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);pointer-events:none}',
    '.msc-foldbtn svg{width:12px;height:12px;transition:transform .18s ease}',
    '.msc-foldbtn.closed svg{transform:rotate(-90deg)}',
    '.msc-gname{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,CanvasText)}',
    '.msc-gbadge{font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#61666b);',
    '  background:var(--dsw-alias-interactive-bg-hover,transparent);border-radius:var(--dsw-radius-xs,4px);padding:1px 7px}',
    '.msc-gvis{margin-left:auto;font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.msc-row{display:flex;align-items:center;gap:12px;padding:9px 10px;margin:2px 0;',
    '  border:1px solid transparent;border-radius:var(--dsw-radius-md,12px);transition:background .15s ease,border-color .15s ease}',
    '.msc-row:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}',
    '.msc-row.is-override{border-color:var(--dsw-alias-border-l2,#0000001a)}',
    '.msc-rowmain{display:flex;align-items:center;gap:11px;min-width:0;flex:1}',
    /* OFF 轨道：用静态中性色，浅/深两主题都 >=3:1（评审 #1：v1 里浅色轨道与卡片同为白、旋钮不可见） */
    '.msc-switch{position:relative;flex:none;width:34px;height:19px;padding:0;border:0;cursor:pointer;border-radius:999px;',
    '  background:var(--dsw-static-neutral-bluish-600,#81858c);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l4,#00000029);',
    '  transition:background .18s ease}',
    '.msc-switch::after{content:"";position:absolute;left:2px;top:2px;width:15px;height:15px;border-radius:50%;',
    '  background:var(--dsw-static-neutral-bluish-00,#fff);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .18s ease}',
    '.msc-switch.on{background:var(--dsw-alias-state-business-primary,#4176e6);box-shadow:none}',
    '.msc-switch.on::after{transform:translateX(15px)}',
    '.msc-meta{min-width:0}',
    '.msc-mname{font-size:12.8px;font-weight:500;color:var(--dsw-alias-label-primary,CanvasText);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.msc-mid{font-size:11px;color:var(--dsw-alias-label-secondary,#61666b);font-family:var(--ds-font-family-code,ui-monospace,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.msc-rowact{display:flex;align-items:center;gap:9px;flex:none}',
    '.msc-otag{display:inline-flex;align-items:center;gap:5px;font-size:11px;white-space:nowrap;color:var(--dsw-alias-state-business-primary,#4176e6)}',
    '.msc-otag i{width:5px;height:5px;border-radius:50%;background:currentColor;display:block}',
    '.msc-htag{font-size:10.5px;color:var(--dsw-alias-label-secondary,#61666b);border:1px solid var(--dsw-alias-border-l3,#0000001f);',
    '  border-radius:var(--dsw-radius-xs,4px);padding:0 6px;white-space:nowrap}',
    '.msc-select{position:relative;display:inline-flex;align-items:center}',
    '.msc-select select{appearance:none;-webkit-appearance:none;font:inherit;font-size:12px;min-width:132px;padding:6px 26px 6px 10px;cursor:pointer;',
    '  color:var(--dsw-alias-label-primary,CanvasText);background:var(--dsw-alias-bg-layer-1,transparent);',
    '  border:1px solid var(--dsw-alias-border-l3,#0000001f);border-radius:var(--dsw-radius-sm,8px)}',
    '.msc-select select:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}',
    '.msc-select select option{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115)}',
    '.msc-select svg{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:11px;height:11px;color:var(--dsw-alias-label-tertiary,#81858c);pointer-events:none}',
    '.msc-none{font-size:11.5px;color:var(--dsw-alias-label-secondary,#61666b);white-space:nowrap}',
    '.msc-foot{display:flex;align-items:flex-start;gap:8px;margin-top:14px;padding:11px 12px;',
    '  background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:var(--dsw-radius-md,12px)}',
    '.msc-foot svg{width:14px;height:14px;flex:none;margin-top:1px;color:var(--dsw-alias-label-tertiary,#81858c)}',
    '.msc-foot p{margin:0;font-size:11.8px;line-height:1.6;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.msc-foot b{color:var(--dsw-alias-label-primary,CanvasText);font-weight:600}',
    '.msc-msg{margin:10px 2px 0;font-size:12px}',
    '.msc-msg.err{color:var(--dsw-alias-state-error-primary,#ec1313)}',
    '.msc-msg.ok{color:var(--dsw-alias-state-success-primary,#22c55e)}',
    '.msc-empty{padding:26px 8px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.msc-loading{padding:22px 8px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-secondary,#61666b)}',
  ].join('\n')

  /* ---------------- 纯展示型小组件（无 hook，便于无头渲染验收） ---------------- */
  function Logo(h) {
    return h('div', { className: 'msc-logo', 'aria-hidden': 'true' },
      h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4' }),
        h('circle', { cx: 16, cy: 6, r: 2 }),
        h('circle', { cx: 8, cy: 12, r: 2 }),
        h('circle', { cx: 14, cy: 18, r: 2 }),
      ),
    )
  }
  function SearchIcon(h) {
    return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
      h('circle', { cx: 11, cy: 11, r: 7 }),
      h('path', { d: 'm20 20-3.5-3.5' }),
    )
  }
  function ReloadIcon(h) {
    return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M20 11a8 8 0 1 0-2.3 5.7' }),
      h('path', { d: 'M20 4v7h-7' }),
    )
  }
  function Chevron(h, closed) {
    return h('span', { className: 'msc-foldbtn' + (closed ? ' closed' : '') },
      h('svg', { viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M2.5 4.5L6 8l3.5-3.5' }),
      ),
    )
  }
  function SelectChevron(h) {
    return h('svg', { viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M3 4.5L6 7.5L9 4.5' }),
    )
  }
  function InfoIcon(h) {
    return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('circle', { cx: 12, cy: 12, r: 9 }),
      h('path', { d: 'M12 11v5M12 8h.01' }),
    )
  }

  /* levelLabel：未知档位回退显示原始 id（各 adapter 可自定义档位名） */
  function levelLabel(t, id) {
    if (!id) return ''
    return t('lv.' + id) || id
  }

  /* 保存 / 回显用的本地时间 HH:MM:SS（不依赖 ICU，深浅主题与无头渲染都一致）。 */
  function nowTime(iso) {
    var d = iso ? new Date(iso) : new Date()
    return d.toTimeString().slice(0, 8)
  }

  /* 落盘状态行：把「配置到底存没存、存哪、什么时候存的」直接显示在卡片上，
     让用户不必猜（v2.2：针对「改完插件配置没保存」的反馈）。 */
  function storageNode(h, t, storage) {
    if (!storage || !storage.savedAt) {
      return h('div', { className: 'msc-storage' },
        h('span', { className: 'msc-storage-dot empty' }), t('storage.never'))
    }
    return h('div', { className: 'msc-storage', title: storage.path || t('storage.title') },
      h('span', { className: 'msc-storage-dot' }),
      t('storage.saved') + ' · ' + t('storage.last') + ' ' + nowTime(storage.savedAt))
  }

  /* ================================================================== *
   * 顶层卡片：全部状态集中在此（其余子组件无 hook，便于无头渲染）。
   * hook 调用顺序（无头测试按此顺序注入假 store）：
   *   1 groups  2 loading  3 status  4 flash  5 query  6 savingKey  7 collapsed  8 storage
   * ================================================================== */
  function ModelSelectorCard(props) {
    var React = props.React
    var t = props.t
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var s1 = useState([]); var groups = s1[0], setGroups = s1[1]
    var s2 = useState(true); var loading = s2[0], setLoading = s2[1]
    var s3 = useState('loading'); var status = s3[0], setStatus = s3[1]
    var s4 = useState(''); var flash = s4[0], setFlash = s4[1]
    var s5 = useState(''); var query = s5[0], setQuery = s5[1]
    var s6 = useState(null); var savingKey = s6[0], setSavingKey = s6[1]
    var s7 = useState({}); var collapsed = s7[0], setCollapsed = s7[1]
    var s8 = useState(null); var storage = s8[0], setStorage = s8[1]

    function load() {
      setStatus('loading')
      fetch('/api/model-selector-config/providers', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (data) {
          if (data && data.ok && Array.isArray(data.groups)) { setGroups(data.groups); setStorage(data.storage || null); setStatus('synced') }
          else { setStatus('loadError'); setFlash(t('err.load')) }
        })
        .catch(function () { setStatus('loadError'); setFlash(t('err.load')) })
    }

    useEffect(function () { load() }, [])

    function post(path, body, key, okText) {
      setSavingKey(key); setStatus('saving'); setFlash('')
      fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (r) { return r.json() })
        .then(function (data) {
          setSavingKey(null)
          if (data && data.ok) { setFlash((okText || t('notice.saved')) + ' · ' + nowTime()); load() }
          else { setStatus('error'); setFlash(data && data.error ? data.error : t('err.save')) }
        })
        .catch(function () { setSavingKey(null); setStatus('error'); setFlash(t('err.save')) })
    }

    function toggleVisible(g, m) {
      post('/api/model-selector-config/visibility',
        { provider: g.provider, model: m.id, visible: !m.visible },
        g.provider + '/' + m.id,
        m.visible ? t('notice.hidden') : t('notice.shown'))
    }

    function setLevel(g, m, level) {
      post('/api/model-selector-config/default-level',
        { provider: g.provider, model: m.id, level: level },
        g.provider + '/' + m.id + '/level',
        level === 'auto' ? t('notice.restored') : t('notice.saved'))
    }

    /* 折叠状态只记录「显式选择」：没有记录 = 默认折叠；false = 用户展开过；true = 用户折叠过。
       模型太多（十几个平台），默认全折叠，要看哪个手动展开。 */
    function isClosed(id) {
      return collapsed[id] !== false
    }

    function toggleFold(id) {
      var next = {}
      for (var k in collapsed) if (Object.prototype.hasOwnProperty.call(collapsed, k)) next[k] = collapsed[k]
      next[id] = !isClosed(id)
      setCollapsed(next)
    }

    /* 只要还有展开的分组就全部折叠，否则全部展开。 */
    function toggleAllFolds() {
      var anyOpen = false
      for (var ai = 0; ai < groups.length; ai++) {
        if (!isClosed(groups[ai].provider)) { anyOpen = true; break }
      }
      var next = {}
      for (var aj = 0; aj < groups.length; aj++) next[groups[aj].provider] = anyOpen
      setCollapsed(next)
    }

    /* 搜索 = 纯过滤，不改任何数据源；编辑在服务端、经 load() 回填，绝不会被搜索冲掉。 */
    var q = String(query || '').trim().toLowerCase()
    var filtered = []
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi]
      var label = String(g.label || g.provider || '')
      var matchGroup = label.toLowerCase().indexOf(q) >= 0 || String(g.provider || '').toLowerCase().indexOf(q) >= 0
      var models = g.models || []
      var shown = []
      for (var mi = 0; mi < models.length; mi++) {
        var m = models[mi]
        if (matchGroup || q === '' || (String(m.name || '') + ' ' + String(m.id || '')).toLowerCase().indexOf(q) >= 0) {
          shown.push(m)
        }
      }
      if (shown.length) filtered.push({ g: g, models: shown, all: models })
    }

    var totalPlatforms = groups.length
    var totalModels = 0, totalHidden = 0
    for (var a = 0; a < groups.length; a++) {
      var gm = groups[a].models || []
      totalModels += gm.length
      for (var b = 0; b < gm.length; b++) if (gm[b] && !gm[b].visible) totalHidden++
    }

    var totalVisible = totalModels - totalHidden
    var countText = String(totalPlatforms) + ' ' + t('count.platforms') + ' · ' +
      t('count.enabled') + ' ' + String(totalVisible) + ' / ' + String(totalModels) + ' ' + t('count.models') +
      (totalHidden > 0 ? ' · ' + String(totalHidden) + ' ' + t('count.hidden') : '')

    /* 一键展开/折叠：只要还有展开的分组，按钮就是「全部折叠」。 */
    var anyOpen = false
    for (var oi = 0; oi < groups.length; oi++) {
      if (!isClosed(groups[oi].provider)) { anyOpen = true; break }
    }
    var bulkLabel = t(anyOpen ? 'foldAll.collapse' : 'foldAll.expand')

    var busy = status === 'saving'
    var statusText = t('status.' + status) || status
    var dotClass = 'msc-dot' + (status === 'error' || status === 'loadError' ? ' err' : (status === 'loading' || status === 'saving' ? ' busy' : ''))
    var syncClass = 'msc-sync' + (status === 'error' || status === 'loadError' ? ' err' : '')

    /* ---------------- 行 ---------------- */
    function ModelRow(g, m) {
      var key = g.provider + '/' + m.id
      var rowBusy = busy && savingKey === key
      var efforts = m.efforts || []
      var hasEfforts = efforts.length > 0

      var opts = []
      if (hasEfforts) {
        var autoLabel = t('level.auto')
        if (!m.hasOverride && m.defaultLevel) autoLabel = autoLabel + '（' + levelLabel(t, m.defaultLevel) + '）'
        opts.push(h('option', { value: 'auto' }, autoLabel))
        for (var oi = 0; oi < efforts.length; oi++) {
          opts.push(h('option', { value: efforts[oi] }, levelLabel(t, efforts[oi])))
        }
      }

      var levelControl
      if (hasEfforts) {
        var selValue = m.hasOverride && m.defaultLevel ? m.defaultLevel : 'auto'
        levelControl = h('span', { className: 'msc-select' },
          h('select', {
            value: selValue,
            disabled: !!rowBusy,
            'aria-label': t('level.auto'),
            onChange: function (e) { setLevel(g, m, e.target.value) },
          }, opts),
          SelectChevron(h),
        )
      } else {
        levelControl = h('span', { className: 'msc-none' }, t('level.none'))
      }

      var tags = []
      if (m.hasOverride) {
        tags.push(h('span', { className: 'msc-otag', title: t('level.customTitle'), key: 'ot' },
          h('i', null), t('level.custom')))
      }
      if (!m.visible) {
        tags.push(h('span', { className: 'msc-htag', key: 'ht' }, t('hidden.tag')))
      }

      return h('div', {
        className: 'msc-row' + (m.hasOverride ? ' is-override' : ''),
        key: key,
        'aria-busy': rowBusy ? 'true' : null,
      },
        h('div', { className: 'msc-rowmain' },
          h('button', {
            type: 'button',
            className: 'msc-switch' + (m.visible ? ' on' : ''),
            role: 'switch',
            'aria-checked': m.visible ? 'true' : 'false',
            'aria-label': t(m.visible ? 'switch.hide' : 'switch.show') + ' · ' + (m.name || m.id),
            disabled: !!rowBusy,
            onClick: function () { toggleVisible(g, m) },
          }),
          h('div', { className: 'msc-meta' },
            h('div', { className: 'msc-mname' }, m.name || m.id),
            h('div', { className: 'msc-mid' }, m.id),
          ),
        ),
        h('div', { className: 'msc-rowact' }, tags, levelControl),
      )
    }

    /* ---------------- 分组 ---------------- */
    function GroupBlock(item) {
      var g = item.g
      var all = item.all || item.models
      var visCount = 0
      for (var vi = 0; vi < all.length; vi++) if (all[vi] && all[vi].visible) visCount++
      /* 搜索时把命中的分组自动展开，方便直接看到结果；清空搜索后回到手动态。 */
      var closed = q === '' ? isClosed(g.provider) : false
      var rows = []
      if (!closed) {
        for (var ri = 0; ri < item.models.length; ri++) rows.push(ModelRow(g, item.models[ri]))
      }
      return h('section', { className: 'msc-group', key: g.provider },
        h('button', {
          type: 'button',
          className: 'msc-ghead',
          'aria-expanded': closed ? 'false' : 'true',
          'aria-label': t(closed ? 'fold.show' : 'fold.hide') + ' · ' + (g.label || g.provider),
          onClick: function () { toggleFold(g.provider) },
        },
          Chevron(h, closed),
          h('span', { className: 'msc-gname' }, g.label || g.provider),
          h('span', { className: 'msc-gbadge' }, String(all.length)),
          h('span', { className: 'msc-gvis' }, String(visCount) + '/' + String(all.length) + ' ' + t('visible.of')),
        ),
        h('div', { className: 'msc-models' }, rows),
      )
    }

    /* ---------------- 整卡 ---------------- */
    var body
    if (loading && groups.length === 0) {
      body = h('div', { className: 'msc-loading' }, t('status.loading'))
    } else if (filtered.length === 0) {
      body = h('div', { className: 'msc-empty' }, groups.length === 0 ? t('status.loadError') : t('empty'))
    } else {
      var blocks = []
      for (var fi = 0; fi < filtered.length; fi++) blocks.push(GroupBlock(filtered[fi]))
      body = h('div', { id: 'msc-groups' }, blocks)
    }

    return h('div', { className: 'msc-root' },
      h('style', null, CSS),
      h('div', { className: 'msc-card' },
        h('div', { className: 'msc-head' },
          Logo(h),
          h('div', { className: 'msc-headtxt' },
            h('div', { className: 'msc-title' }, t('title')),
            h('p', { className: 'msc-desc' }, t('desc')),
          ),
          h('div', { className: 'msc-headact' },
            h('span', { className: syncClass, 'aria-live': 'polite' },
              h('i', { className: dotClass }), statusText),
            h('button', {
              type: 'button', className: 'msc-iconbtn', title: t('reloadTitle'), 'aria-label': t('reload'),
              onClick: function () { load() },
            }, ReloadIcon(h)),
          ),
        ),
        h('div', { className: 'msc-toolbar' },
          h('label', { className: 'msc-search' },
            SearchIcon(h),
            h('input', {
              type: 'search', placeholder: t('search'), value: query, autoComplete: 'off',
              'aria-label': t('search'),
              onInput: function (e) { setQuery(e.target.value) },
            }),
          ),
          h('span', { className: 'msc-count' }, countText),
          h('button', {
            type: 'button', className: 'msc-bulkbtn', title: bulkLabel, 'aria-label': bulkLabel,
            onClick: function () { toggleAllFolds() },
          }, bulkLabel),
        ),
        h('div', { className: 'msc-subbar' },
          h('span', { className: 'msc-legend' }, t('legend')),
          storageNode(h, t, storage)),
        h('div', { className: 'msc-divider' }),
        body,
        h('div', { className: 'msc-foot' },
          InfoIcon(h),
          h('p', null, h('b', null, t('title')), '：', t('foot')),
        ),
        flash ? h('p', { className: 'msc-msg ' + (status === 'error' || status === 'loadError' ? 'err' : 'ok'), 'aria-live': 'polite' }, flash) : null,
      ),
    )
  }

  // 供无头渲染 / 构建脚本按需取用（浏览器里挂在全局不影响宿主）。
  // 注意：zh/en 在 factory 作用域内，i18n 字典经 apply()→ctx.locale.register 暴露，
  // 验收脚本通过真实调用 factory()/apply() 捕获；此处只导出模块级可见的纯函数/组件。
  if (typeof globalThis !== 'undefined') {
    globalThis.__MSC__ = { ModelSelectorCard: ModelSelectorCard, CSS: CSS, levelLabel: levelLabel }
  }
})()
