/**
 * dsh-model-selector-config —— 客户端设置卡片。
 *
 * 注册进插件配置页 keyed 槽 `plugins.bundle.config`，按 provider 分组列出模型，
 * 每模型一行：可见性 checkbox + 默认思考等级下拉。
 *  - pi-ai 类 provider 的默认档是 provider 级单值，改任一模型的档位=改该 provider 全部，
 *    UI 明确标注。
 *  - workbuddy 类 provider 的默认档是 per-model。
 *
 * 纯 React DOM（React.createElement，非 JSX）+ 组件级 <style>；CSS 只用真实存在的
 * --dsw-* token 带兜底色，深浅色靠 token 自身翻转，绝不写死颜色。t(key) 是函数、扁平点号 key。
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

      /* ---------------- i18n ---------------- */
      const zh = {
        'title': '模型选择器',
        'desc': '控制哪些模型出现在模型选择器中，并设定其默认思考等级（改动即时生效，无需重启）。',
        'reload': '刷新',
        'saving': '保存中…',
        'visible': '显示',
        'hidden': '隐藏',
        'defaultLevel': '默认等级',
        'providerLevelHint': '该 provider 的默认等级为单一值，改任一模型即作用于其全部模型。',
        'noReasoning': '该模型不支持思考等级',
        'loadFailed': '加载失败',
        'saveFailed': '保存失败',
        'saved': '已保存',
      }
      const en = {
        'title': 'Model Selector',
        'desc': 'Choose which models appear in the model selector and set their default thinking level (changes apply instantly, no restart).',
        'reload': 'Refresh',
        'saving': 'Saving…',
        'visible': 'Visible',
        'hidden': 'Hidden',
        'defaultLevel': 'Default level',
        'providerLevelHint': 'This provider uses a single default level; changing any model applies to all of its models.',
        'noReasoning': 'This model has no thinking levels',
        'loadFailed': 'Load failed',
        'saveFailed': 'Save failed',
        'saved': 'Saved',
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
   * Card 组件
   * ================================================================== */
  function ModelSelectorCard(props) {
    var React = props.React
    var t = props.t
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback

    var groupsState = useState([])
    var groups = groupsState[0]
    var setGroups = groupsState[1]
    var loadingState = useState(true)
    var loading = loadingState[0]
    var setLoading = loadingState[1]
    var savingState = useState(null)
    var savingKey = savingState[0]
    var setSavingKey = savingState[1]
    var errorState = useState('')
    var error = errorState[0]
    var setError = errorState[1]
    var noticeState = useState('')
    var notice = noticeState[0]
    var setNotice = noticeState[1]

    var load = useCallback(function () {
      setLoading(true)
      setError('')
      fetch('/api/model-selector-config/providers')
        .then(function (res) { return res.json() })
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || 'load failed')
          setGroups(data.groups || [])
        })
        .catch(function (e) { setError(String(e && e.message ? e.message : e)) })
        .then(function () { setLoading(false) })
    }, [])
    // useCallback deps: empty — setLoading/setError/setGroups are stable.

    useEffect(load, [load])

    function post(path, body, key) {
      setSavingKey(key)
      setError('')
      setNotice('')
      fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (res) { return res.json() })
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || 'save failed')
          setNotice(t('saved'))
          load()
        })
        .catch(function (e) { setError(String(e && e.message ? e.message : e)) })
        .then(function () { setSavingKey(null) })
    }

    function toggleVisible(group, model) {
      var key = group.provider + '/' + model.id
      post('/api/model-selector-config/visibility', { provider: group.provider, model: model.id, visible: !model.visible, kind: group.kind }, key)
    }

    function setLevel(group, model, level) {
      var key = group.provider + '/' + model.id
      post('/api/model-selector-config/default-level', { provider: group.provider, model: model.id, level: level, kind: group.kind }, key)
    }

    var children = []
    children.push(React.createElement('style', { key: 'css' }, CSS))
    children.push(
      React.createElement(
        'div',
        { key: 'head', className: 'msc-head' },
        React.createElement('div', { className: 'msc-title' }, t('title')),
        React.createElement('div', { className: 'msc-desc' }, t('desc')),
        React.createElement(
          'button',
          { className: 'msc-btn', onClick: load, disabled: loading || savingKey !== null },
          t('reload'),
        ),
      ),
    )
    if (error) children.push(React.createElement('div', { key: 'err', className: 'msc-err' }, t('loadFailed') + '：' + error))
    else if (notice) children.push(React.createElement('div', { key: 'ok', className: 'msc-ok' }, notice))

    if (loading && groups.length === 0) {
      children.push(React.createElement('div', { key: 'loading', className: 'msc-loading' }, '…'))
    } else {
      groups.forEach(function (group) {
        children.push(
          React.createElement(Group, {
            key: group.provider,
            React: React,
            t: t,
            group: group,
            savingKey: savingKey,
            onToggle: toggleVisible,
            onLevel: setLevel,
          }),
        )
      })
    }

    return React.createElement('div', { className: 'msc-root' }, children)
  }

  function Group(props) {
    var React = props.React
    var t = props.t
    var group = props.group
    var savingKey = props.savingKey
    var onToggle = props.onToggle
    var onLevel = props.onLevel

    var openState = React.useState(true)
    var open = openState[0]
    var setOpen = openState[1]

    var visibleCount = group.models.filter(function (m) { return m.visible }).length

    var headChildren = [
      React.createElement('span', { key: 'chev', className: 'msc-chevron' }, open ? '▾' : '▸'),
      React.createElement('span', { key: 'name', className: 'msc-group-name' }, group.label || group.provider),
      React.createElement('span', { key: 'count', className: 'msc-group-count' }, visibleCount + '/' + group.models.length),
    ]

    var body = []
    if (group.kind === 'pi-ai' && group.reasoningLevels && group.reasoningLevels.length > 0) {
      body.push(React.createElement('div', { key: 'hint', className: 'msc-hint' }, t('providerLevelHint')))
    }
    if (open) {
      group.models.forEach(function (model) {
        body.push(
          React.createElement(ModelRow, {
            key: model.id,
            React: React,
            t: t,
            group: group,
            model: model,
            savingKey: savingKey,
            onToggle: onToggle,
            onLevel: onLevel,
          }),
        )
      })
    }

    return React.createElement(
      'div',
      { className: 'msc-group' },
      React.createElement('div', { className: 'msc-group-head', onClick: function () { setOpen(!open) } }, headChildren),
      body,
    )
  }

  function ModelRow(props) {
    var React = props.React
    var t = props.t
    var group = props.group
    var model = props.model
    var savingKey = props.savingKey
    var onToggle = props.onToggle
    var onLevel = props.onLevel

    var key = group.provider + '/' + model.id
    var busy = savingKey === key
    var efforts = model.efforts || []

    var levelControl
    if (efforts.length > 0) {
      var options = efforts.map(function (lv) {
        return React.createElement('option', { key: lv, value: lv }, lv)
      })
      levelControl = React.createElement(
        'select',
        {
          value: model.defaultLevel || '',
          disabled: busy || !model.visible,
          onChange: function (e) { onLevel(group, model, e.target.value) },
        },
        options,
      )
    } else {
      levelControl = React.createElement('span', { className: 'msc-none' }, t('noReasoning'))
    }

    return React.createElement(
      'div',
      { className: 'msc-row' + (model.visible ? '' : ' msc-row-hidden') },
      React.createElement(
        'label',
        { className: 'msc-check' },
        React.createElement('input', {
          type: 'checkbox',
          checked: !!model.visible,
          disabled: busy,
          onChange: function () { onToggle(group, model) },
        }),
        React.createElement('span', { className: 'msc-model-name' }, model.name || model.id),
      ),
      React.createElement('div', { className: 'msc-level' }, levelControl),
    )
  }

  /* ---------------- 组件级样式：只用真实 token 带兜底 ---------------- */
  var CSS = [
    '.msc-root { display:flex; flex-direction:column; gap:10px; font-size:14px; color:var(--dsw-alias-color-text-primary, currentColor); }',
    '.msc-head { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }',
    '.msc-title { font-size:15px; font-weight:600; }',
    '.msc-desc { flex:1 1 200px; font-size:12px; opacity:.75; }',
    '.msc-btn { font-size:12px; padding:3px 10px; border-radius:var(--dsw-radius-sm, 6px); border:1px solid var(--dsw-alias-color-border, rgba(128,128,128,.4)); background:transparent; color:inherit; cursor:pointer; }',
    '.msc-btn:disabled { opacity:.5; cursor:default; }',
    '.msc-err { font-size:12px; color:#d64545; }',
    '.msc-ok { font-size:12px; color:#2f9e44; }',
    '.msc-loading { font-size:13px; opacity:.6; padding:6px 0; }',
    '.msc-group { border:1px solid var(--dsw-alias-color-border, rgba(128,128,128,.3)); border-radius:var(--dsw-radius-md, 8px); padding:6px 10px; }',
    '.msc-group-head { display:flex; align-items:center; gap:8px; cursor:pointer; padding:4px 0; user-select:none; }',
    '.msc-chevron { width:14px; opacity:.7; }',
    '.msc-group-name { font-weight:600; font-size:13px; }',
    '.msc-group-count { margin-left:auto; font-size:12px; opacity:.6; }',
    '.msc-hint { font-size:11px; opacity:.65; padding:2px 0 4px 22px; }',
    '.msc-models { display:flex; flex-direction:column; }',
    '.msc-row { display:flex; align-items:center; gap:10px; padding:5px 0 5px 22px; border-top:1px solid var(--dsw-alias-color-border, rgba(128,128,128,.18)); }',
    '.msc-row-hidden .msc-model-name { opacity:.45; text-decoration:line-through; }',
    '.msc-check { display:flex; align-items:center; gap:8px; cursor:pointer; flex:1; }',
    '.msc-model-name { font-size:13px; }',
    '.msc-level { min-width:110px; }',
    '.msc-level select { font-size:12px; padding:2px 4px; border-radius:var(--dsw-radius-sm, 6px); border:1px solid var(--dsw-alias-color-border, rgba(128,128,128,.4)); background:transparent; color:inherit; }',
    '.msc-none { font-size:11px; opacity:.5; }',
  ].join('\n')
})()
