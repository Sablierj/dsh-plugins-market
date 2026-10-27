/**
 * dsh-plugin-amazon-ops — browser half (client bundle).
 *
 * Contributes the **Amazon 运营工作台** entry to the DSH sidebar and the main
 * panel it opens. The panel is an iframe onto the workbench page the server
 * half already serves at `/custom/amazon-ops`; the sidebar owns the button,
 * tooltip, label and selection state, so this bundle only supplies the glyph
 * and the panel body.
 *
 * Hand-written closure factory, same shape tsdown emits for the shipped
 * `dsh-client-ui-*` bundles: `window.__ModuleLoader__.load({ id, factory })`
 * with `require` resolving through the loader module table. No build chain and
 * no third-party imports — `react` is a platform seed module, and `ctx.slots`
 * arrives through cordis DI.
 *
 * Two contracts this file depends on (both source-verified against
 * packages/client/ui-layout and packages/client/ui-sidebar):
 *   - the `main` slot is keyed: registering `{ name:'main', key }` and then
 *     selecting that key renders this panel in the centre column;
 *   - a `sidebar.panellist` entry `{ id, order, label }` becomes the sidebar
 *     row whose id addresses that main panel, and its component receives
 *     `{ size, active }` — it renders a glyph only, not a button.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-amazon-ops",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /** Identity shared by the sidebar row and the main panel it selects. */
    const PANEL_ID = "amazon-ops";
    /** The workbench page registered by the server half's `registerWeb`. */
    const PAGE_PATH = "/custom/amazon-ops";
    /** Sidebar row label; also the tooltip and the iframe's accessible name. */
    const LABEL = "Amazon 运营工作台";
    /** Ascending row order among the global panel icons. */
    const ORDER = 10;

    /**
     * Sidebar glyph. The shell wraps this in its own button, so it must be a
     * bare SVG of `size` px that inherits the row's colour through
     * `currentColor` (which is how the active/inactive states are expressed).
     */
    function AmazonOpsGlyph(props) {
      const size = props && typeof props.size === "number" && props.size > 0 ? props.size : 16;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          xmlns: "http://www.w3.org/2000/svg",
          "aria-hidden": "true",
          focusable: "false",
        },
        h("path", {
          d: "M8 1.7 13.9 4.6v6.8L8 14.3 2.1 11.4V4.6z",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinejoin: "round",
        }),
        h("path", {
          d: "M2.1 4.6 8 7.5l5.9-2.9M8 7.5v6.8",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinejoin: "round",
          strokeLinecap: "round",
        }),
      );
    }

    /**
     * Main panel body: the workbench page, framed. The top padding is the same
     * constant entry pages use to clear the window's top strip (traffic lights
     * / sidebar toggle), so the workbench header is not tucked under it.
     */
    function AmazonOpsPanel() {
      return h(
        "div",
        {
          style: {
            width: "100%",
            height: "100%",
            boxSizing: "border-box",
            paddingTop: "var(--dsh-frame-top-clearance, 0px)",
            overflow: "hidden",
          },
        },
        h("iframe", {
          src: PAGE_PATH,
          title: LABEL,
          style: {
            width: "100%",
            height: "100%",
            border: "0",
            display: "block",
            background: "transparent",
          },
        }),
      );
    }

    /** Only the slot registry is needed; the panel machinery is the shell's. */
    const inject = ["slots"];

    /**
     * Contribute the sidebar entry and the panel it opens. Both registrations
     * ride `slots.inject`, which runs once the owning slot is declared — so
     * this bundle does not race ui-layout (which declares `main`) or ui-sidebar
     * (which declares `sidebar.panellist`).
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: PANEL_ID }, AmazonOpsPanel));
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          { name: "sidebar.panellist", id: PANEL_ID, order: ORDER, label: LABEL },
          AmazonOpsGlyph,
        ));
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
