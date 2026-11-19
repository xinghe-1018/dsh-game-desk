/*!
 * dsh-game-desk 客户端半 —— 左侧入口栏两行（剧本杀 / 游戏厅）+ 内容区两个面板。
 *
 * 形态：
 * - 两行挂在 sidebar.panellist（与技能中心同一列），order 32 / 33；点行 = selectPanel(id)，
 *   所以同时注册两个 main 面板（key 与 id 相同），面板里是一整块 iframe 指向宿主路由
 *   /game-desk/app/?panel=…&theme=… —— 页面由宿主半提供，这里只管"装它"和"把话带回输入框"。
 * - 开局：页面 postMessage {type:'fill', text, submit, ack, id} 上来，这里走 execCommand('insertText')
 *   填进对话输入框（React 收得到的那条路，抄自 jubensha 的 fillComposer），再按需回车；
 *   带 ack 时回一条 {type:'filled'} 给页面，切不切对话由页面说（{type:'show-conversation'}）。
 *
 * 红线：不 require 宿主包值；类名 gd21- 前缀；颜色只用 --dsw-alias-*（iframe 里另有一套自己的配色）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-game-desk',
  factory: function (require) {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const useEffect = React.useEffect
    const useRef = React.useRef

    /** 排障：客户端半活在渲染进程里，控制台看不到，就把阶段写进 localStorage（键前缀 gd21:）。 */
    function mark(stage, detail) {
      try { window.localStorage.setItem('gd21:' + stage, String(detail === undefined ? 'ok' : detail).slice(0, 400)) } catch (e) {}
    }
    mark('eval')
    /** 同一时刻给宿主半留一份：宿主在跑的时候/页面刷新后都能从 /game-desk/api/beats 看到卡在哪一步。 */
    function beat(stage, detail) {
      try {
        fetch('/game-desk/api/beat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stage: String(stage), detail: String(detail === undefined ? '' : detail).slice(0, 300), at: Date.now() }),
          keepalive: true,
        }).catch(function () {})
      } catch (e) {}
    }
    beat('eval')

    const ROUTE = '/game-desk'
    const HOME_PANEL = 'conversation'
    const ENTRIES = [
      { id: 'jubensha-desk', panel: 'jubensha', order: 32, zh: '剧本杀', en: 'Murder mystery', tip: '本子库：选一本，开场指令直接填进对话' },
      { id: 'xgame-desk', panel: 'arcade', order: 33, zh: '游戏厅', en: 'Game room', tip: '海龟汤 / 侦探推理 / 密室逃脱 · 七种玩法' },
    ]

    /** 当前主题：宿主 html 上的 data-theme 优先，其次跟随系统。 */
    function currentTheme() {
      try {
        const el = document.documentElement
        const t = (el && (el.getAttribute('data-theme') || el.getAttribute('data-color-scheme'))) || ''
        if (t !== '') return /dark/i.test(t) ? 'dark' : 'light'
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      } catch (e) { return 'light' }
    }

    /**
     * 把一句话填进对话输入框。
     * 直接改 value 不行：那个框受 React 管，下次渲染会抹掉；走 insertText 才是"用户打字"那条路。
     * @param text 要填的话
     * @param submit 填完是否顺手按回车
     */
    function fillComposer(text, submit) {
      const box = document.querySelector('textarea, [contenteditable="true"]')
      if (!box) return false
      if (box instanceof HTMLTextAreaElement) {
        box.focus()
        box.setSelectionRange(0, box.value.length)
      } else {
        const range = document.createRange()
        range.selectNodeContents(box)
        const sel = window.getSelection()
        if (sel) { sel.removeAllRanges(); sel.addRange(range) }
        if (box instanceof HTMLElement) box.focus()
      }
      let ok = false
      try { ok = document.execCommand('insertText', false, text) } catch (e) { ok = false }
      if (!ok && box instanceof HTMLTextAreaElement) {
        const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
        if (desc && desc.set) desc.set.call(box, text)
        box.dispatchEvent(new Event('input', { bubbles: true }))
      }
      if (submit) {
        const press = function (type) {
          const ev = new KeyboardEvent(type, {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
          })
          box.dispatchEvent(ev)
        }
        setTimeout(function () { press('keydown'); press('keypress') }, 60)
      }
      return ok
    }

    var layoutRef = null

    /** 面板里的那一页：宿主路由 + 主题 + 面板名。 */
    function DeskFrame(props) {
      const panel = props.panel
      const src = ROUTE + '/app/?panel=' + encodeURIComponent(panel) + '&theme=' + currentTheme()
      return h('iframe', {
        src: src,
        title: panel === 'arcade' ? '游戏厅' : '剧本杀',
        className: 'gd21-frame',
        style: { display: 'block', width: '100%', height: '100%', border: '0', background: 'transparent' },
        allow: 'clipboard-write',
      })
    }

    /** 两个 main 面板 —— key 必须与 sidebar.panellist 的 id 一致，selectPanel 才找得到。 */
    function makePage(panel) {
      return function DeskPage() {
        return h('div', {
          className: 'gd21-page',
          style: { display: 'flex', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden' },
        }, h(DeskFrame, { panel: panel }))
      }
    }

    function Svg(props) {
      return h('svg', {
        viewBox: '0 0 24 24', width: props.size || 18, height: props.size || 18, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, props.children)
    }

    function CaseMark(props) {
      return h(Svg, { size: props.size },
        h('path', { d: 'M3.2 7.4h5.6l1.7 2.1h10.3v9.1H3.2z' }),
        h('path', { d: 'M3.2 9.5V6.1h6.2' }),
        h('circle', { cx: 11.9, cy: 14.2, r: 2.3 }),
        h('path', { d: 'M13.6 15.9l2.1 2.1' }))
    }

    function ArcadeMark(props) {
      return h(Svg, { size: props.size },
        h('rect', { x: 3.4, y: 3.4, width: 17.2, height: 17.2, rx: 4.2 }),
        h('circle', { cx: 8.4, cy: 8.4, r: 1.15, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 15.6, cy: 8.4, r: 1.15, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 12, cy: 12, r: 1.15, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 8.4, cy: 15.6, r: 1.15, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 15.6, cy: 15.6, r: 1.15, fill: 'currentColor', stroke: 'none' }))
    }

    /** 入口栏那一个格子 —— 点它由面板列表自己 selectPanel，这里不做手脚。 */
    function makeRow(entry, Mark) {
      return function Row(props) {
        const size = (props && props.size) || 18
        return h('span', {
          className: 'gd21-row',
          title: entry.zh + ' · ' + entry.tip,
          style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', color: 'inherit' },
        }, h(Mark, { size: size }))
      }
    }

    function applyInner(ctx) {
      const lay = ctx.get('layout')
      layoutRef = lay
      const slots = ctx.get('slots')
      mark('slots', slots ? 'present' : 'missing')
      beat('apply', 'slots=' + (slots ? 'present' : 'missing') + ' layout=' + (lay ? 'present' : 'missing'))
      if (!slots) {
        if (ctx.logger && ctx.logger.warn) ctx.logger.warn(new Error('dsh-game-desk: 宿主未提供 slots 服务'))
        return
      }

      // 页面回话 → 输入框
      ctx.effect(function () {
        const onMessage = function (ev) {
          if (ev.origin !== window.location.origin) return
          const data = ev.data
          if (!data || data.source !== 'game-desk') return
          const reply = function (ok) {
            try {
              if (ev.source) {
                ev.source.postMessage({ source: 'dsh-game-desk', type: 'filled', id: data.id || '', ok: !!ok }, ev.origin || '*')
              }
            } catch (e) { /* 页面已经关了，回执丢了没关系 */ }
          }
          if (data.type === 'fill' && typeof data.text === 'string') {
            const submit = data.submit !== false
            const goConversation = function () {
              if (lay && typeof lay.selectPanel === 'function') {
                try { lay.selectPanel(HOME_PANEL) } catch (e) { /* 切不过去就原地重试 */ }
              }
            }
            const ok = fillComposer(data.text, submit)
            beat('fill', (data.id || '-') + ' ok=' + ok)
            // 带 ack 的页面自己决定要不要切过去（案卷台的开局视图留在页里）；
            // 不带 ack 的是老调用方，仍按老样子切回对话。
            if (ok) {
              if (data.ack) { reply(true); return }
              setTimeout(goConversation, 120)
              return
            }
            // 面板打开时主区只渲染一个 main，对话输入框根本不在 DOM 里。
            // 先切回对话，等它挂上再填（最多等 ~1.8 秒）。
            goConversation()
            let tries = 0
            const retry = function () {
              tries += 1
              if (fillComposer(data.text, submit)) {
                beat('fill-retry', (data.id || '-') + ' tries=' + tries)
                if (data.ack) reply(true)
                return
              }
              if (tries >= 18) {
                beat('fill-retry-fail', (data.id || '-') + ' tries=' + tries)
                if (data.ack) reply(false)
                return
              }
              setTimeout(retry, 90)
            }
            setTimeout(retry, 120)
            return
          }
          if (data.type === 'show-conversation') {
            if (lay && typeof lay.selectPanel === 'function') {
              setTimeout(function () { try { lay.selectPanel(HOME_PANEL) } catch (e) {} }, 60)
            }
          }
        }
        window.addEventListener('message', onMessage)
        return function () { window.removeEventListener('message', onMessage) }
      }, 'dsh-game-desk: composer bridge')

      for (const entry of ENTRIES) {
        const Mark = entry.panel === 'arcade' ? ArcadeMark : CaseMark
        ctx.effect(function () {
          try {
            return slots.inject('sidebar.panellist', function () {
              try {
                const d = slots.register({
                  name: 'sidebar.panellist', id: entry.id, order: entry.order,
                  label: function () { return entry.zh },
                }, makeRow(entry, Mark))
                mark('row-ok:' + entry.id)
                beat('row-ok', entry.id)
                return d
              } catch (err) {
                mark('row-fail:' + entry.id, String(err && err.message ? err.message : err))
                beat('row-fail', entry.id + ': ' + String(err && err.message ? err.message : err))
                return function () {}
              }
            })
          } catch (e) {
            mark('row-inject-fail:' + entry.id, String(e && e.message ? e.message : e))
            if (ctx.logger && ctx.logger.warn) ctx.logger.warn(new Error('dsh-game-desk: 入口行注册失败 ' + String(e && e.message ? e.message : e)))
            return function () {}
          }
        }, 'dsh-game-desk: row ' + entry.id)

        ctx.effect(function () {
          try {
            return slots.inject('main', function () {
              try {
                const d = slots.register({ name: 'main', key: entry.id, inject: function () { return {} } }, makePage(entry.panel))
                mark('panel-ok:' + entry.id)
                beat('panel-ok', entry.id)
                return d
              } catch (err) {
                mark('panel-fail:' + entry.id, String(err && err.message ? err.message : err))
                return function () {}
              }
            })
          } catch (e) {
            if (ctx.logger && ctx.logger.warn) ctx.logger.warn(new Error('dsh-game-desk: 面板注册失败 ' + String(e && e.message ? e.message : e)))
            return function () {}
          }
        }, 'dsh-game-desk: panel ' + entry.id)
      }
    }

    /** apply 外面再包一层：真抛出去也能在 gd21:apply-fail 里留下原因。 */
    function apply(ctx) {
      mark('apply')
      try { return applyInner(ctx) } catch (error) {
        mark('apply-fail', String(error && error.message ? error.message : error))
        beat('apply-fail', String(error && error.message ? error.message : error))
        throw error
      }
    }

    exports.apply = apply
    exports.inject = ['slots', 'layout']
    return module.exports
  },
})
