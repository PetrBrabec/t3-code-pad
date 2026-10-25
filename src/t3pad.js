// t3-pad: drive T3 Code with a DualSense controller.
// Injected into the T3 renderer over CDP by sidecar/sidecar.mjs. Plain browser JS, no build step.
//
// The "highlight" is the real browser text selection, so T3's own Cite toolbar shows up for it.
// Test hooks: window.__t3pad.press(name), window.__t3pad.state(), and a navigator.getGamepads
// override (the poll loop reads it every tick).
(() => {
  const VERSION = "0.5.0";
  // Re-injection (sidecar reconnect, dev reload) replaces the previous instance.
  window.__t3pad?.dispose?.();
  // Leftovers of an instance that did not clean up (a timer that fired after its dispose).
  document.querySelectorAll("[data-t3pad-ui], [data-t3pad-style]").forEach((n) => n.remove());
  let disposed = false;

  // ---------------------------------------------------------------- config

  const LEVELS = ["message", "paragraph", "sentence", "clause"];
  const LEVEL_LABEL = { message: "Message", paragraph: "Paragraph", sentence: "Sentence", clause: "Clause" };

  // Chromium "standard" gamepad mapping; the DualSense reports this mapping.
  const BUTTONS = {
    cross: 0, circle: 1, square: 2, triangle: 3,
    l1: 4, r1: 5, l2: 6, r2: 7,
    create: 8, options: 9, l3: 10, r3: 11,
    up: 12, down: 13, left: 14, right: 15,
    ps: 16, touchpad: 17,
  };
  const REPEATING = new Set(["up", "down"]);
  const TICK_MS = 16;
  const TOUCH_JUMP = 0.6; // a bigger step between touchpad samples is a new touch, not a move
  const HOLD_MS = 500; // Create held this long opens the t3-pad menu (a shorter press: command palette)

  // Tunables. One table drives the settings page in the menu, the defaults and the stored values
  // (localStorage, per T3 install), and the code reads `cfg.<key>` at use time, so a change applies live.
  // Touchpad positions are -1..1 on both axes (y grows downwards), so the pad is 2 units wide and tall.
  const SETTINGS = [
    { key: "caretSpeed", label: "Caret speed", hint: "characters per slow full-width slide",
      min: 4, max: 40, step: 2, def: 14, fmt: (v) => `${v * 2} chars` },
    { key: "caretAccel", label: "Caret acceleration", hint: "extra characters for a fast finger",
      min: 0, max: 100, step: 10, def: 40, fmt: (v) => (v ? `${v}` : "off") },
    { key: "lineTravel", label: "Vertical travel per line", hint: "how far to slide up or down for one line",
      min: 0.2, max: 1.2, step: 0.05, def: 0.5, fmt: (v) => `${Math.round((v / 2) * 100)} % of the pad` },
    { key: "axisBias", label: "Axis lock", hint: "how much more vertical a slide must be to move lines",
      min: 1, max: 4, step: 0.25, def: 2, fmt: (v) => `${v.toFixed(2)}x` },
    { key: "lockTravel", label: "Axis decision distance", hint: "travel before a slide picks its axis",
      min: 0.02, max: 0.2, step: 0.01, def: 0.06, fmt: (v) => `${Math.round((v / 2) * 100)} % of the pad` },
    { key: "stickScroll", label: "Stick scroll speed", hint: "chat and reply scrolling at full tilt",
      min: 8, max: 80, step: 4, def: 28, fmt: (v) => `${v} px` },
    { key: "repeatDelay", label: "D-pad repeat delay", hint: "hold this long before a step repeats",
      min: 200, max: 800, step: 20, def: 380, fmt: (v) => `${v} ms` },
    { key: "repeatEvery", label: "D-pad repeat rate", hint: "time between repeated steps",
      min: 50, max: 300, step: 10, def: 110, fmt: (v) => `${v} ms` },
    { key: "tapWindow", label: "Multi-click window", hint: "click again within this to grow the selection",
      min: 200, max: 900, step: 50, def: 500, fmt: (v) => `${v} ms` },
    { key: "uiScale", label: "Menu and pill size", hint: "for the glasses",
      min: 0.8, max: 1.6, step: 0.1, def: 1, fmt: (v) => `${Math.round(v * 100)} %` },
  ];
  const STICK_DEADZONE = 0.18;
  const SETTINGS_KEY = "t3pad.settings.v1";
  const cfg = Object.fromEntries(SETTINGS.map((x) => [x.key, x.def]));
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    for (const x of SETTINGS) if (typeof saved[x.key] === "number") cfg[x.key] = clampSetting(x, saved[x.key]);
  } catch {}
  function clampSetting(x, v) {
    const n = Math.round((Math.min(x.max, Math.max(x.min, v)) - x.min) / x.step);
    return +(x.min + n * x.step).toFixed(4);
  }
  function setSetting(key, v) {
    const x = SETTINGS.find((s) => s.key === key);
    if (!x) return;
    cfg[key] = clampSetting(x, v);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(cfg)); } catch {}
  }

  const SEL = {
    row: "[data-timeline-row-kind=message][data-message-id]",
    assistantBody: "[data-assistant-citation-source]",
    userBody: "[data-user-message-body]",
    viewport: "[data-assistant-citation-viewport]",
    scroller: ".messages-timeline-scroll",
    cite: 'button[aria-label="Cite selection in composer"]',
    composer: '[data-testid="composer-editor"]',
    submit: 'button[aria-label="Submit message"]',
    // Modal things Circle should close (image lightbox, palettes); not toasts or composer popovers.
    // The image lightbox is a dialog popup that also carries the floating-layer attribute.
    dialog: '[role="dialog"]:not([data-chat-composer-floating-layer]):not([data-position]):not([data-type]), [role="dialog"][data-slot="dialog-popup"], [role="alertdialog"]:not([data-position])',
    previewWebview: "webview[data-preview-tab]",
    rightPanelToggle: 'button[aria-label="Toggle right panel"]',
    closeFloating: 'button[aria-label="Close floating preview"]',
    citeComment: '[role="dialog"][aria-label="Edit citation comment"]',
    palette: '[data-testid="command-palette"]',
    attachment: 'button[aria-label^="Preview "]',
    banner: "[data-slot=composer-banner]",
    approvalRow: "[data-composer-banner-layout=approval]",
    questionToggle: "[data-pending-user-input-toggle]",
    approvalMore: 'button[aria-label="More approval options"]',
    panelTabbar: "[data-right-panel-tabbar]",
  };
  // Inline nodes in the composer that are not text: citation chips, @mentions, $skills.
  const CHIP_NODES = new Set(["composer-citation", "composer-mention", "composer-skill", "composer-context-reference"]);
  const BLOCK_SEL = "p, li, h1, h2, h3, h4, h5, h6, pre, th, td, blockquote";

  // ---------------------------------------------------------------- state

  const st = {
    level: 2, // sentence
    mode: "chat", // "chat": D-pad walks the transcript; "reply": D-pad edits the composer
    replyLevel: 2,
    touch: null, // { x, y, fx, fy } while a finger is on the touchpad
    chromeTouch: false, // Chromium exposes Gamepad.touchEvents for this pad; ignore the native reader
    nativeTouchAt: 0,
    msgId: null,
    index: -1,
    unit: null,
    pad: null,
    prev: {}, // button name -> pressed
    held: {}, // button name -> { since, lastRepeat }
    log: [], // native calls, for tests
    lastError: null,
  };
  const timers = [];
  const listeners = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    listeners.push(() => target.removeEventListener(type, fn, opts));
  };

  // ---------------------------------------------------------------- look: T3's own theme, glass, icons
  //
  // Everything reads T3's CSS variables (--popover, --border, --radius, --glass-blur, ...) at paint
  // time, so the overlays follow its light/dark theme with no JS. Fonts are inherited from T3's body.
  // Action icons: Lucide (ISC license, the set T3 itself uses), path data copied from lucide-static 1.61.
  // PlayStation button glyphs: drawn here (no third-party artwork).

  const STYLES = `
  [data-t3pad-ui] { position: fixed; z-index: 2147483646; pointer-events: none; user-select: none; font-family: inherit;
    color: var(--popover-foreground, #eee); --t3p-scale: 1; font-size: calc(var(--t3p-base) * var(--t3p-scale)); line-height: 1.35; }
  .t3p-glass { background: color-mix(in oklab, var(--popover, #222) 78%, transparent);
    backdrop-filter: blur(var(--glass-blur, 16px)) saturate(var(--glass-saturation, 1.1));
    -webkit-backdrop-filter: blur(var(--glass-blur, 16px)) saturate(var(--glass-saturation, 1.1));
    border: 1px solid color-mix(in oklab, var(--border, #444) 85%, transparent);
    box-shadow: 0 24px 64px -24px rgb(0 0 0 / .55), inset 0 1px 0 color-mix(in oklab, var(--foreground, #fff) 7%, transparent); }
  [data-t3pad-hud] { --t3p-base: 15px; left: 14px; bottom: 5px; display: flex; align-items: center; gap: .5em; box-sizing: border-box;
    padding: .3em .85em .3em .3em; border-radius: 999px; transition: opacity .25s, left .2s; opacity: 0; white-space: nowrap; }
  [data-t3pad-hud] .t3p-badge { flex: none; }
  [data-t3pad-hud] .t3p-hudtext { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  [data-t3pad-hud][data-narrow] { padding-right: .3em; }
  [data-t3pad-hud][data-narrow] .t3p-hudtext { display: none; }
  [data-t3pad-hud][data-tiny] .t3p-badge > span, [data-t3pad-hud][data-narrow] .t3p-wait > span { display: none; }
  [data-t3pad-ring] { border: 2px solid var(--t3p-accent); border-radius: 12px; transition: left .12s, top .12s, width .12s, height .12s;
    box-shadow: 0 0 0 4px color-mix(in oklab, var(--t3p-accent) 28%, transparent); }
  [data-t3pad-tut] { --t3p-base: clamp(14px, 1.9vh, 22px); left: 50%; top: 4.5em; transform: translateX(-50%); width: min(34em, 90vw);
    box-sizing: border-box; border-radius: calc(var(--radius, .625rem) * 2.4); padding: 1em 1.2em .9em; }
  .t3p-tutbody { display: flex; flex-direction: column; gap: .5em; }
  .t3p-tuttitle { font-weight: 650; font-size: 1.12em; }
  .t3p-tutline { display: flex; align-items: center; gap: .6em; padding: .45em .7em; border-radius: var(--radius, .6rem);
    background: color-mix(in oklab, var(--t3p-accent) 12%, transparent); }
  .t3p-done .t3p-tuttitle { color: var(--success, #3fbf8f); }
  [data-t3pad-big] { left: 50%; top: 50%; transform: translate(-50%, -50%); padding: .6em; border-radius: 18px; --t3p-base: 14px; }
  [data-t3pad-big] img { display: block; max-width: 88vw; max-height: 86vh; border-radius: 12px; }
  [data-t3pad-hud][data-tiny] .t3p-badge { padding: .2em .35em; }
  .t3p-wait { flex: none; font-size: .78em; font-weight: 600; color: var(--t3p-wait, var(--destructive, #e5484d)); display: inline-flex; align-items: center; gap: .3em; }
  .t3p-badge { display: inline-flex; align-items: center; gap: .35em; padding: .2em .65em .2em .5em; border-radius: 999px;
    font-weight: 650; font-size: .82em; letter-spacing: .06em; color: var(--t3p-accent);
    background: color-mix(in oklab, var(--t3p-accent) 18%, transparent); border: 1px solid color-mix(in oklab, var(--t3p-accent) 35%, transparent); }
  .t3p-hudtext { color: var(--popover-foreground); }
  .t3p-muted { color: var(--muted-foreground, #999); }
  .t3p-ico { width: 1.15em; height: 1.15em; flex: none; vertical-align: -.2em; }
  .t3p-glyph { height: 1.5em; width: auto; flex: none; vertical-align: middle; }
  [data-t3pad-menu] { --t3p-base: clamp(14px, 2.05vh, 24px); left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: min(64em, 94vw); max-height: 94vh; overflow: hidden; box-sizing: border-box;
    border-radius: calc(var(--radius, .625rem) * 2.4); padding: 1.1em 1.3em 1em; }
  .t3p-head { display: flex; align-items: center; gap: .6em; margin-bottom: .9em; }
  .t3p-title { font-weight: 650; font-size: 1.15em; }
  .t3p-cols { display: grid; grid-template-columns: 1.15fr 1fr; gap: 1.4em; }
  .t3p-sec { font-size: .72em; font-weight: 650; letter-spacing: .09em; text-transform: uppercase; color: var(--muted-foreground);
    margin: 0 0 .55em; display: flex; align-items: center; gap: .45em; }
  .t3p-rows { display: grid; grid-template-columns: max-content 1fr; column-gap: .9em; row-gap: .38em; align-items: center; }
  .t3p-keys { display: flex; align-items: center; gap: .25em; }
  .t3p-help { display: flex; align-items: center; gap: .5em; }
  .t3p-help .t3p-ico { color: var(--muted-foreground); }
  .t3p-note { margin-top: .8em; padding: .45em .7em; border-radius: var(--radius, .6rem); display: flex; gap: .5em; align-items: center;
    background: color-mix(in oklab, var(--t3p-accent) 12%, transparent); font-size: .9em; }
  .t3p-list { display: flex; flex-direction: column; gap: .15em; }
  .t3p-item { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: .2em .8em; padding: .38em .65em;
    border-radius: var(--control-radius, .5rem); border: 1px solid transparent; }
  .t3p-item.on { background: color-mix(in oklab, var(--accent, #333) 85%, transparent); border-color: color-mix(in oklab, var(--t3p-accent) 45%, transparent); }
  .t3p-item .t3p-hint { grid-column: 1 / -1; font-size: .78em; color: var(--muted-foreground); display: none; }
  .t3p-item.on .t3p-hint { display: block; }
  .t3p-val { display: flex; align-items: center; gap: .35em; font-variant-numeric: tabular-nums; font-weight: 600; }
  .t3p-val .t3p-ico { color: var(--muted-foreground); width: .95em; height: .95em; }
  .t3p-item:not(.on) .t3p-val .t3p-ico { visibility: hidden; }
  .t3p-bar { grid-column: 1 / -1; height: 3px; border-radius: 3px; background: color-mix(in oklab, var(--foreground) 10%, transparent); overflow: hidden; display: none; }
  .t3p-item.on .t3p-bar { display: block; }
  .t3p-bar > i { display: block; height: 100%; background: var(--t3p-accent); }
  .t3p-foot { margin-top: .9em; padding-top: .7em; border-top: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
    display: flex; flex-wrap: wrap; gap: .4em 1.4em; font-size: .85em; color: var(--muted-foreground); }
  .t3p-foot > span { display: inline-flex; align-items: center; gap: .4em; }
  `;
  const MODE_LOOK = {
    chat: { label: "CHAT", icon: "messageSquareText", accent: "var(--info, #5b8def)" },
    reply: { label: "REPLY", icon: "pencilLine", accent: "var(--warning, #e0a03a)" },
    palette: { label: "PALETTE", icon: "command", accent: "var(--success, #3fbf8f)" },
    permission: { label: "PERMISSION", icon: "shieldQuestion", accent: "var(--destructive, #e5484d)" },
    preview: { label: "PREVIEW", icon: "eye", accent: "#b48cf2" },
  };

  const NS = "http://www.w3.org/2000/svg";
  function svg(viewBox, parts, cls, extra = {}) {
    const root = document.createElementNS(NS, "svg");
    root.setAttribute("viewBox", viewBox);
    root.setAttribute("aria-hidden", "true");
    if (cls) root.setAttribute("class", cls);
    for (const [k, v] of Object.entries(extra)) root.setAttribute(k, v);
    for (const [tag, attrs, text] of parts) {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (text) n.textContent = text;
      root.append(n);
    }
    return root;
  }
  const P = (d) => ["path", { d }];
  // Lucide icons (ISC). Stroke icons on a 24 grid.
  const ICONS = {
    messageSquareText: [P("M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"), P("M7 11h10"), P("M7 15h6"), P("M7 7h8")],
    pencilLine: [P("M13 21h8"), P("m15 5 4 4"), P("M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z")],
    command: [P("M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3")],
    settings2: [P("M14 17H5"), P("M19 7h-9"), ["circle", { cx: 17, cy: 17, r: 3 }], ["circle", { cx: 7, cy: 7, r: 3 }]],
    quote: [P("M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"), P("M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z")],
    trash2: [P("M10 11v6"), P("M14 11v6"), P("M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"), P("M3 6h18"), P("M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2")],
    undo2: [P("M9 14 4 9l5-5"), P("M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11")],
    send: [P("M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"), P("m21.854 2.147-10.94 10.939")],
    mic: [P("M12 19v3"), P("M19 10v2a7 7 0 0 1-14 0v-2"), ["rect", { x: 9, y: 2, width: 6, height: 13, rx: 3 }]],
    externalLink: [P("M15 3h6v6"), P("M10 14 21 3"), P("M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6")],
    arrowDownToLine: [P("M12 17V3"), P("m6 11 6 6 6-6"), P("M19 21H5")],
    arrowLeftRight: [P("M8 3 4 7l4 4"), P("M4 7h16"), P("m16 21 4-4-4-4"), P("M20 17H4")],
    x: [P("M18 6 6 18"), P("m6 6 12 12")],
    rotateCcw: [P("M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"), P("M3 3v5h5")],
    textSelect: [P("M14 21h1"), P("M14 3h1"), P("M19 3a2 2 0 0 1 2 2"), P("M21 14v1"), P("M21 19a2 2 0 0 1-2 2"), P("M21 9v1"), P("M3 14v1"), P("M3 9v1"), P("M5 21a2 2 0 0 1-2-2"), P("M5 3a2 2 0 0 0-2 2"), P("M7 12h10"), P("M7 16h6"), P("M7 8h8"), P("M9 21h1"), P("M9 3h1")],
    textCursorInput: [P("M12 20h-1a2 2 0 0 1-2-2 2 2 0 0 1-2 2H6"), P("M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7"), P("M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1"), P("M6 4h1a2 2 0 0 1 2 2 2 2 0 0 1 2-2h1"), P("M9 6v12")],
    chevronsUpDown: [P("m7 15 5 5 5-5"), P("m7 9 5-5 5 5")],
    chevronLeft: [P("m15 18-6-6 6-6")],
    chevronRight: [P("m9 18 6-6-6-6")],
    zoomIn: [["circle", { cx: 11, cy: 11, r: 8 }], ["line", { x1: 21, x2: 16.65, y1: 21, y2: 16.65 }], ["line", { x1: 11, x2: 11, y1: 8, y2: 14 }], ["line", { x1: 8, x2: 14, y1: 11, y2: 11 }]],
    scrollText: [P("M15 12h-5"), P("M15 8h-5"), P("M19 17V5a2 2 0 0 0-2-2H4"), P("M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3")],
    cornerDownLeft: [P("M20 4v7a4 4 0 0 1-4 4H4"), P("m9 10-5 5 5 5")],
    eye: [P("M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"), ["circle", { cx: 12, cy: 12, r: 3 }]],
    shieldQuestion: [P("M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"), P("M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"), P("M12 17h.01")],
    image: [["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2, ry: 2 }], ["circle", { cx: 9, cy: 9, r: 2 }], P("m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21")],
    graduationCap: [P("M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"), P("M22 10v6"), P("M6 12.5V16a6 3 0 0 0 12 0v-3.5")],
    chevronsLeftRight: [P("m9 7-5 5 5 5"), P("m15 7 5 5-5 5")],
    gamepad2: [["line", { x1: 6, x2: 10, y1: 11, y2: 11 }], ["line", { x1: 8, x2: 8, y1: 9, y2: 13 }], ["line", { x1: 15, x2: 15.01, y1: 12, y2: 12 }], ["line", { x1: 18, x2: 18.01, y1: 10, y2: 10 }], P("M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z")],
  };
  const icon = (name) => svg("0 0 24 24", ICONS[name] || [], "t3p-ico",
    { fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" });

  // PlayStation button glyphs. Face buttons in the DualSense colours, the rest neutral.
  const G_FILL = "color-mix(in oklab, var(--foreground, #fff) 10%, transparent)";
  const G_LINE = "color-mix(in oklab, var(--foreground, #fff) 38%, transparent)";
  const G_INK = "var(--popover-foreground, #eee)";
  const FACE = {
    cross: ["#7aa2ff", [["path", { d: "M8 8l8 8M16 8l-8 8" }]]],
    circle: ["#ff6b74", [["circle", { cx: 12, cy: 12, r: 4.6 }]]],
    square: ["#f28ad2", [["rect", { x: 7.6, y: 7.6, width: 8.8, height: 8.8, rx: .6 }]]],
    triangle: ["#3fd6a5", [["path", { d: "M12 6.8l5.6 9.4H6.4z" }]]],
  };
  function glyph(name) {
    const g = (vb, parts) => svg(vb, parts, "t3p-glyph");
    if (FACE[name]) {
      const [hue, sym] = FACE[name];
      const c = `color-mix(in oklab, ${hue} 78%, var(--foreground, #fff))`; // darker on light, lighter on dark
      return g("0 0 24 24", [["circle", { cx: 12, cy: 12, r: 11, fill: G_FILL, stroke: G_LINE, "stroke-width": 1 }],
        ...sym.map(([t, a]) => [t, { ...a, fill: "none", stroke: c, "stroke-width": 2.1, "stroke-linejoin": "round", "stroke-linecap": "round" }])]);
    }
    if (name.startsWith("dpad")) {
      // dpad-ud / dpad-lr: the cross with the used arms lit.
      const lit = name.endsWith("ud") ? ["u", "d"] : ["l", "r"];
      const arm = { u: "M9 1.5h6v7.5H9z", d: "M9 15h6v7.5H9z", l: "M1.5 9H9v6H1.5z", r: "M15 9h7.5v6H15z" };
      return g("0 0 24 24", [["path", { d: "M9 9h6v6H9z", fill: G_FILL }],
        ...Object.entries(arm).map(([k, d]) => ["path", { d, rx: 1, fill: lit.includes(k) ? G_INK : G_FILL, stroke: G_LINE, "stroke-width": .8, "stroke-linejoin": "round" }])]);
    }
    if (/^[LR][12]$/.test(name)) {
      // Bumpers are flat pills, triggers have the taller rounded top.
      const d = name[1] === "1" ? "M3 7.5h26a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H3a3 3 0 0 1-3-3v-4a3 3 0 0 1 3-3z"
        : "M6 3.5h20a6 6 0 0 1 6 6v8a3 3 0 0 1-3 3H3a3 3 0 0 1-3-3v-8a6 6 0 0 1 6-6z";
      return g("0 0 32 24", [["path", { d, fill: G_FILL, stroke: G_LINE, "stroke-width": 1 }],
        ["text", { x: 16, y: name[1] === "1" ? 16.3 : 16.8, "text-anchor": "middle", "font-size": 9.5, "font-weight": 700, fill: G_INK, "font-family": "inherit" }, name]]);
    }
    if (name === "options" || name === "create") {
      const marks = name === "options" ? [P("M10 9h8"), P("M10 12h8"), P("M10 15h8")]
        : [P("M14 7v4"), P("M9.6 9.2l2 2.6"), P("M18.4 9.2l-2 2.6"), P("M10.5 16h7")]; // rays over a base line
      return g("0 0 28 24", [["rect", { x: 5, y: 2, width: 18, height: 20, rx: 9, fill: G_FILL, stroke: G_LINE, "stroke-width": 1 }],
        ...marks.map(([t, a]) => [t, { ...a, stroke: G_INK, "stroke-width": 1.7, "stroke-linecap": "round", fill: "none" }])]);
    }
    if (name === "touchpad") {
      return g("0 0 36 24", [["rect", { x: 1, y: 4, width: 34, height: 16, rx: 4, fill: G_FILL, stroke: G_LINE, "stroke-width": 1 }],
        ["circle", { cx: 21, cy: 12, r: 2.6, fill: G_INK }]]);
    }
    if (name === "lstick" || name === "rstick") {
      return g("0 0 24 24", [["circle", { cx: 12, cy: 12, r: 11, fill: G_FILL, stroke: G_LINE, "stroke-width": 1 }],
        ["circle", { cx: 12, cy: 12, r: 7, fill: "none", stroke: G_LINE, "stroke-width": 1 }],
        ["text", { x: 12, y: 15.4, "text-anchor": "middle", "font-size": 9.5, "font-weight": 700, fill: G_INK, "font-family": "inherit" }, name[0].toUpperCase()]]);
    }
    return document.createTextNode(name);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  let styleEl = null;
  function ensureStyle() {
    if (styleEl?.isConnected) return;
    styleEl = el("style");
    styleEl.setAttribute("data-t3pad-style", "");
    styleEl.textContent = STYLES;
    document.head.appendChild(styleEl);
  }
  function badge(mode) {
    const look = MODE_LOOK[mode];
    const b = el("span", "t3p-badge");
    b.append(icon(look.icon), el("span", null, look.label));
    return b;
  }

  // ---------------------------------------------------------------- pill (mode + last action)

  // While a controller is connected the pill stays up with the mode (CHAT / REPLY / PALETTE) and the
  // level; an action shows its result there for a moment, then the idle text comes back.
  let hud = null;
  let hudTimer = null;
  const uiMode = () => (paletteOpen() ? "palette" : st.preview ? "preview" : st.mode);
  const idleText = () => {
    if (uiMode() === "palette") return paletteHighlighted() || "Command palette";
    if (uiMode() === "preview") return previewText();
    if (st.mode === "permission") return permText();
    return LEVEL_LABEL[st.mode === "reply" ? LEVELS[st.replyLevel] : LEVELS[st.level]];
  };
  function renderPill(text) {
    if (!document.body || disposed) return;
    ensureStyle();
    if (!hud || !hud.isConnected) {
      hud = el("div", "t3p-glass");
      hud.setAttribute("data-t3pad-ui", "");
      hud.setAttribute("data-t3pad-hud", "");
      hud.setAttribute("aria-hidden", "true");
      document.body.appendChild(hud);
    }
    const mode = uiMode();
    hud.style.setProperty("--t3p-accent", MODE_LOOK[mode].accent);
    hud.style.setProperty("--t3p-scale", cfg.uiScale);
    st.pillMode = mode;
    hud.replaceChildren(badge(mode), el("span", "t3p-hudtext", text));
    // A request is waiting and we are not in permission mode: say so, never switch by itself.
    st.pillWaiting = !!pendingKind() && mode !== "permission";
    if (st.pillWaiting) {
      const w = el("span", "t3p-wait");
      w.append(icon("shieldQuestion"), el("span", null, pendingKind() === "question" ? "question waiting, L2" : "request waiting, L2"));
      hud.append(w);
    }
    hud.style.opacity = "1";
    layoutPill();
  }

  // The pill sits at the bottom left of T3's main pane: right of the sidebar when it is open, at the
  // window edge when it is closed, its vertical centre on the sidebar footer row (settings ... update).
  // It never grows into the composer: the text is cut (then dropped) before the composer's left edge.
  const PILL_GAP = 14;
  function layoutPill() {
    if (!hud?.isConnected) return;
    const sidebar = document.querySelector("[data-slot=sidebar]");
    const gap = document.querySelector("[data-slot=sidebar-gap]")?.getBoundingClientRect();
    const open = sidebar?.getAttribute("data-state") !== "collapsed" && gap && gap.width > 1;
    const left = (open ? gap.right : 0) + PILL_GAP;
    const row = document.querySelector("[data-slot=sidebar-footer] [data-slot=sidebar-menu]")?.getBoundingClientRect();
    if (row && row.height > 0 && row.right > 0 && row.bottom <= innerHeight + 1) st.footerCenter = innerHeight - (row.top + row.bottom) / 2;
    const h = hud.offsetHeight || 34;
    const bottom = Math.max(2, (st.footerCenter ?? 22) - h / 2);
    let max = innerWidth - left - PILL_GAP;
    const form = document.querySelector("form[data-chat-composer-form]")?.getBoundingClientRect();
    if (form && form.width && form.bottom > innerHeight - bottom - h && form.right > left) max = Math.min(max, form.left - 10 - left);
    hud.style.left = `${Math.round(left)}px`;
    hud.style.bottom = `${Math.round(bottom)}px`;
    // Shrink in steps until it fits: text cut with an ellipsis, then badge only, then the mode icon only.
    hud.style.maxWidth = "none";
    hud.removeAttribute("data-narrow");
    hud.removeAttribute("data-tiny");
    const badgeW = hud.querySelector(".t3p-badge")?.offsetWidth || 0;
    if (hud.scrollWidth > max && max < badgeW + 70) {
      hud.setAttribute("data-narrow", "");
      if (hud.scrollWidth > max) hud.setAttribute("data-tiny", "");
    }
    if (!hud.hasAttribute("data-narrow")) hud.style.maxWidth = `${Math.max(0, Math.round(max))}px`;
    st.pillRect = { left: Math.round(left), bottom: Math.round(bottom), max: Math.round(max) };
  }
  function toast(text) {
    st.toastUntil = performance.now() + 1400;
    renderPill(text);
    clearTimeout(hudTimer);
    hudTimer = setTimeout(idlePill, 1400);
  }
  function idlePill() {
    if (!hud) return;
    renderPill(idleText());
    if (!st.pad) hud.style.opacity = "0";
    renderMenu();
  }

  // ---------------------------------------------------------------- DOM helpers

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const scroller = () => document.querySelector(SEL.scroller);
  const viewportEl = () => document.querySelector(SEL.viewport) || scroller();

  function messageRows() {
    return [...document.querySelectorAll(SEL.row)]
      .filter((r) => r.getClientRects().length)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }
  const rowById = (id) => (id ? document.querySelector(`${SEL.row}[data-message-id="${CSS.escape(id)}"]`) : null);
  const bodyOf = (row) => row.querySelector(SEL.assistantBody) || row.querySelector(SEL.userBody);

  function isHidden(el) {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      if (e.classList?.contains("sr-only") || e.getAttribute?.("aria-hidden") === "true") return true;
    }
    return false;
  }

  function textNodesOf(root) {
    const out = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.data && !isHidden(n.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n);
    return out;
  }

  /** Map [start, end) character offsets over a block's concatenated text back to a DOM Range. */
  function rangeFromOffsets(nodes, start, end) {
    let pos = 0;
    const r = document.createRange();
    let started = false;
    for (const n of nodes) {
      const len = n.data.length;
      if (!started && start < pos + len) {
        r.setStart(n, start - pos);
        started = true;
      }
      if (started && end <= pos + len) {
        r.setEnd(n, end - pos);
        return r;
      }
      pos += len;
    }
    if (!started) return null;
    const last = nodes[nodes.length - 1];
    r.setEnd(last, last.data.length);
    return r;
  }

  // ---------------------------------------------------------------- segmentation

  const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "sentence" }) : null;

  function sentenceSpans(text) {
    if (segmenter) return [...segmenter.segment(text)].map((s) => [s.index, s.index + s.segment.length]);
    const out = [];
    const re = /[^.!?]+[.!?]*\s*/g;
    let m;
    while ((m = re.exec(text))) out.push([m.index, m.index + m[0].length]);
    return out;
  }

  /** Split a sentence span into clauses after `,` `:` `;` that are followed by whitespace. */
  function clauseSpans(text, [s, e]) {
    const out = [];
    let start = s;
    for (let i = s; i < e - 1; i++) {
      if (",:;".includes(text[i]) && /\s/.test(text[i + 1])) {
        out.push([start, i + 1]);
        start = i + 1;
      }
    }
    out.push([start, e]);
    return out;
  }

  function trimSpan(text, [s, e]) {
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    return [s, e];
  }

  function leafBlocks(body) {
    const all = [...body.querySelectorAll(BLOCK_SEL)].filter((b) => !isHidden(b));
    // A <pre> is one stop; anything else is a stop only if it holds no other block.
    return all.filter(
      (b) => !b.parentElement?.closest("pre") && (b.tagName === "PRE" || !all.some((o) => o !== b && b.contains(o))),
    );
  }

  const mediaIn = (el) => [...el.querySelectorAll("img")].filter((i) => !isHidden(i));
  const linksIn = (el) =>
    [...el.querySelectorAll("a[href]")].filter((a) => !isHidden(a) && !a.querySelector("img") && a.textContent.trim());

  /**
   * Units of one message at a zoom level, in reading order.
   * kind: "text" (range), "code" (range over a <pre>), "link" (anchor), "image" (img).
   */
  function unitsOf(row, level) {
    const body = bodyOf(row);
    if (!body) return [];
    if (level === "message") {
      const r = document.createRange();
      r.selectNodeContents(body);
      return [{ kind: "text", range: r, row }];
    }
    const units = [];
    for (const block of leafBlocks(body)) {
      if (block.tagName === "PRE") {
        const code = block.querySelector("code") || block;
        const r = document.createRange();
        r.selectNodeContents(code);
        units.push({ kind: "code", range: r, el: block, row });
        continue;
      }
      const nodes = textNodesOf(block);
      const text = nodes.map((n) => n.data).join("");
      let spans = [];
      if (text.trim()) {
        if (level === "paragraph") spans = [[0, text.length]];
        else {
          for (const sp of sentenceSpans(text)) {
            if (level === "sentence") spans.push(sp);
            else spans.push(...clauseSpans(text, sp));
          }
        }
      }
      const blockLinks = linksIn(block);
      for (const sp of spans) {
        const [s, e] = trimSpan(text, sp);
        if (e <= s) continue;
        const range = rangeFromOffsets(nodes, s, e);
        if (!range) continue;
        units.push({ kind: "text", range, row });
        for (const a of blockLinks) {
          if (range.intersectsNode(a)) units.push({ kind: "link", el: a, row, range: rangeOver(a) });
        }
      }
      for (const img of mediaIn(block)) units.push({ kind: "image", el: img, row, range: rangeAround(img) });
    }
    // Images outside any text block.
    for (const img of mediaIn(body)) {
      if (!units.some((u) => u.el === img)) units.push({ kind: "image", el: img, row, range: rangeAround(img) });
    }
    // Attached images of a user message sit above its text, outside the body.
    const attached = mediaIn(row).filter((img) => !body.contains(img) && img.closest(SEL.attachment));
    units.unshift(...attached.map((img) => ({ kind: "image", el: img, row, range: rangeAround(img) })));
    // De-duplicate links that sit in several clauses of the same sentence.
    const seen = new Set();
    return units.filter((u) => (u.kind === "link" ? !seen.has(u.el) && seen.add(u.el) : true));
  }

  function rangeOver(el) {
    const r = document.createRange();
    r.selectNodeContents(el);
    return r;
  }
  function rangeAround(el) {
    const r = document.createRange();
    r.selectNode(el);
    return r;
  }

  const unitText = (u) => (u.kind === "image" ? `[image ${u.el.getAttribute("alt") || ""}]` : u.range.toString());

  // ---------------------------------------------------------------- scrolling & selection

  function rectOf(u) {
    const rects = u.range ? [...u.range.getClientRects()].filter((r) => r.width || r.height) : [];
    if (rects.length) {
      const top = Math.min(...rects.map((r) => r.top));
      const bottom = Math.max(...rects.map((r) => r.bottom));
      return { top, bottom, left: rects[0].left, right: rects[rects.length - 1].right, last: rects[rects.length - 1], first: rects[0] };
    }
    const r = (u.el || u.row).getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, last: r, first: r };
  }

  /** Scroll so the unit's first line sits in the comfortable band of the transcript. Returns true if it scrolled. */
  function ensureVisible(u) {
    const sc = scroller();
    if (!sc) return false;
    const box = sc.getBoundingClientRect();
    const r = rectOf(u);
    let topBand = box.top + box.height * 0.12;
    if (tutEl?.isConnected) topBand = Math.max(topBand, tutEl.getBoundingClientRect().bottom + 16); // not under the tutorial card
    const bottomBand = box.bottom - box.height * 0.28;
    let delta = 0;
    if (r.top < topBand) delta = r.top - topBand;
    else if (r.top > bottomBand || r.bottom > box.bottom - 8) {
      delta = Math.min(r.top - topBand, r.bottom - (box.bottom - box.height * 0.2));
      delta = Math.max(delta, r.top - bottomBand);
    }
    if (Math.abs(delta) < 2) return false;
    sc.scrollTop += delta;
    return true;
  }

  /**
   * Put the unit into the real selection and walk T3's selection observer through a mouse-style
   * gesture (pointerdown inside the transcript, selection change, mouseup). That is the path that
   * makes the Cite toolbar appear; a programmatic addRange alone is ignored when the window is not
   * focused or has blurred.
   */
  async function select(u) {
    if (ensureVisible(u)) await sleep(70); // let T3's scroll handler run before the gesture
    const sel = window.getSelection();
    const range = u.range;
    if (!range) return;
    const r = rectOf(u);
    const target = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement) || u.row;
    const base = { bubbles: true, cancelable: true, composed: true, isPrimary: true, pointerId: 1, pointerType: "mouse", button: 0, view: window, detail: 1 };
    target.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1, clientX: r.first.left + 1, clientY: r.first.top + 2 }));
    sel.removeAllRanges();
    sel.addRange(range);
    await sleep(0);
    const up = { ...base, buttons: 0, clientX: r.last.right - 1, clientY: r.last.bottom - 2 };
    target.dispatchEvent(new PointerEvent("pointerup", up));
    target.dispatchEvent(new MouseEvent("mouseup", up));
  }

  // ---------------------------------------------------------------- navigation

  const level = () => LEVELS[st.level];

  function currentRow() {
    const row = rowById(st.msgId);
    return row && row.getClientRects().length ? row : null;
  }

  function unitStillValid() {
    if (!st.unit || !currentRow()) return false;
    const r = rectOf(st.unit);
    const box = (scroller() || document.body).getBoundingClientRect();
    return r.bottom > box.top && r.top < box.bottom && !(r.top === 0 && r.bottom === 0);
  }

  /** Pick a starting unit from what is on screen (after free scrolling, a thread switch, or first use). */
  function anchorFromViewport(direction) {
    const box = (scroller() || document.body).getBoundingClientRect();
    const rows = messageRows().filter((r) => {
      const b = r.getBoundingClientRect();
      return b.bottom > box.top && b.top < box.bottom;
    });
    if (!rows.length) return null;
    const lv = level();
    const candidates = [];
    for (const row of rows) unitsOf(row, lv).forEach((u, i) => candidates.push({ u, i, row }));
    const visible = candidates.filter(({ u }) => {
      const r = rectOf(u);
      return r.top >= box.top - 1 && r.top < box.bottom - 20;
    });
    const pool = visible.length ? visible : candidates;
    return direction < 0 ? pool[pool.length - 1] : pool[0];
  }

  async function setUnit(row, index, units) {
    const u = units[index];
    st.msgId = row.dataset.messageId;
    st.index = index;
    st.unit = u;
    await select(u);
  }

  /** Find the message row after/before `row`, scrolling the virtualized list to mount it if needed. */
  async function neighbourRow(row, direction) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const rows = messageRows();
      const i = rows.indexOf(row);
      if (i < 0) return null;
      const next = rows[i + direction];
      if (next) return next;
      const sc = scroller();
      if (!sc) return null;
      const before = sc.scrollTop;
      sc.scrollTop += direction * sc.clientHeight * 0.7;
      await sleep(90);
      if (sc.scrollTop === before) return null; // at the end
    }
    return null;
  }

  async function move(direction) {
    const lv = level();
    if (!unitStillValid()) {
      const a = anchorFromViewport(direction);
      if (!a) return toast("No messages here");
      const units = unitsOf(a.row, lv);
      return setUnit(a.row, a.i, units);
    }
    let row = currentRow();
    let units = unitsOf(row, lv);
    let index = indexOfCurrent(units);
    let next = index + direction;
    while (next < 0 || next >= units.length) {
      const nrow = await neighbourRow(row, direction);
      if (!nrow) return toast(direction > 0 ? "End of thread" : "Start of thread");
      row = nrow;
      units = unitsOf(row, lv);
      next = direction > 0 ? 0 : units.length - 1;
    }
    await setUnit(row, next, units);
  }

  /** Index of the stored unit in a freshly computed list (DOM may have re-rendered). */
  function indexOfCurrent(units) {
    if (!st.unit) return 0;
    const exact = units.findIndex((u) => u.kind === st.unit.kind && sameRange(u, st.unit));
    if (exact >= 0) return exact;
    return Math.min(Math.max(st.index, 0), units.length - 1);
  }
  function sameRange(a, b) {
    if (a.el && b.el) return a.el === b.el;
    try {
      return (
        a.range.compareBoundaryPoints(Range.START_TO_START, b.range) === 0 &&
        a.range.compareBoundaryPoints(Range.END_TO_END, b.range) === 0
      );
    } catch {
      return false;
    }
  }

  async function zoom(delta) {
    // A highlight smaller than a unit of this level (a tapped word) first grows to that unit.
    const grow = delta < 0 && unitStillValid() && st.unit.kind === "text" && !unitsOf(currentRow(), level()).some((u) => sameRange(u, st.unit));
    const nextLevel = grow ? st.level : Math.max(0, Math.min(LEVELS.length - 1, st.level + delta));
    if (nextLevel === st.level && !grow) return toast(LEVEL_LABEL[level()]);
    const prevUnit = unitStillValid() ? st.unit : null;
    st.level = nextLevel;
    toast(LEVEL_LABEL[level()]);
    if (!prevUnit) return;
    const row = currentRow();
    const units = unitsOf(row, level());
    if (!units.length) return;
    // The unit at the new level that contains (zoom in) or starts at/before (zoom out) the old start.
    let idx = 0;
    for (let i = 0; i < units.length; i++) {
      if (!units[i].range || !prevUnit.range) continue;
      try {
        if (units[i].range.compareBoundaryPoints(Range.START_TO_START, prevUnit.range) <= 0) idx = i;
        else break;
      } catch {}
    }
    if (units[idx].kind !== "text" && units[idx].kind !== "code") {
      const t = units.findIndex((u, i) => i >= idx && (u.kind === "text" || u.kind === "code"));
      if (t >= 0) idx = t;
    }
    await setUnit(row, idx, units);
  }

  // ---------------------------------------------------------------- reply mode (composer editing)
  //
  // The composer is a Tiptap (ProseMirror) editor; its instance hangs off the DOM node as `.editor`.
  // Everything here goes through editor commands so the editor state (what gets sent) follows, not
  // just the DOM. Units are computed over the ProseMirror doc: every inline chip is a stop of its own
  // (NodeSelection), text between chips is split by paragraph / sentence / clause.

  const editorEl = () => document.querySelector(SEL.composer);
  const editor = () => editorEl()?.editor || null;
  const replyLevel = () => LEVELS[st.replyLevel];

  function replyUnits(e, lv) {
    const doc = e.state.doc;
    const blocks = [];
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      blocks.push({ node, from: pos + 1, to: pos + node.nodeSize - 1 });
      return false;
    });
    if (!blocks.length) return [];
    if (lv === "message") {
      const from = blocks[0].from;
      const to = blocks[blocks.length - 1].to;
      return to > from ? [{ kind: "text", from, to }] : [];
    }
    const units = [];
    const pushText = (from, to) => {
      if (to <= from) return;
      // Leaves (hard breaks) count as one character, so offsets map 1:1 to doc positions.
      const text = doc.textBetween(from, to, "\n", "\n");
      if (text.length !== to - from) return; // should not happen; skip rather than misplace
      let spans = [];
      if (lv === "paragraph") spans = [[0, text.length]];
      else for (const sp of sentenceSpans(text)) lv === "sentence" ? spans.push(sp) : spans.push(...clauseSpans(text, sp));
      for (const sp of spans) {
        const [s, t] = trimSpan(text, sp);
        if (t > s) units.push({ kind: "text", from: from + s, to: from + t });
      }
    };
    for (const b of blocks) {
      let runStart = b.from;
      b.node.forEach((child, offset) => {
        const pos = b.from + offset;
        if (CHIP_NODES.has(child.type.name)) {
          pushText(runStart, pos);
          units.push({ kind: "chip", from: pos, to: pos + child.nodeSize, name: child.type.name });
          runStart = pos + child.nodeSize;
        }
      });
      pushText(runStart, b.to);
    }
    return units;
  }

  function replySelection(e) {
    const s = e.state.selection;
    return { from: s.from, to: s.to, empty: s.empty, node: !!s.node };
  }

  /**
   * Focus the editor keeping its own selection. Also when it still counts as focused but the DOM
   * selection has moved into the transcript (chat-mode highlight): view.focus() writes the editor's
   * selection back into the DOM, which is where a paste or execCommand lands.
   */
  function focusEditor(e) {
    const sel = window.getSelection();
    const inside = sel?.rangeCount && e.view.dom.contains(sel.anchorNode);
    if (!e.view.hasFocus() || !inside) e.view.focus();
  }

  function selectReplyUnit(e, u) {
    focusEditor(e);
    if (u.kind === "chip") e.chain().setNodeSelection(u.from).scrollIntoView().run();
    else e.chain().setTextSelection({ from: u.from, to: u.to }).scrollIntoView().run();
  }

  function replyMove(direction) {
    const e = editor();
    if (!e) return toast("No composer");
    const units = replyUnits(e, replyLevel());
    if (!units.length) return toast("Reply is empty");
    const s = replySelection(e);
    let next;
    const exact = units.findIndex((u) => u.from === s.from && u.to === s.to);
    if (exact >= 0) next = exact + direction;
    else if (direction > 0) next = units.findIndex((u) => u.to > s.from); // unit under or after the caret
    else next = units.findLastIndex((u) => u.from < (s.empty ? s.from : s.to)); // under or before
    if (next < 0 || next >= units.length) return toast(direction > 0 ? "End of reply" : "Start of reply");
    selectReplyUnit(e, units[next]);
  }

  function replyZoom(delta) {
    const prevLevel = st.replyLevel;
    const nextLevel = Math.max(0, Math.min(LEVELS.length - 1, st.replyLevel + delta));
    st.replyLevel = nextLevel;
    toast(LEVEL_LABEL[replyLevel()]);
    const e = editor();
    if (!e) return;
    const s = replySelection(e);
    if (s.empty) return; // a caret stays a caret; the next D-pad step uses the new level
    // A selection smaller than a unit of the old level (a tapped word) grows to that unit first.
    const old = replyUnits(e, LEVELS[prevLevel]);
    if (delta < 0 && !old.some((x) => x.from === s.from && x.to === s.to)) {
      const holder = old.find((x) => x.from <= s.from && x.to >= s.to);
      if (holder) {
        st.replyLevel = prevLevel;
        toast(LEVEL_LABEL[replyLevel()]);
        return selectReplyUnit(e, holder);
      }
    }
    const units = replyUnits(e, replyLevel());
    // The unit at the new level that holds the old start (else the last one starting before it).
    let u = units.find((x) => x.from <= s.from && x.to > s.from) || units.findLast((x) => x.from <= s.from) || units[0];
    if (u) selectReplyUnit(e, u);
  }

  function replyDelete() {
    const e = editor();
    if (!e) return toast("No composer");
    const s = replySelection(e);
    if (s.empty) return toast("Nothing selected");
    let { from, to } = s;
    if (!s.node) {
      // Take one neighbouring space with a deleted sentence or clause, so no double space is left.
      const doc = e.state.doc;
      const after = to < doc.content.size ? doc.textBetween(to, Math.min(to + 1, doc.content.size), "\n", "\n") : "";
      const before = from > 0 ? doc.textBetween(Math.max(from - 1, 0), from, "\n", "\n") : "";
      if (after === " " && (before === " " || before === "" || before === "\n")) to += 1;
      else if (before === " " && (after === "" || after === "\n" || /[.,:;!?]/.test(after))) from -= 1;
    }
    focusEditor(e);
    e.chain().setTextSelection({ from, to }).deleteSelection().scrollIntoView().run();
    toast("Deleted");
  }

  function replyUndo() {
    const e = editor();
    if (!e) return toast("No composer");
    focusEditor(e);
    toast(e.commands.undo() ? "Undo" : "Nothing to undo");
  }

  function enterReply() {
    const e = editor();
    if (!e) return toast("No composer");
    st.mode = "reply";
    focusEditor(e);
    e.commands.scrollIntoView();
    toast(LEVEL_LABEL[replyLevel()]);
  }

  async function exitReply(quiet) {
    st.mode = "chat";
    st.touch = null;
    const e = editor();
    if (e?.view.hasFocus()) e.view.dom.blur(); // the editor keeps its selection for next time
    if (quiet) return idlePill();
    toast(LEVEL_LABEL[level()]);
    if (unitStillValid()) await select(st.unit);
  }

  async function replyCircle() {
    const e = editor();
    const s = e && replySelection(e);
    if (s && !s.empty) {
      focusEditor(e);
      e.commands.setTextSelection(s.to);
      return toast("Caret");
    }
    await exitReply();
  }

  // ---------------------------------------------------------------- touchpad caret
  //
  // Like holding the iOS space bar: horizontal slide moves the caret by character (faster finger,
  // bigger steps), vertical slide by line. Fed by Gamepad.touchEvents when Chromium exposes them,
  // otherwise by the native reader (touch/main.swift) through the sidecar.

  // Each slide is locked to one axis. Until it has travelled `lockTravel` it moves nothing; then
  // the axis whose travel is bigger wins, horizontal travel counting `axisBias` times (so a sloppy
  // sideways slide never jumps lines), and the travel so far is credited to that axis.
  function touchSample(down, x, y) {
    if (!down) {
      st.touch = null;
      return;
    }
    const t = st.touch;
    if (!t || Math.hypot(x - t.x, y - t.y) > TOUCH_JUMP) {
      // New touch: anchor only, and remember the caret in case this touch turns out to be a click.
      const s = st.mode === "reply" ? editor()?.state.selection : null;
      st.touch = { x, y, fx: 0, fy: 0, sx: 0, sy: 0, axis: null, since: performance.now(), moved: false,
        clicked: !!st.prev.touchpad, startSel: s ? { from: s.from, to: s.to, node: !!s.node } : null };
      return;
    }
    let dx = x - t.x;
    let dy = y - t.y;
    t.x = x;
    t.y = y;
    if (st.mode !== "reply" || t.clicked || st.prev.touchpad || menu || paletteOpen()) return;
    let gain = 1 + Math.min(5, Math.abs(dx) * cfg.caretAccel);
    if (!t.axis) {
      t.sx += dx;
      t.sy += dy;
      const h = Math.abs(t.sx) * cfg.axisBias;
      const v = Math.abs(t.sy);
      if (Math.max(h, v) < cfg.lockTravel) return;
      t.axis = v > h ? "y" : "x";
      [dx, dy, gain] = [t.sx, t.sy, 1];
    }
    if (t.axis === "x") t.fx += dx * cfg.caretSpeed * gain;
    else t.fy += dy / cfg.lineTravel;
    const chars = Math.trunc(t.fx);
    const lines = Math.trunc(t.fy);
    t.fx -= chars;
    t.fy -= lines;
    if (chars || lines) {
      t.moved = true;
      st.caretMovedAt = performance.now();
      moveCaret(chars, lines);
    }
  }

  function moveCaret(chars, lines) {
    const e = editor();
    if (!e) return;
    focusEditor(e);
    if (lines) {
      // Lines are a layout question: let the browser move the DOM caret, ProseMirror reads it back.
      const sel = window.getSelection();
      if (!e.state.selection.empty) e.commands.setTextSelection(lines < 0 ? e.state.selection.from : e.state.selection.to);
      for (let i = 0; i < Math.min(Math.abs(lines), 20); i++) sel.modify("move", lines < 0 ? "backward" : "forward", "line");
      e.view.domObserver?.flush?.();
    }
    if (chars) {
      const s = e.state.selection;
      const size = e.state.doc.content.size;
      const start = s.empty ? s.head : chars < 0 ? s.from : s.to;
      const step = Math.sign(chars);
      let pos = Math.max(0, Math.min(size, start + chars));
      // Skip positions between blocks (they hold no caret); one paragraph break costs one step.
      while (pos > 0 && pos < size && !e.state.doc.resolve(pos).parent.inlineContent) pos += step;
      e.chain().setTextSelection(pos).scrollIntoView().run(); // chips count as one step
    } else {
      e.commands.scrollIntoView();
    }
  }

  // ---------------------------------------------------------------- touchpad click: tap to select
  //
  // Like a touch screen: a click selects the word at the caret (reply mode) or the first word of the
  // highlight (chat mode), a second click soon after grows it to the sentence, a third to the
  // paragraph. The result is an ordinary selection, so Square, R2 and the D-pad act on it.

  const wordSegmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;
  const TAP_STAGES = ["word", "sentence", "paragraph"];

  /** [start, end) of the word at offset `at` in `text`: the word under it, else the one ending at it, else the next. */
  function wordSpanAt(text, at) {
    const words = wordSegmenter
      ? [...wordSegmenter.segment(text)].filter((w) => w.isWordLike).map((w) => [w.index, w.index + w.segment.length])
      : [...text.matchAll(/[\p{L}\p{N}_'’-]+/gu)].map((m) => [m.index, m.index + m[0].length]);
    return words.find(([s, e]) => s <= at && at < e) || words.find(([, e]) => e === at) || words.find(([s]) => s >= at) || words.at(-1) || null;
  }

  async function tapSelect() {
    const now = performance.now();
    const lt = st.lastTap;
    const same = lt && lt.mode === st.mode && now - lt.at < cfg.tapWindow && lt.key === tapKey();
    const stage = same ? Math.min(lt.stage + 1, TAP_STAGES.length - 1) : 0;
    const anchor = same ? lt.anchor : null;
    const res = st.mode === "reply" ? replyTap(stage, anchor) : await chatTap(stage, anchor);
    if (!res) return;
    st.lastTap = { mode: st.mode, at: performance.now(), stage, anchor: res.anchor, key: tapKey() };
    toast(LEVEL_LABEL[TAP_STAGES[stage]] || "Word");
  }
  function tapKey() {
    if (st.mode === "reply") {
      const s = editor()?.state.selection;
      return s ? `${s.from}-${s.to}` : null;
    }
    return st.unit;
  }

  function replyTap(stage, anchor) {
    const e = editor();
    if (!e) return toast("No composer");
    const doc = e.state.doc;
    const pos = anchor ?? e.state.selection.from;
    if (stage === 0) {
      const $p = doc.resolve(pos);
      if (!$p.parent.inlineContent) return toast("Reply is empty");
      const start = $p.start();
      const text = doc.textBetween(start, $p.end(), "\n", "\ufffc"); // chips are one non-word character
      const w = wordSpanAt(text, pos - start);
      focusEditor(e);
      if (!w) {
        // No word in this paragraph: a chip next to the caret is the next best thing.
        const chip = [$p.nodeAfter, $p.nodeBefore].find((n) => n && CHIP_NODES.has(n.type.name));
        if (!chip) return toast("No word here");
        e.chain().setNodeSelection(chip === $p.nodeAfter ? pos : pos - chip.nodeSize).scrollIntoView().run();
        return { anchor: pos };
      }
      e.chain().setTextSelection({ from: start + w[0], to: start + w[1] }).scrollIntoView().run();
      st.replyLevel = LEVELS.indexOf("clause"); // D-pad right then grows it to its clause
      return { anchor: pos };
    }
    const lv = TAP_STAGES[stage];
    const units = replyUnits(e, lv).filter((u) => u.kind === "text");
    const u = units.find((x) => x.from <= pos && pos <= x.to) || units.findLast((x) => x.from <= pos) || units[0];
    if (!u) return toast("Reply is empty");
    st.replyLevel = LEVELS.indexOf(lv);
    selectReplyUnit(e, u);
    return { anchor: pos };
  }

  async function chatTap(stage, anchor) {
    if (!unitStillValid() || !st.unit.range) return toast("Nothing highlighted");
    const row = currentRow();
    if (stage === 0) {
      const r = st.unit.range;
      const startEl = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
      const block = startEl?.closest(BLOCK_SEL) || bodyOf(row);
      const nodes = textNodesOf(block);
      let at = 0;
      for (const n of nodes) {
        if (n === r.startContainer) { at += r.startOffset; break; }
        if (r.comparePoint(n, 0) >= 0) break; // the range starts at an element boundary before n
        at += n.data.length;
      }
      const w = wordSpanAt(nodes.map((n) => n.data).join(""), at);
      const range = w && rangeFromOffsets(nodes, w[0], w[1]);
      if (!range) return toast("No word here");
      st.unit = { kind: "text", range, row };
      await select(st.unit);
      return { anchor: range.cloneRange() };
    }
    const lv = TAP_STAGES[stage];
    st.level = LEVELS.indexOf(lv);
    const units = unitsOf(row, lv);
    let idx = units.findLastIndex((u) => u.range && u.kind === "text" && safeCompare(u.range, anchor) <= 0);
    if (idx < 0) idx = 0;
    if (!units[idx]) return toast("Nothing here");
    await setUnit(row, idx, units);
    return { anchor };
  }
  function safeCompare(a, b) {
    try { return a.compareBoundaryPoints(Range.START_TO_START, b); } catch { return 1; }
  }

  // ---------------------------------------------------------------- command palette mode
  //
  // While T3's command palette is open the pad drives it: its input keeps the focus, and arrow keys,
  // Enter and Escape sent to that input are what T3 (Base UI autocomplete) listens to.

  const paletteEl = () => [...document.querySelectorAll(SEL.palette)].find((d) => d.getClientRects().length) || null;
  const paletteOpen = () => !!paletteEl();
  function paletteKey(key) {
    const p = paletteEl();
    if (!p) return;
    const target = p.querySelector("input") || p;
    const init = { key, code: key, bubbles: true, cancelable: true, composed: true };
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  }
  function paletteHighlighted() {
    const p = paletteEl();
    const id = p?.querySelector("input")?.getAttribute("aria-activedescendant");
    const opt = (id && document.getElementById(id)) || p?.querySelector("[role=option][data-highlighted]");
    return opt?.textContent.trim() || "";
  }
  function paletteStep(direction) {
    paletteKey(direction < 0 ? "ArrowUp" : "ArrowDown");
    const id = paletteEl()?.querySelector("input")?.getAttribute("aria-activedescendant");
    document.getElementById(id || "")?.scrollIntoView({ block: "nearest" });
    setTimeout(idlePill, 30); // the pill shows the highlighted command
  }
  function openPalette() {
    window.dispatchEvent(new CustomEvent("t3code:open-command-palette"));
    toast("Command palette");
  }
  async function closePalette() {
    paletteKey("Escape");
    await sleep(200);
    if (paletteOpen()) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  }

  // ---------------------------------------------------------------- permission mode (L2 while T3 asks)
  //
  // T3 shows an approval ("Approve" / "Decline", more in a "..." menu) or a question (option buttons)
  // in a banner on top of the composer. Never entered by itself: L2 offers the mode only while a
  // request is waiting. Nothing is highlighted until the first D-pad press, so a stray Cross does
  // nothing; Cross answers, then the pad goes back to the mode it came from.

  const pendingBanner = () =>
    [...document.querySelectorAll(SEL.banner)].find((b) => b.getClientRects().length && (b.querySelector(SEL.approvalRow) || b.querySelector(SEL.questionToggle))) || null;
  function pendingKind() {
    const b = pendingBanner();
    return !b ? null : b.querySelector(SEL.approvalRow) ? "approval" : "question";
  }
  const CHOICE_RANK = [/^(approve|allow|accept|yes)/i, /(always|session)/i, /^(decline|deny|reject|no)\b/i, /^cancel/i];
  const rankOf = (t) => { const i = CHOICE_RANK.findIndex((re) => re.test(t)); return i < 0 ? CHOICE_RANK.length : i; };

  /** The choices T3 offers right now, as [{ label, el, menu }] ("menu": only in the "..." menu). */
  async function readChoices() {
    const b = pendingBanner();
    if (!b) return [];
    if (b.querySelector(SEL.questionToggle)) {
      const toggle = b.querySelector(SEL.questionToggle);
      if (toggle.getAttribute("aria-expanded") === "false") { toggle.click(); await sleep(250); }
      return [...b.querySelectorAll("[data-slot=collapsible-panel] button")]
        .filter((x) => x.getClientRects().length && x.textContent.trim())
        .map((x) => ({ label: (x.querySelector("span")?.textContent || x.textContent).trim(), el: x }));
    }
    const out = [...b.querySelectorAll("[data-slot=composer-banner-actions] button")]
      .filter((x) => x.getClientRects().length && x.textContent.trim() && !x.matches(SEL.approvalMore))
      .map((x) => ({ label: x.textContent.trim(), el: x }));
    const more = b.querySelector(SEL.approvalMore);
    if (more) {
      // Read the menu's entries once (it opens for a moment), they are picked later through it.
      more.click();
      await sleep(250);
      for (const it of document.querySelectorAll("[role=menu] [role=menuitem]")) {
        const label = it.textContent.trim();
        if (label && !out.some((c) => c.label === label)) out.push({ label, el: more, menu: true });
      }
      closeMenuPopup();
      await sleep(150);
    }
    return out.sort((a, c) => rankOf(a.label) - rankOf(c.label));
  }
  function closeMenuPopup() {
    const m = document.querySelector("[role=menu]");
    const init = { key: "Escape", code: "Escape", bubbles: true, cancelable: true };
    (m || document).dispatchEvent(new KeyboardEvent("keydown", init));
  }

  let ring = null; // outline over the highlighted T3 element
  let ringTarget = null;
  function showRing(target) {
    ringTarget = target || null;
    if (!target) { ring?.remove(); ring = null; return; }
    ensureStyle();
    if (!ring?.isConnected) {
      ring = el("div");
      ring.setAttribute("data-t3pad-ui", "");
      ring.setAttribute("data-t3pad-ring", "");
      document.body.appendChild(ring);
    }
    const r = target.getBoundingClientRect();
    Object.assign(ring.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
    ring.style.setProperty("--t3p-accent", MODE_LOOK[uiMode()].accent);
  }

  async function enterPermission() {
    if (!pendingKind()) return toast("No request waiting");
    const from = st.mode;
    if (from === "reply") await exitReply(true);
    st.perm = { from, index: -1, choices: await readChoices() };
    st.mode = "permission";
    toast(permText());
  }
  async function exitPermission(note) {
    const from = st.perm?.from || "chat";
    st.perm = null;
    showRing(null);
    st.mode = "chat";
    if (from === "reply") enterReply();
    else toast(note || LEVEL_LABEL[level()]);
  }
  function permText() {
    const p = st.perm;
    if (!p) return "";
    const what = pendingKind() === "question" ? "Answer" : "Approve?";
    return p.index < 0 ? `${what} pick with the D-pad` : `${p.choices[p.index]?.label || ""}  (${p.index + 1}/${p.choices.length})`;
  }
  async function permStep(d) {
    const p = st.perm;
    if (!p.choices.length) p.choices = await readChoices();
    if (!p.choices.length) return toast("No choices");
    p.index = p.index < 0 ? (d > 0 ? 0 : p.choices.length - 1) : Math.max(0, Math.min(p.choices.length - 1, p.index + d));
    showRing(p.choices[p.index].el);
    idlePill();
  }
  async function permConfirm() {
    const p = st.perm;
    const c = p.index >= 0 && p.choices[p.index];
    if (!c) return toast("Pick with the D-pad first");
    showRing(null);
    if (c.menu) {
      c.el.click();
      await sleep(250);
      const item = [...document.querySelectorAll("[role=menu] [role=menuitem]")].find((x) => x.textContent.trim() === c.label);
      if (!item) { closeMenuPopup(); return toast("Choice is gone"); }
      item.click();
    } else c.el.click();
    toast(c.label);
    await sleep(700);
    if (pendingKind()) {
      // The next question of the same request: stay, nothing highlighted again.
      p.index = -1;
      p.choices = await readChoices();
      return idlePill();
    }
    await exitPermission(c.label);
  }

  // ---------------------------------------------------------------- preview mode (after Cross opened something)
  //
  // Entered by itself when Cross opened the image lightbox or something in T3's right panel (web page,
  // file, media, HTML, PR), left when that closes. Lightbox: left / right walk the thread's images.
  // Right panel: D-pad up / down and the left stick scroll it, left / right walk its images (a ring
  // marks the one picked), Cross shows it large, Circle closes (or steps back from the large image).

  /** The right panel: the first ancestor of its tab bar that is about as tall as the window. */
  function panelRoot() {
    let e = document.querySelector(SEL.panelTabbar);
    while (e && e !== document.body && e.getBoundingClientRect().height < innerHeight * 0.6) e = e.parentElement;
    return e && e !== document.body ? e : null;
  }
  const panelWebview = () => [...document.querySelectorAll(SEL.previewWebview)].find(onScreen) || null;
  function panelScroller() {
    const root = panelRoot();
    if (!root) return null;
    let best = null;
    for (const e of root.querySelectorAll("*")) {
      if (e.scrollHeight <= e.clientHeight + 1 || e.clientHeight < 80 || !onScreen(e)) continue;
      const oy = getComputedStyle(e).overflowY;
      if ((oy === "auto" || oy === "scroll") && (!best || e.clientHeight * e.clientWidth > best.clientHeight * best.clientWidth)) best = e;
    }
    return best;
  }
  const activeTabKey = () => [...document.querySelectorAll(`${SEL.panelTabbar} [data-active-tab=true]`)].map((t) => t.innerText.trim()).join("|");

  /** After Cross: did it open a lightbox or something in the right panel? Then preview mode. */
  async function watchPreview(before, img) {
    for (let i = 0; i < 15; i++) {
      await sleep(100);
      if (openDialog()) {
        st.preview = { kind: "lightbox", img, back: st.unit };
        return idlePill();
      }
      if (rightPanelOpen() && (!before.open || activeTabKey() !== before.tab)) {
        st.preview = { kind: "panel", index: -1, big: null, web: false, back: st.unit };
        return idlePill();
      }
    }
  }
  function previewGone() {
    const p = st.preview;
    if (!p || performance.now() - (p.switching || 0) < 1500) return false; // between two images
    if (p.kind === "lightbox") return !openDialog();
    return !rightPanelOpen();
  }
  function previewText() {
    const p = st.preview;
    if (p.kind === "lightbox") {
      const all = threadImages();
      const i = all.indexOf(p.img);
      return i >= 0 ? `Image ${i + 1} of ${all.length}` : "Image";
    }
    if (p.big) return "Image (Circle: back)";
    return p.index >= 0 ? `Image ${p.index + 1} of ${p.count}` : panelWebview() ? "Web preview" : "Right panel";
  }
  /** Every image of the open thread that opens the lightbox, in reading order (mounted rows only). */
  // (Not mediaIn: while the lightbox is open the page behind it is aria-hidden.)
  const threadImages = () => messageRows().flatMap((r) => [...r.querySelectorAll("img")].filter((i) => i.getBoundingClientRect().width > 24));

  async function lightboxStep(d) {
    const p = st.preview;
    const all = threadImages();
    const i = all.indexOf(p.img);
    const next = all[i + d];
    if (!next) return toast(d > 0 ? "Last image" : "First image");
    // T3's lightbox shows one image: close it, open the neighbour.
    p.switching = performance.now();
    closeDialog(openDialog());
    for (let k = 0; k < 10 && openDialog(); k++) await sleep(50);
    next.scrollIntoView({ block: "center" });
    await sleep(60);
    (next.closest(`${SEL.attachment}, a[href]`) || next).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, button: 0, detail: 1 }));
    p.img = next;
    for (let k = 0; k < 10 && !openDialog(); k++) await sleep(60);
    p.switching = 0;
    // The highlight follows, so Circle returns to the last image seen. (unitsOf skips the page behind
    // the lightbox, which is aria-hidden now; the unit is matched by element when the list is rebuilt.)
    const row = next.closest(SEL.row);
    if (row) {
      st.msgId = row.dataset.messageId;
      st.unit = { kind: "image", el: next, row, range: rangeAround(next) };
      p.back = st.unit;
    }
    idlePill();
  }

  async function webEval(expr) {
    const w = panelWebview();
    if (!w?.executeJavaScript) return null;
    try { return await w.executeJavaScript(expr); } catch (e) { st.lastError = `webview: ${e}`; return null; }
  }
  async function panelScroll(dy) {
    if (panelWebview()) return webEval(`window.scrollBy(0, ${Math.round(dy)}), 1`);
    const sc = panelScroller();
    if (sc) sc.scrollTop += dy;
  }
  const panelImages = () => [...(panelRoot()?.querySelectorAll("img") || [])].filter((i) => i.getBoundingClientRect().width > 40 && !i.closest(SEL.panelTabbar));
  async function panelImageStep(d) {
    const p = st.preview;
    if (p.big) return;
    if (panelWebview()) {
      // Inside the web page: same walk, done by a script in the webview (it is its own renderer).
      const r = await webEval(`(() => { const imgs = [...document.images].filter((i) => i.width > 40 && i.height > 24);
        if (!imgs.length) return [0, -1]; let k = window.__t3padImg ?? -1; k = k < 0 ? (${d} > 0 ? 0 : imgs.length - 1) : Math.max(0, Math.min(imgs.length - 1, k + ${d}));
        window.__t3padImg = k; imgs.forEach((i) => (i.style.outline = "")); imgs[k].style.outline = "3px solid #b48cf2"; imgs[k].style.outlineOffset = "3px";
        imgs[k].scrollIntoView({ block: "center" }); return [imgs.length, k]; })()`);
      if (!r || !r[0]) return toast("No images here");
      [p.count, p.index] = r;
      return idlePill();
    }
    const imgs = panelImages();
    if (!imgs.length) return toast("No images here");
    p.count = imgs.length;
    p.index = p.index < 0 ? (d > 0 ? 0 : imgs.length - 1) : Math.max(0, Math.min(imgs.length - 1, p.index + d));
    imgs[p.index].scrollIntoView({ block: "center" });
    await sleep(60);
    showRing(imgs[p.index]);
    idlePill();
  }
  let bigEl = null;
  async function panelOpenImage() {
    const p = st.preview;
    if (p.index < 0) return toast("Pick an image with left / right");
    if (panelWebview()) {
      // Show the image on its own in the preview; Circle goes back to the page.
      const ok = await webEval(`(() => { const imgs = [...document.images].filter((i) => i.width > 40 && i.height > 24); const i = imgs[window.__t3padImg]; if (!i) return 0; location.href = i.currentSrc || i.src; return 1; })()`);
      if (ok) { p.big = "web"; idlePill(); }
      return;
    }
    const img = panelImages()[p.index];
    if (!img) return;
    ensureStyle();
    bigEl = el("div", "t3p-glass");
    bigEl.setAttribute("data-t3pad-ui", "");
    bigEl.setAttribute("data-t3pad-big", "");
    const big = el("img");
    big.src = img.currentSrc || img.src;
    bigEl.append(big);
    document.body.appendChild(bigEl);
    showRing(null);
    p.big = "overlay";
    idlePill();
  }
  async function previewCircle() {
    const p = st.preview;
    if (p.kind === "panel" && p.big) {
      if (p.big === "web") await webEval("history.back(), 1");
      bigEl?.remove();
      bigEl = null;
      await sleep(p.big === "web" ? 400 : 50);
      p.big = null;
      const imgs = panelImages();
      if (imgs[p.index] && !panelWebview()) showRing(imgs[p.index]);
      return toast("Back");
    }
    showRing(null);
    await back();
    leavePreview();
  }
  const previewUD = (d) => (st.preview.kind === "panel" && !st.preview.big ? panelScroll(d * 160) : null);
  const previewLR = (d) => (st.preview.kind === "lightbox" ? lightboxStep(d) : panelImageStep(d));
  const previewCross = () => (st.preview.kind === "panel" ? panelOpenImage() : toast("Circle closes the image"));
  function leavePreview() {
    if (!st.preview) return;
    if (st.preview.web !== undefined && panelWebview()) webEval(`document.images && [...document.images].forEach((i) => (i.style.outline = "")), delete window.__t3padImg, 1`);
    bigEl?.remove();
    bigEl = null;
    st.preview = null;
    showRing(null);
    idlePill();
  }

  // ---------------------------------------------------------------- actions

  function dispatchKey(key, code, mods = {}) {
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
    const init = { key, code, bubbles: true, cancelable: true, composed: true, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: !!mods.alt, ctrlKey: !!mods.ctrl };
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  function resetPosition() {
    st.msgId = null;
    st.index = -1;
    st.unit = null;
  }

  const openDialog = () => [...document.querySelectorAll(SEL.dialog)].find((d) => d.getClientRects().length);

  async function cite() {
    const u = st.unit;
    if (!u) return toast("Nothing selected");
    let btn = document.querySelector(SEL.cite);
    if (!btn) {
      await select(u);
      await sleep(60);
      btn = document.querySelector(SEL.cite);
    }
    if (btn && !btn.disabled) {
      btn.click();
      // T3 then opens an "optional comment" popover; Escape would drop the citation, so Save it empty.
      // Focus returns to the composer, which is where dictation (R2) should paste.
      for (let i = 0; i < 10; i++) {
        await sleep(50);
        const pop = document.querySelector(SEL.citeComment);
        const save = pop && [...pop.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save");
        if (save) {
          save.click();
          break;
        }
      }
      toast("Quoted");
      return true;
    }
    // User messages have no Cite button: fall back to a plain "> quote" in the composer.
    const text = unitText(u).trim();
    if (!text) return false;
    const ok = insertIntoComposer(text.split("\n").map((l) => `> ${l}`).join("\n") + "\n\n");
    toast(ok ? "Quoted (text)" : "Quote failed");
    return ok;
  }

  function focusComposerAtEnd() {
    const ed = document.querySelector(SEL.composer);
    if (!ed) return null;
    ed.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(ed);
    r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return ed;
  }

  function insertIntoComposer(text) {
    const ed = focusComposerAtEnd();
    if (!ed) return false;
    return document.execCommand("insertText", false, text);
  }

  function activate() {
    const u = st.unit;
    if (!u) return toast("Nothing selected");
    let el = null;
    if (u.kind === "link") el = u.el;
    else if (u.kind === "image") el = u.el.closest("a[href]") || u.el;
    else if (u.range) {
      const row = u.row;
      el = [...row.querySelectorAll("a[href], img")].find((a) => u.range.intersectsNode(a)) || null;
    }
    if (!el) return toast("Nothing to open");
    const before = { open: rightPanelOpen(), tab: activeTabKey() };
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, button: 0, detail: 1 }));
    toast(el.tagName === "IMG" ? "Image" : "Open link");
    watchPreview(before, el.tagName === "IMG" ? el : u.kind === "image" ? u.el : null); // not awaited: buttons stay live
  }

  function onScreen(el) {
    const r = el.getBoundingClientRect();
    return r.width > 50 && r.height > 50 && r.left < innerWidth && r.right > 0 && r.top < innerHeight && r.bottom > 0;
  }

  function previewOpen() {
    return [...document.querySelectorAll(SEL.previewWebview)].some(onScreen);
  }

  const visibleEl = (b) => b && b.getBoundingClientRect().width > 0 ? b : null;
  /** T3's right panel (web, file, media, HTML and PR previews, diffs) is open: its toggle is pressed. */
  const rightPanelOpen = () => visibleEl(document.querySelector(SEL.rightPanelToggle))?.getAttribute("aria-pressed") === "true";
  const floatingPreview = () => visibleEl(document.querySelector(SEL.closeFloating));

  /** Close what is open, innermost first: lightbox / dialog, right panel, floating preview, selection. Never navigates. */
  function closeDialog(dlg) {
    if (!dlg) return;
    (dlg.querySelector("[data-dialog-close], button[aria-label='Close']") || null)?.click() ||
      dlg.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  }
  async function back() {
    const dlg = openDialog();
    if (dlg) {
      closeDialog(dlg);
      toast("Close");
      if (st.unit && currentRow()) await sleep(200).then(() => select(st.unit));
      return;
    }
    if (rightPanelOpen() || floatingPreview()) {
      // Whatever the panel shows, T3's own toggle hides it (the tab stays for next time).
      if (rightPanelOpen()) {
        document.querySelector(SEL.rightPanelToggle).click();
        await sleep(300);
      }
      // With "auto show floating preview" on, hiding the panel leaves a floating mini preview.
      floatingPreview()?.click();
      toast("Close preview");
      if (st.unit && currentRow()) await sleep(250).then(() => select(st.unit));
      return;
    }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      sel.removeAllRanges();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      return toast("Cleared");
    }
    toast("Nothing to close");
  }

  async function latest() {
    const sc = scroller();
    if (!sc) return;
    for (let i = 0; i < 6; i++) {
      sc.scrollTop = sc.scrollHeight;
      await sleep(80);
      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) break;
    }
    const rows = messageRows();
    const row = rows[rows.length - 1];
    if (!row) return;
    const units = unitsOf(row, level());
    if (units.length) await setUnit(row, 0, units);
    toast("Latest");
  }

  function thread(direction) {
    dispatchKey(direction < 0 ? "{" : "}", direction < 0 ? "BracketLeft" : "BracketRight", { meta: true, shift: true });
    resetPosition();
    toast(direction < 0 ? "Previous thread" : "Next thread");
  }

  function send() {
    const btn = document.querySelector(SEL.submit);
    if (!btn || btn.disabled) return toast("Nothing to send");
    btn.click();
    st.sentAt = performance.now();
    resetPosition();
    toast("Sent");
  }

  function native(payload) {
    st.log.push(payload);
    if (st.log.length > 50) st.log.shift();
    try {
      if (typeof window.t3padNative === "function") window.t3padNative(JSON.stringify(payload));
      else if (payload.op === "ptt" && payload.down) toast("Dictation helper not connected");
    } catch (e) {
      st.lastError = String(e);
    }
  }

  /**
   * Put the caret where dictation should land without moving it: VoiceInk pastes over the editor's
   * own selection (after a cite that is right after the chip; in reply mode it may be a selection,
   * which the paste replaces). Only an untouched draft (caret still at the very start) goes to the end.
   */
  function focusComposerForDictation() {
    const e = editor();
    if (!e) return focusComposerAtEnd();
    const s = e.state.selection;
    if (st.mode !== "reply" && !e.view.hasFocus() && s.empty && s.from <= 1 && e.state.doc.textContent.length) {
      e.commands.focus("end");
    } else focusEditor(e);
    return editorEl();
  }

  function dictation(down) {
    if (down) {
      // With the palette open, dictation goes into its search field (which has the focus already).
      if (!paletteOpen()) focusComposerForDictation();
      toast("Listening…");
    }
    native({ op: "ptt", down });
    if (!down) st.pttCount = (st.pttCount || 0) + 1;
  }

  /** L2: chat -> reply -> permission (only while T3 asks) -> chat. Also with the menu open, whose sheet follows. */
  async function cycleMode() {
    if (menu) menu.sheet = null;
    if (st.mode === "permission") return exitPermission();
    if (st.mode === "reply") {
      if (pendingKind()) return enterPermission();
      return exitReply();
    }
    return enterReply();
  }

  // One table drives the dispatch, the cheat sheet and the menu's own controls, so they cannot drift.
  // Per row and mode: `do` maps button -> action, `help` is the cheat sheet line (null: not listed),
  // `icon` the Lucide icon next to it. Modes: chat, reply (falls back to chat when absent), palette
  // (T3's command palette is open; buttons without a palette entry do nothing) and menu (the t3-pad
  // menu is open; same rule). `createHold` is Create held for HOLD_MS. Rows without `do` (R2, the
  // sticks, the touchpad slide) are handled in tick() and are here for the sheet only.
  const MAP = [
    { keys: ["dpad-ud"], name: "D-pad",
      chat: { do: { up: () => move(-1), down: () => move(1) }, help: "previous / next piece of text", icon: "chevronsUpDown" },
      reply: { do: { up: () => replyMove(-1), down: () => replyMove(1) }, help: "previous / next piece of your reply", icon: "chevronsUpDown" },
      palette: { do: { up: () => paletteStep(-1), down: () => paletteStep(1) }, help: "previous / next command", icon: "chevronsUpDown" },
      permission: { do: { up: () => permStep(-1), down: () => permStep(1) }, help: "highlight a choice (none until the first press)", icon: "chevronsUpDown" },
      preview: { do: { up: () => previewUD(-1), down: () => previewUD(1) }, help: "scroll the right panel", icon: "scrollText" },
      menu: { do: { up: () => menuMove(-1), down: () => menuMove(1) }, help: "choose" } },
    { keys: ["dpad-lr"], name: "D-pad",
      chat: { do: { left: () => zoom(1), right: () => zoom(-1) }, help: "smaller / bigger: clause, sentence, paragraph, message", icon: "zoomIn" },
      reply: { do: { left: () => replyZoom(1), right: () => replyZoom(-1) }, help: "smaller / bigger: clause, sentence, paragraph, whole reply", icon: "zoomIn" },
      preview: { do: { left: () => previewLR(-1), right: () => previewLR(1) }, help: "previous / next image", icon: "image" },
      menu: { do: { left: () => menuAdjust(-1), right: () => menuAdjust(1) }, help: "change the value" } },
    { keys: ["cross"], name: "Cross",
      chat: { do: { cross: activate }, help: "open the selected link or image", icon: "externalLink" },
      reply: { do: { cross: () => toast("Cross does nothing in reply mode") }, help: null },
      palette: { do: { cross: () => (paletteKey("Enter"), toast("Run")) }, help: "run the highlighted command", icon: "cornerDownLeft" },
      permission: { do: { cross: permConfirm }, help: "answer with the highlighted choice", icon: "cornerDownLeft" },
      preview: { do: { cross: previewCross }, help: "show the picked image large (right panel)", icon: "zoomIn" },
      menu: { do: { cross: menuActivate }, help: "start the tutorial / reset (last rows)" } },
    { keys: ["square"], name: "Square",
      chat: { do: { square: cite }, help: "quote the selection into your reply", icon: "quote" },
      reply: { do: { square: replyDelete }, help: "delete the selection", icon: "trash2" } },
    { keys: ["circle"], name: "Circle",
      chat: { do: { circle: back }, help: "close the image, else the right panel, else clear the selection", icon: "x" },
      reply: { do: { circle: replyCircle }, help: "selection: make it a caret; caret: back to chat", icon: "x" },
      palette: { do: { circle: closePalette }, help: "close the palette", icon: "x" },
      permission: { do: { circle: () => exitPermission("Not answered") }, help: "back without answering", icon: "x" },
      preview: { do: { circle: previewCircle }, help: "close (from a large image: back)", icon: "x" },
      menu: { do: { circle: closeMenu }, help: "close" } },
    { keys: ["triangle"], name: "Triangle",
      chat: { do: { triangle: latest }, help: "jump to the latest message", icon: "arrowDownToLine" },
      reply: { do: { triangle: replyUndo }, help: "undo", icon: "undo2" } },
    { keys: ["L2"], name: "",
      chat: { do: { l2: cycleMode }, help: "edit your reply (reply mode)", icon: "pencilLine" },
      reply: { do: { l2: cycleMode }, help: "back to chat (or to permission while T3 asks)", icon: "messageSquareText" },
      permission: { do: { l2: cycleMode }, help: "back to chat without answering", icon: "messageSquareText" },
      menu: { do: { l2: cycleMode }, help: "switch mode" } },
    { keys: ["L1", "R1"], name: "",
      chat: { do: { l1: () => (exitReply(true), thread(-1)), r1: () => (exitReply(true), thread(1)) }, help: "previous / next thread", icon: "arrowLeftRight" },
      menu: { do: { l1: () => menuSheet(-1), r1: () => menuSheet(1) }, help: "buttons of the other modes" } },
    { keys: ["R2"], name: "hold",
      chat: { help: "dictate (VoiceInk), text lands at the caret", icon: "mic" },
      reply: { help: "dictate, replaces the selection", icon: "mic" },
      permission: { help: "dictate an answer of your own (questions)", icon: "mic" },
      palette: { help: "dictate into the search field", icon: "mic" } },
    { keys: ["options"], name: "Options",
      chat: { do: { options: send }, help: "send", icon: "send" },
      reply: { do: { options: () => (exitReply(true), send()) }, help: "send and go back to chat", icon: "send" } },
    { keys: ["create"], name: "Create",
      chat: { do: { create: openPalette, createHold: openMenu }, help: "tap: command palette; hold: this menu", icon: "command" },
      palette: { do: { create: closePalette, createHold: openMenu }, help: "tap: close; hold: this menu", icon: "command" },
      permission: { do: { createHold: openMenu }, help: "hold: this menu", icon: "command" },
      preview: { do: { createHold: openMenu }, help: "hold: this menu", icon: "command" },
      menu: { do: { create: closeMenu, createHold: closeMenu }, help: "also closes" } },
    { keys: ["touchpad"], name: "click",
      chat: { do: { touchpad: tapSelect }, help: "select the first word; again: sentence, paragraph", icon: "textSelect" },
      reply: { help: "select the word at the caret; again: sentence, paragraph", icon: "textSelect" } },
    { keys: ["touchpad"], name: "slide",
      chat: { help: null },
      reply: { help: "move the caret: sideways by character, up / down by line", icon: "textCursorInput" } },
    { keys: ["lstick"], name: "",
      chat: { help: "scroll the chat", icon: "scrollText" },
      palette: { help: "move through the commands", icon: "chevronsUpDown" },
      preview: { help: "scroll the right panel", icon: "scrollText" } },
    { keys: ["rstick"], name: "", chat: { help: "scroll your reply when it is long", icon: "scrollText" } },
  ];
  const MNEMONIC = "Square acts on the selection: quote it (chat) / delete it (reply)";
  const ACTIONS = { chat: {}, reply: {}, palette: {}, permission: {}, preview: {}, menu: {} };
  for (const row of MAP) for (const m of Object.keys(ACTIONS)) Object.assign(ACTIONS[m], row[m]?.do);
  // Not a button: the tick's self-heal for a highlight whose text was re-rendered (runs in the queue).
  ACTIONS.chat.reselect = async () => {
    const row = currentRow();
    const units = row ? unitsOf(row, level()) : [];
    if (units[st.index] && st.unit?.range?.collapsed) await setUnit(row, st.index, units);
  };
  // Reply mode falls back to the chat action for any button it does not override.
  for (const [k, fn] of Object.entries(ACTIONS.chat)) if (!(k in ACTIONS.reply)) ACTIONS.reply[k] = fn;
  const modeRow = (row, mode) => (mode === "chat" ? row.chat : mode === "reply" ? row.reply || row.chat : row[mode]);

  // ---------------------------------------------------------------- tutorial (welcome card on first run, menu restarts it)
  //
  // Interactive, like a game tutorial: each step names one thing, shows the button and its cheat
  // sheet line (both from MAP, so they cannot drift) and waits until the result is really there.
  // Runs in its own thread ("t3-pad tutorial"), never in real work, and goes back afterwards.
  // Holding Circle skips it (while it runs, a short Circle press still does what Circle does).

  // The tutorial's practice thread (README "Tutorial"). Set your own with
  // localStorage.setItem("t3pad.tutorialThread", "<thread id>"); the default is the author's install.
  const TUTORIAL_THREAD_DEFAULT = "mcp:47488447-5d0b-46cf-adaa-1620d2781ecd";
  const tutorialThread = () => localStorage.getItem("t3pad.tutorialThread") || TUTORIAL_THREAD_DEFAULT;
  const TUTORIAL_KEY = "t3pad.tutorial.v1";
  const tutSeen = () => { try { return !!JSON.parse(localStorage.getItem(TUTORIAL_KEY) || "{}").seen; } catch { return false; } };
  const markTutSeen = () => { try { localStorage.setItem(TUTORIAL_KEY, JSON.stringify({ seen: true, at: Date.now() })); } catch {} };
  const rowFor = (keys, name) => MAP.find((r) => r.keys.join("+") === keys && (name === undefined || r.name === name));
  const chipCount = () => document.querySelectorAll(`${SEL.composer} [data-composer-citation-chip]`).length;
  const docSize = () => editor()?.state.doc.content.size ?? 0;
  const TUT_STEPS = [
    { keys: "dpad-ud", mode: "chat", title: "Pick a sentence", hint: "Press D-pad down or up: the highlight walks the agent's reply.",
      start: () => ({ unit: st.unit }), done: (t) => st.mode === "chat" && st.unit && st.unit !== t.unit && unitStillValid() },
    { keys: "dpad-lr", mode: "chat", title: "Zoom", hint: "D-pad right makes it bigger (paragraph), left smaller (clause).",
      start: () => ({ level: st.level }), done: (t) => st.level !== t.level },
    { keys: "square", mode: "chat", title: "Quote it", hint: "Square quotes the highlight into your reply.",
      start: () => ({ size: docSize(), chips: chipCount() }), done: (t) => chipCount() > t.chips || docSize() > t.size },
    { keys: "L2", mode: "chat", title: "Edit your reply", hint: "L2 switches to reply mode: now the D-pad walks your own reply.",
      done: () => st.mode === "reply" },
    { keys: "square", mode: "reply", title: "Delete a piece", hint: "Pick something with the D-pad (the quote is a stop too), then Square deletes it.",
      start: () => ({ size: docSize() }), done: (t) => st.mode === "reply" && docSize() < t.size },
    { keys: "triangle", mode: "reply", title: "Undo", hint: "Triangle brings it back.",
      start: () => ({ size: docSize() }), done: (t) => docSize() > t.size },
    { keys: "touchpad", name: "slide", mode: "reply", title: "Move the caret", hint: "Slide a finger on the touchpad: sideways by character, up and down by line.",
      start: () => ({ at: performance.now() }), done: (t) => (st.caretMovedAt || 0) > t.at },
    { keys: "R2", mode: "reply", title: "Dictate", hint: "Hold R2 and say a few words (VoiceInk types them at the caret), then let go.",
      start: () => ({ n: st.pttCount || 0 }), done: (t) => (st.pttCount || 0) > t.n },
    { keys: "options", mode: "reply", title: "Send", hint: "Options sends the reply into this practice thread; the agent answers briefly.",
      start: () => ({ at: performance.now() }), done: (t) => (st.sentAt || 0) > t.at },
    { keys: "create", mode: "chat", title: "The menu", hint: "Hold Create: the cheat sheet and the settings. Circle closes it.",
      done: () => !!menu },
  ];

  let tutEl = null;
  function tutorialWelcome() {
    st.tut = { welcome: true };
    renderTutorial();
  }
  async function startTutorial() {
    markTutSeen();
    if (menu) closeMenu();
    const env = location.hash.split("/")[1];
    const route = `#/${env}/${encodeURIComponent(tutorialThread())}`;
    st.tut = { step: 0, from: location.hash !== route ? location.hash : null, route, navigating: true };
    if (st.mode !== "chat") st.mode === "reply" ? await exitReply(true) : await exitPermission();
    if (location.hash !== route) {
      location.hash = route;
      for (let i = 0; i < 30 && !messageRows().length; i++) await sleep(100);
    }
    if (!messageRows().length) {
      endTutorial("Tutorial thread not found (README: Tutorial)");
      return;
    }
    await sleep(300);
    // Start on the agent's practice text: its first message at the top, sentence level.
    const first = messageRows().find((r) => r.querySelector(SEL.assistantBody));
    resetPosition();
    st.level = LEVELS.indexOf("sentence");
    if (first) {
      first.scrollIntoView({ block: "start" });
      renderTutorial(); // the card first, so the highlight is scrolled clear of it
      await sleep(150);
      const units = unitsOf(first, "sentence");
      if (units.length) await setUnit(first, 0, units);
    }
    st.tut.route = location.hash; // as T3 spells it
    st.tut.navigating = false;
    beginStep();
  }
  function beginStep() {
    const t = st.tut;
    if (!t) return;
    const s = TUT_STEPS[t.step];
    t.ctx = s.start ? s.start() : {};
    t.doneAt = 0;
    renderTutorial();
  }
  function endTutorial(note) {
    const t = st.tut;
    st.tut = null;
    tutEl?.remove();
    tutEl = null;
    markTutSeen();
    if (t?.from && !t.welcome) {
      if (st.mode === "reply") exitReply(true);
      location.hash = t.from; // back to the thread it started from
    }
    toast(note || "Tutorial closed");
  }
  /** Polled from tick: advance when the step's result is there. */
  function tutorialTick() {
    const t = st.tut;
    if (!t || t.welcome || t.finished || !t.ctx) return; // (no ctx yet: still loading its thread)
    const s = TUT_STEPS[t.step];
    if (!t.doneAt && s.done(t.ctx)) {
      t.doneAt = performance.now();
      renderTutorial();
    } else if (t.doneAt && performance.now() - t.doneAt > 900) {
      if (t.step + 1 >= TUT_STEPS.length) {
        t.finished = true;
        renderTutorial();
        setTimeout(() => st.tut === t && endTutorial("Tutorial done"), 4000);
      } else {
        t.step++;
        beginStep();
      }
    }
  }
  function renderTutorial() {
    const t = st.tut;
    if (!t || disposed) return;
    ensureStyle();
    if (!tutEl?.isConnected) {
      tutEl = el("div", "t3p-glass");
      tutEl.setAttribute("data-t3pad-ui", "");
      tutEl.setAttribute("data-t3pad-tut", "");
      tutEl.setAttribute("aria-hidden", "true");
      document.body.appendChild(tutEl);
    }
    tutEl.style.setProperty("--t3p-scale", cfg.uiScale);
    const head = el("div", "t3p-head");
    head.append(icon("graduationCap"), el("span", "t3p-title", "t3-pad tutorial"));
    const body = el("div", "t3p-tutbody");
    const foot = el("div", "t3p-foot");
    const footItem = (g, text) => { const f = el("span"); f.append(glyph(g), el("span", null, text)); foot.append(f); };
    if (t.welcome) {
      tutEl.style.setProperty("--t3p-accent", MODE_LOOK.chat.accent);
      body.append(el("div", "t3p-tuttitle", "Welcome! Want a two-minute tour?"),
        el("div", "t3p-muted", "Ten short steps, each waits until you have done it. It runs in its own practice thread, then brings you back here. You can restart it any time from the menu (hold Create)."));
      footItem("cross", "start the tutorial");
      footItem("circle", "not now");
    } else if (t.finished) {
      tutEl.style.setProperty("--t3p-accent", "var(--success, #3fbf8f)");
      body.append(el("div", "t3p-tuttitle", "That's everything. Have fun!"), el("div", "t3p-muted", "The cheat sheet is always one Create hold away. Back to your thread in a moment."));
    } else {
      const s = TUT_STEPS[t.step];
      const row = rowFor(s.keys, s.name);
      const m = row && modeRow(row, s.mode);
      tutEl.style.setProperty("--t3p-accent", MODE_LOOK[s.mode].accent);
      head.append(badge(s.mode), el("span", "t3p-muted", `step ${t.step + 1} of ${TUT_STEPS.length}`));
      const line = el("div", "t3p-tutline");
      const keys = el("span", "t3p-keys");
      row?.keys.forEach((k) => keys.append(glyph(k)));
      if (row?.name) keys.append(el("span", "t3p-muted", row.name));
      line.append(keys, el("span", null, m?.help || ""));
      body.append(el("div", "t3p-tuttitle", t.doneAt ? `${s.title}: done` : s.title), line, el("div", "t3p-muted", s.hint));
      if (t.doneAt) body.classList.add("t3p-done");
      footItem("circle", "hold: skip the tutorial");
    }
    tutEl.replaceChildren(head, body, foot);
  }

  // ---------------------------------------------------------------- menu (hold Create)
  //
  // Cheat sheet for the current mode on the left, settings on the right. Like the pill it takes no
  // focus and no pointer events, so the chat selection, the composer caret and an open palette stay
  // exactly where they were.

  let menu = null; // { index, el } while open
  const menuItems = () => [...SETTINGS.map((x) => ({ type: "setting", x })), { type: "tutorial" }, { type: "reset" }];
  function openMenu() {
    if (menu) return closeMenu();
    menu = { index: 0, el: null };
    renderMenu();
  }
  function closeMenu() {
    menu?.el?.remove();
    menu = null;
    idlePill();
  }
  /** L1 / R1 in the menu: page the cheat sheet through every mode without switching to it. */
  const SHEETS = ["chat", "reply", "palette", "permission", "preview"];
  function menuSheet(d) {
    const cur = SHEETS.indexOf(menu.sheet || uiMode());
    menu.sheet = SHEETS[(cur + d + SHEETS.length) % SHEETS.length];
    renderMenu();
  }
  function menuMove(d) {
    const n = menuItems().length;
    menu.index = (menu.index + d + n) % n;
    renderMenu();
  }
  function menuAdjust(d) {
    const it = menuItems()[menu.index];
    if (it.type !== "setting") return;
    setSetting(it.x.key, cfg[it.x.key] + d * it.x.step);
    renderMenu();
    if (hud) hud.style.setProperty("--t3p-scale", cfg.uiScale);
  }
  function menuActivate() {
    const it = menuItems()[menu.index];
    if (it.type === "tutorial") return startTutorial();
    if (it.type !== "reset") return;
    for (const x of SETTINGS) setSetting(x.key, x.def);
    renderMenu();
    toast("Settings reset");
  }
  function cheatRows(mode) {
    const grid = el("div", "t3p-rows");
    for (const row of MAP) {
      const m = modeRow(row, mode);
      if (!m?.help) continue;
      const keys = el("div", "t3p-keys");
      row.keys.forEach((k) => keys.append(glyph(k)));
      if (row.name) keys.append(el("span", "t3p-muted", row.name));
      const help = el("div", "t3p-help");
      if (m.icon) help.append(icon(m.icon));
      help.append(el("span", null, m.help));
      grid.append(keys, help);
    }
    return grid;
  }
  function renderMenu() {
    if (!menu || disposed) return;
    ensureStyle();
    if (!menu.el?.isConnected) {
      menu.el = el("div", "t3p-glass");
      menu.el.setAttribute("data-t3pad-ui", "");
      menu.el.setAttribute("data-t3pad-menu", "");
      menu.el.setAttribute("aria-hidden", "true");
      document.body.appendChild(menu.el);
    }
    const mode = menu.sheet || uiMode();
    const look = MODE_LOOK[mode];
    menu.el.style.setProperty("--t3p-accent", look.accent);
    menu.el.style.setProperty("--t3p-scale", cfg.uiScale);

    const head = el("div", "t3p-head");
    head.append(icon("gamepad2"), el("span", "t3p-title", "t3-pad"), badge(mode),
      el("span", "t3p-muted", mode === uiMode() ? idleText() : `viewing; you are in ${MODE_LOOK[uiMode()].label}`));

    const left = el("div");
    const secL = el("div", "t3p-sec");
    secL.append(el("span", null, `Buttons in ${look.label.toLowerCase()} mode`));
    left.append(secL, cheatRows(mode));
    if (mode === "chat" || mode === "reply") {
      const note = el("div", "t3p-note");
      note.append(glyph("square"), el("span", null, MNEMONIC));
      left.append(note);
    }

    const right = el("div");
    const secR = el("div", "t3p-sec");
    secR.append(icon("settings2"), el("span", null, "Settings"));
    const list = el("div", "t3p-list");
    menuItems().forEach((it, i) => {
      const row = el("div", `t3p-item${i === menu.index ? " on" : ""}`);
      if (it.type === "setting") {
        const v = cfg[it.x.key];
        const val = el("span", "t3p-val");
        val.append(icon("chevronLeft"), el("span", null, it.x.fmt(v)), icon("chevronRight"));
        const bar = el("div", "t3p-bar");
        const fill = el("i");
        fill.style.width = `${((v - it.x.min) / (it.x.max - it.x.min)) * 100}%`;
        bar.append(fill);
        row.append(el("span", null, it.x.label), val, el("span", "t3p-hint", it.x.hint + (v === it.x.def ? " (default)" : `; default ${it.x.fmt(it.x.def)}`)), bar);
      } else {
        const lab = el("span", "t3p-help");
        if (it.type === "tutorial") lab.append(icon("graduationCap"), el("span", null, "Start the tutorial"));
        else lab.append(icon("rotateCcw"), el("span", null, "Reset to defaults"));
        row.append(lab, glyph("cross"));
      }
      list.append(row);
    });
    right.append(secR, list);

    const cols = el("div", "t3p-cols");
    cols.append(left, right);
    const foot = el("div", "t3p-foot");
    for (const row of MAP) {
      if (!row.menu?.help) continue;
      const f = el("span");
      row.keys.forEach((k) => f.append(glyph(k)));
      f.append(el("span", null, row.menu.help));
      foot.append(f);
    }
    menu.el.replaceChildren(head, cols, foot);
  }

  /**
   * A touchpad click lands with a finger on the pad and may wiggle it: the caret must not move.
   * Moves stop for the rest of that touch, and a touch that began just before the click has its
   * caret put back where the finger landed (the click then selects from there).
   */
  function touchClickGuard() {
    const t = st.touch;
    if (!t) return;
    t.clicked = true;
    const e = editor();
    if (!e || !t.startSel || !t.moved || performance.now() - t.since > 700) return;
    const size = e.state.doc.content.size;
    const { from, to, node } = t.startSel;
    if (to > size) return;
    if (node) e.commands.setNodeSelection(from);
    else e.commands.setTextSelection({ from, to });
  }

  let busy = Promise.resolve();
  let pending = 0;
  function run(name) {
    const mode = menu ? "menu" : uiMode();
    let fn = ACTIONS[mode][name];
    // The welcome card takes Cross (start) and Circle (not now) and nothing else.
    // Any other button puts the card away (later, from the menu) and does its usual thing.
    if (st.tut?.welcome) {
      if (name === "cross") fn = startTutorial;
      else if (name === "circle") fn = () => endTutorial("Tutorial: later, from the menu");
      else endTutorial("Tutorial: later, from the menu");
    }
    if (!fn) return busy;
    pending++;
    busy = busy
      .then(() => fn())
      .catch((e) => {
        st.lastError = `${name}: ${e?.stack || e}`;
        console.warn("[t3pad]", st.lastError);
      })
      .finally(() => {
        pending--;
        renderMenu(); // the mode or level may have changed
      });
    return busy;
  }

  // ---------------------------------------------------------------- gamepad loop

  function pickPad() {
    const pads = (navigator.getGamepads?.() || []).filter(Boolean);
    return pads.find((p) => p.connected !== false && p.buttons?.length >= 16) || null;
  }

  function tick() {
    const pad = pickPad();
    if (!pad) {
      if (st.pad) toast("Controller disconnected");
      st.pad = null;
      return;
    }
    if (!st.pad) {
      toast(`Controller ready (${pad.mapping || "no mapping"})`);
      if (!tutSeen() && !st.tut) tutorialWelcome();
    }
    st.pad = { id: pad.id, mapping: pad.mapping, index: pad.index, touchEvents: Array.isArray(pad.touchEvents) ? "array" : String(pad.touchEvents) };
    const now = performance.now();
    const mode = uiMode();
    if (mode !== st.pillMode && hud) idlePill(); // the palette opened or closed (also by keyboard)
    if (now - (st.layoutAt || 0) > 100) {
      st.layoutAt = now;
      layoutPill(); // follows the sidebar opening, closing and resizing
      if (st.preview && previewGone()) leavePreview(); // closed by the pad, the mouse or the keyboard
      const waiting = !!pendingKind();
      if (st.mode === "permission" && !waiting && !pending) exitPermission("Request answered");
      else if (hud && waiting !== st.pillWaiting && now > (st.toastUntil || 0)) idlePill(); // show / drop the "request waiting" hint
      tutorialTick();
      // A freshly mounted message re-renders once more, which replaces its text nodes and collapses the
      // highlight's range: select the same unit again from its index.
      if (st.mode === "chat" && !menu && !pending && st.unit?.kind === "text" && st.unit.range?.collapsed && st.index >= 0) {
        const row = currentRow();
        const units = row ? unitsOf(row, level()) : [];
        if (units[st.index]) run("reselect");
      }
      if (ringTarget) {
        if (ringTarget.isConnected) showRing(ringTarget);
        else showRing(null);
      }
    }
    for (const [name, i] of Object.entries(BUTTONS)) {
      const b = pad.buttons[i];
      const pressed = !!b && (b.pressed || b.value > 0.5);
      const was = !!st.prev[name];
      st.prev[name] = pressed;
      if (name === "r2") {
        if (pressed !== was) dictation(pressed);
        continue;
      }
      if (name === "circle" && st.tut && !st.tut.welcome) {
        if (pressed && !was) st.held.circle = { since: now, fired: false };
        const h = st.held.circle;
        if (pressed && h && !h.fired && now - h.since >= HOLD_MS) {
          h.fired = true;
          endTutorial("Tutorial skipped");
        } else if (!pressed && was) {
          if (h && !h.fired) run("circle");
          delete st.held.circle;
        }
        continue;
      }
      if (name === "create") {
        // Tap: command palette (on release). Hold: the t3-pad menu (as soon as the hold is long enough).
        if (pressed && !was) st.held.create = { since: now, fired: false };
        const h = st.held.create;
        if (pressed && h && !h.fired && now - h.since >= HOLD_MS) {
          h.fired = true;
          run("createHold");
        } else if (!pressed && was) {
          if (h && !h.fired) run("create");
          delete st.held.create;
        }
        continue;
      }
      const repeats = REPEATING.has(name) || (menu && (name === "left" || name === "right"));
      if (pressed && !was) {
        if (name === "touchpad") touchClickGuard();
        st.held[name] = { since: now, lastRepeat: now };
        run(name);
      } else if (pressed && repeats) {
        const h = st.held[name];
        // Repeat only once the previous step has finished, so a long hold never overshoots after release.
        if (h && !pending && now - h.since > cfg.repeatDelay && now - h.lastRepeat > cfg.repeatEvery) {
          h.lastRepeat = now;
          run(name);
        }
      } else if (!pressed) delete st.held[name];
    }
    // Sticks: left scrolls the transcript (or the open dialog) or walks the palette, right the composer.
    const stickPx = (y) => {
      if (Math.abs(y) <= STICK_DEADZONE) return 0;
      const mag = (Math.abs(y) - STICK_DEADZONE) / (1 - STICK_DEADZONE);
      return Math.sign(y) * mag * mag * cfg.stickScroll;
    };
    const ly = pad.axes?.[1] || 0;
    if (mode === "palette" && !menu) {
      // One command per step; the further the tilt, the faster the steps (300 ms down to 70 ms).
      if (Math.abs(ly) > 0.4) {
        const every = 300 - ((Math.abs(ly) - 0.4) / 0.6) * 230;
        if (!st.stickStepAt || now - st.stickStepAt > every) {
          st.stickStepAt = now;
          paletteStep(Math.sign(ly));
        }
      } else st.stickStepAt = 0;
    } else {
      const lpx = stickPx(ly);
      if (lpx && st.preview?.kind === "panel" && !menu) panelScroll(lpx);
      else if (lpx) {
        const dlg = openDialog();
        const target = dlg?.querySelector("[class*=overflow]") || scroller();
        if (target) target.scrollTop += lpx;
      }
    }
    const rpx = stickPx(pad.axes?.[3] || 0);
    const ed = rpx && editorEl();
    if (ed && ed.scrollHeight > ed.clientHeight + 1) ed.scrollTop += rpx;
    // Touchpad straight from Chromium (only with the GamepadMultitouch flags and a supporting pad).
    // Latch only once Chromium has delivered a touch: an always-empty array must not mute the native reader.
    if (Array.isArray(pad.touchEvents) && (st.chromeTouch || pad.touchEvents.length)) {
      st.chromeTouch = true;
      const t = pad.touchEvents.find((x) => !x.surfaceId) || pad.touchEvents[0];
      const p = t?.position;
      if (p) touchSample(true, p.x ?? p[0], p.y ?? p[1]);
      else if (st.touch) touchSample(false);
    }
  }

  // ---------------------------------------------------------------- install

  function install() {
    timers.push(setInterval(() => {
      try {
        tick();
      } catch (e) {
        st.lastError = `tick: ${e?.stack || e}`;
      }
    }, TICK_MS));
    on(window, "gamepadconnected", (e) => toast(`Controller connected: ${e.gamepad.id.slice(0, 30)}`));
    on(window, "hashchange", () => {
      resetPosition();
      if (st.tut && !st.tut.welcome && !st.tut.navigating && location.hash !== st.tut.route) { st.tut.from = null; endTutorial("Tutorial left"); }
      if (st.mode === "permission") exitPermission("Thread changed");
      leavePreview();
      if (st.mode === "reply") exitReply(true);
    });
  }

  window.__t3pad = {
    version: VERSION,
    alive: true,
    /** Run a button's action as if pressed (test hook). R2: press("r2", true|false). */
    press: (name, down) => (name === "r2" ? (dictation(down !== false), busy) : run(name)),
    /** Native touchpad samples from the sidecar (touch/main.swift). Also the fake-touch test hook. */
    touchNative: (m) => {
      if (m?.op !== "touch" || st.chromeTouch) return;
      st.nativeTouchAt = performance.now();
      touchSample(!!m.down, m.x, m.y);
    },
    composer: () => {
      const e = editor();
      if (!e) return null;
      const s = e.state.selection;
      return {
        text: e.getText(),
        from: s.from, to: s.to, empty: s.empty, node: s.node?.type.name || null,
        selected: e.state.doc.textBetween(s.from, s.to, "\n", (n) => (CHIP_NODES.has(n.type.name) ? "[chip]" : "\n")),
        // Reading order: chips as [chip], text as is.
        parts: (() => { const out = []; e.state.doc.descendants((n) => { if (n.isText) out.push(n.text); else if (CHIP_NODES.has(n.type.name)) out.push("[chip]"); }); return out; })(),
        focused: e.view.hasFocus(),
        scroll: [editorEl().scrollTop, editorEl().scrollHeight, editorEl().clientHeight],
      };
    },
    replyUnits: (lv) => { const e = editor(); return e ? replyUnits(e, lv || replyLevel()).map((u) => ({ ...u, text: e.state.doc.textBetween(u.from, u.to, "\n", "[chip]") })) : []; },
    settings: () => ({ ...cfg }),
    /** Test hooks: the welcome card as on a first run, and the stored "seen" flag. */
    tutorialWelcome: () => tutorialWelcome(),
    tutorialClose: () => { if (st.tut) { st.tut.from = null; endTutorial("Tutorial closed"); } },
    tutorialSeen: (v) => { if (v === false) localStorage.removeItem(TUTORIAL_KEY); else if (v === true) markTutSeen(); return tutSeen(); },
    setSetting,
    /** Test hook: set every tunable from `values` (defaults for the rest) in memory, not stored. */
    loadSettings: (values = {}) => {
      for (const x of SETTINGS) cfg[x.key] = typeof values[x.key] === "number" ? clampSetting(x, values[x.key]) : x.def;
    },
    setReplyLevel: (lv) => {
      const i = LEVELS.indexOf(lv);
      if (i >= 0) st.replyLevel = i;
    },
    state: () => ({
      mode: st.mode,
      replyLevel: replyLevel(),
      hud: hud?.textContent || "",
      hudVisible: hud?.style.opacity === "1",
      uiMode: uiMode(),
      pill: hud ? { ...st.pillRect, rect: hud.getBoundingClientRect().toJSON(), narrow: hud.hasAttribute("data-narrow"), tiny: hud.hasAttribute("data-tiny") } : null,
      menuSheet: menu ? menu.sheet || uiMode() : null,
      pendingKind: pendingKind(),
      queue: pending,
      tutorial: st.tut ? { welcome: !!st.tut.welcome, step: st.tut.step ?? null, title: st.tut.welcome ? "welcome" : st.tut.finished ? "finished" : TUT_STEPS[st.tut.step]?.title, done: !!st.tut.doneAt, text: tutEl?.innerText || "" } : null,
      perm: st.perm ? { from: st.perm.from, index: st.perm.index, choices: st.perm.choices.map((c) => c.label), ring: !!ringTarget } : null,
      preview: st.preview ? { kind: st.preview.kind, index: st.preview.index ?? null, count: st.preview.count ?? null, big: st.preview.big || null, img: st.preview.img?.getAttribute("alt") || null } : null,
      ring: st.perm?.index >= 0 && ringTarget ? st.perm.choices[st.perm.index].label : ringTarget ? (ringTarget.getAttribute("aria-label") || ringTarget.textContent.trim().slice(0, 40) || ringTarget.tagName) : null,
      menu: menu?.el ? menu.el.innerText : null,
      menuIndex: menu ? menu.index : null,
      palette: paletteOpen() ? paletteHighlighted() : null,
      settings: { ...cfg },
      level: level(),
      msgId: st.msgId,
      index: st.index,
      unitKind: st.unit?.kind || null,
      unitText: st.unit ? unitText(st.unit) : null,
      selection: window.getSelection()?.toString() || "",
      citeVisible: !!document.querySelector(SEL.cite),
      pad: st.pad,
      native: st.log.slice(-10),
      lastError: st.lastError,
    }),
    units: (msgId, lv) => {
      const row = rowById(msgId) || messageRows()[0];
      return row ? unitsOf(row, lv || level()).map((u) => ({ kind: u.kind, text: unitText(u) })) : [];
    },
    setLevel: (lv) => {
      const i = LEVELS.indexOf(lv);
      if (i >= 0) st.level = i;
    },
    /** Test hook: select unit `index` of the message containing `text` at the current level. */
    jump: async (text, index = 0) => {
      const find = () => messageRows().find((r) => r.textContent.includes(text));
      let row = find();
      // The list is virtualized: in a long thread the row may be unmounted. Sweep from the top.
      const sc = scroller();
      if (!row && sc) {
        sc.scrollTop = 0;
        for (let i = 0; i < 30 && !(row = find()); i++) {
          await sleep(120);
          if (!(row = find())) sc.scrollTop += sc.clientHeight * 0.6;
        }
      }
      if (!row) throw new Error(`no rendered message contains ${JSON.stringify(text)}`);
      row.scrollIntoView({ block: "start" });
      await sleep(80);
      const units = unitsOf(row, level());
      await setUnit(row, index, units);
      return unitText(units[index]);
    },
    dispose() {
      this.alive = false;
      disposed = true;
      clearTimeout(hudTimer);
      timers.forEach(clearInterval);
      listeners.forEach((off) => off());
      hud?.remove();
      menu?.el?.remove();
      ring?.remove();
      bigEl?.remove();
      tutEl?.remove();
      styleEl?.remove();
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
