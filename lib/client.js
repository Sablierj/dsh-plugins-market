/**
 * dsh-plugin-sif-ops — browser 半。
 *
 * 只贡献两样：侧边栏一行、以及它选中的主面板。面板是 `/custom/sif-ops` 的 iframe，
 * 侧边栏自己管按钮/提示/选中态，所以这里只画 glyph 和 iframe。
 *
 * 两条 slot 契约（与 amazon-ops / memory-bridge 同一套，已在本机验证）：
 *   - `main` 是带 key 的：注册 `{name:'main', key}`，选中该 key 时渲染本面板；
 *   - `sidebar.panellist` 的 `{id, order, label}` 变成侧边栏那一行，
 *     它的 id 正是打开 `main` 的 key，组件只收 `{size, active}`，画图标不画按钮。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-sif-ops',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    /** 侧边栏行与主面板共用的身份。 */
    const PANEL_ID = 'sif-ops';
    /** host 半 registerWeb 注册的路径。 */
    const PAGE_PATH = '/custom/sif-ops';
    /** 侧边栏标签（同时是 tooltip 与 iframe 的可访问名）。 */
    const LABEL = 'SIF 数据台';
    /** 紧挨着「Amazon 运营工作台(10)」。 */
    const ORDER = 11;

    /** 三根柱子 + 一条折线：关键词/流量/趋势，一屏能认出来的形状。 */
    function SifGlyph(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', { x: 2.2, y: 8.6, width: 2.6, height: 5.2, rx: 0.6, fill: 'currentColor', opacity: 0.55 }),
        h('rect', { x: 6.7, y: 5.8, width: 2.6, height: 8, rx: 0.6, fill: 'currentColor', opacity: 0.8 }),
        h('rect', { x: 11.2, y: 2.6, width: 2.6, height: 11.2, rx: 0.6, fill: 'currentColor' }),
        h('path', {
          d: 'M2.6 6.4 6.9 4.1l3.5 1.6 3.1-2.1',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          opacity: 0.75,
        }),
      );
    }

    /** 主面板：工作台页面，框进来。顶部留白用 shell 自己的常量，避免被标题栏压住。 */
    function SifPanel() {
      return h(
        'div',
        {
          style: {
            width: '100%',
            height: '100%',
            boxSizing: 'border-box',
            paddingTop: 'var(--dsh-frame-top-clearance, 0px)',
            overflow: 'hidden',
          },
        },
        h('iframe', {
          src: PAGE_PATH,
          title: LABEL,
          style: { width: '100%', height: '100%', border: '0', display: 'block', background: 'transparent' },
        }),
      );
    }

    function apply(ctx) {
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, SifPanel));
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: ORDER, label: LABEL }, SifGlyph),
      );
    }

    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
