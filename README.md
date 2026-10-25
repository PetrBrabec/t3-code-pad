# t3-code-pad

> Unofficial. A community add-on for [T3 Code](https://github.com/pingdotgg/t3code), not affiliated with or endorsed by T3 Tools Inc.

Drive the [T3 Code](https://github.com/pingdotgg/t3code) desktop app with a PS5 DualSense controller:
read your coding agents' replies, highlight a sentence or a clause, quote it into your reply, dictate
the answer, approve the agent's requests, send. No keyboard, no mouse. Made for using coding agents
from the couch or the floor.

No fork of T3: a small JavaScript module is injected into the running app over the Chrome DevTools
Protocol, plus a tiny macOS helper for the dictation shortcut.

![t3-code-pad demo: walking an agent's reply, zooming to a clause, quoting it and dictating a reply](docs/media/demo.gif)

Full demo video (93 s, with narration): [docs/media/t3-code-pad-demo.mp4](docs/media/t3-code-pad-demo.mp4)
([en español](docs/media/t3-code-pad-demo.es.mp4)). Stills: [zoom](docs/media/zoom.jpg),
[quote](docs/media/quote.jpg), [reply mode](docs/media/reply.jpg), [image preview](docs/media/preview.jpg),
[permission](docs/media/permission.jpg), [cheat sheet](docs/media/menu.jpg).

## Requirements

- macOS (the helper and the touchpad reader are Swift; tested on macOS 26).
- T3 Code desktop 0.1.x. t3-code-pad relies on its internals (selectors in `SEL`, `src/t3pad.js`), so a T3
  release can break it.
- A DualSense (PS5) controller, paired over Bluetooth or USB. Chromium reports it as a "standard"
  gamepad; other standard pads should work for the buttons, the touchpad is DualSense only.
- Node.js 22 or newer (the sidecar uses the built-in WebSocket), Xcode command line tools (`swiftc`).
- Optional: [VoiceInk](https://tryvoiceink.com) for dictation (R2 is push-to-talk). Without it,
  everything except dictation works.

## Buttons

**Chat mode** (default) walks the agent's reply; **reply mode** edits your own reply in the composer;
**permission mode** answers T3's approval and question prompts. L2 cycles chat, reply, permission,
and the permission stop is only there while a request waits in the open thread (never entered by
itself). Two modes switch on by themselves: **palette mode** while T3's command palette is open, and
**preview mode** while something Cross opened (image lightbox, right panel) is open.

| input | chat mode | reply mode | palette mode |
|---|---|---|---|
| D-pad up / down | previous / next unit (crosses messages, scrolls the virtualized list) | previous / next unit of your reply; from a caret, the unit under or next to it | previous / next command |
| D-pad left / right | smaller / bigger unit: clause (split on `,` `:` `;`), sentence, paragraph, message (right = bigger) | same levels (clause, sentence, paragraph, whole reply); a caret stays a caret | nothing |
| Cross | open the selected link in T3's preview pane, or the image in the lightbox | nothing | run the highlighted command (Enter) |
| Square | quote the selection (T3's Cite, comment left empty); caret ends up right after the chip | delete the selection (one neighbouring space goes with it) | nothing |
| Circle | close the lightbox, else T3's right panel (whatever it shows), else clear the selection; never navigates | selection: collapse to a caret at its end; caret: back to chat mode | close the palette (Escape) |
| Triangle | jump to the latest message | undo (Cmd+Z: the last delete or the last dictated insert) | nothing |
| L2 | reply mode | permission mode if a request waits, else chat mode | nothing |
| L1 / R1 | previous / next thread | same (leaves reply mode) | nothing |
| R2 (hold) | VoiceInk push-to-talk; text lands at the composer caret | same; with a selection the dictation replaces it | dictation goes into the palette's search field |
| Options | send (single press) | send (and back to chat mode) | nothing |
| Create (tap) | T3's command palette | same | close the palette |
| Create (hold 0.5 s) | t3-code-pad menu: cheat sheet and settings | same | same |
| Touchpad (click) | select the first word of the highlight; click again within the window: sentence, then paragraph (D-pad right grows a word to its clause) | select the word at the caret; again: sentence, then paragraph | nothing |
| Touchpad (slide) | nothing | move the caret: sideways by character (faster finger, bigger steps), up / down by line | nothing |
| Left stick (vertical) | scroll the chat | scroll the chat | walk the commands (tilt further: faster) |
| Right stick (vertical) | scroll the composer when it overflows | same | same |

Links, code blocks and images (also images attached to a message) are stops of their own in the chat; citation chips (and @mentions,
$skills) are stops of their own in the reply, selected and deleted as a whole. Both highlights are
the real selection, so T3's Cite toolbar appears in the chat exactly as with the mouse. The pill
stays up while a controller is connected and always shows the mode (CHAT, REPLY, PERMISSION,
PALETTE, PREVIEW, with the level, the highlighted command, choice or image); after a button it shows
what the button did for a moment. While T3 waits for an approval or an answer it adds "request
waiting, L2" (or "question waiting") but never switches mode.

**Pill position**: the bottom left of T3's main pane, so it covers none of T3's buttons: right of the
sidebar when it is open, at the window edge when it is closed, its vertical centre on the sidebar's
footer row (settings ... update icon). It follows the sidebar opening, closing and resizing (polled
every 100 ms). It never grows into the composer: when the main pane is narrow (right panel open) the
text is cut with an ellipsis, then dropped, then only the mode icon is left.

**One table.** `MAP` in `src/t3pad.js` holds, per button and mode (chat, reply, palette, permission, preview, menu), the
action, the cheat sheet line and its icon. Dispatch, the cheat sheet and the menu's footer are all
built from it, and so are the tutorial's steps, so they cannot drift: change a button there and write
its line next to it. Reply mode falls back to the chat action for buttons it does not override; in
every other mode a button without an entry does nothing, so chat and reply bindings never fire while
the palette, a prompt or a preview has the pad.
Tunables live in a second table, `SETTINGS`, which drives the settings page, the defaults and the
stored values.

**Menu** (hold Create, in every mode): a glass panel with the cheat sheet for the current mode on the
left (with the mnemonic "Square acts on the selection: quote it (chat) / delete it (reply)") and the
settings on the right. D-pad up / down picks a setting, left / right changes it (holding repeats),
Cross on the last rows starts the tutorial or resets everything, Circle or a Create tap closes.
**L2 switches the mode with the menu open** (the same cycle as outside) and the cheat sheet follows;
**L1 / R1 page the sheet** through all five modes (chat, reply, palette, permission, preview) without
switching, which is how the palette and preview sheets are reached (they have no button of their
own). The footer says both ("L2 switch mode", "L1 R1 buttons of the other modes"). Changes apply live and are stored in the
renderer's `localStorage` (`t3pad.settings.v1`). Like the pill it takes no focus and no pointer
events, so the chat selection, the composer caret and an open palette stay where they were.

| setting | default | what it does |
|---|---|---|
| Caret speed | 28 chars | characters per slow full-width slide |
| Caret acceleration | 40 | extra characters for a fast finger (0: off) |
| Vertical travel per line | 25 % of the pad | how far to slide up or down for one line (was 11 % before 2026-10-25) |
| Axis lock | 2.00x | how much more vertical than sideways a slide must be to move lines |
| Axis decision distance | 3 % of the pad | travel before a slide picks its axis (it moves nothing until then) |
| Stick scroll speed | 28 px | per tick at full tilt |
| D-pad repeat delay / rate | 380 / 110 ms | hold before a step repeats, time between repeats |
| Multi-click window | 500 ms | click again within this to grow a touchpad selection |
| Menu and pill size | 100 % | for the glasses |

**Touchpad slide, axis lock**: each slide is locked to one axis. Until it has travelled the decision
distance it moves nothing; then the axis with more travel wins, sideways travel counting "axis
lock" times as much, and the travel so far is credited to that axis. A sloppy sideways slide never
jumps lines, and a line needs a much longer vertical slide than before.

**Touchpad click, tap to select**: like a touch screen. In reply mode the word at the caret (the word
under it, else the one ending at it, else the next; next to a chip with no word, the chip), a second
click within the window the sentence, a third the paragraph. The result is an ordinary reply
selection: Square deletes it, R2 dictates over it, D-pad right grows a word to its clause and then
on. In chat mode there is no caret, so the click takes the first word of the highlight and escalates
the same way; Square quotes it. A click never moves the caret itself: moves stop for the rest of
that touch, and a touch that began less than 0.7 s before the click gets its caret put back where
the finger landed, so the word is taken there.

**Permission mode** (L2 while T3 asks): T3 puts an approval ("Approve", "Decline", and "Always allow
this session", "Cancel" behind its "..." button) or a question (option buttons) into a banner over
the composer. The pad reads the choices from that banner (the "..." menu opens for a moment to read
them) and orders them allow, allow for session, deny, cancel. **Nothing is highlighted until the
first D-pad press**, so a stray Cross answers nothing; up / down move a ring over T3's own button,
Cross clicks it (a menu-only choice through the "..." menu), then the pad goes back to the mode it
came from (a multi-question prompt stays for the next question). Circle or L2 leave without
answering; every other button does nothing. If the request is answered by mouse, the mode ends by
itself. R2 dictates into the composer, which is T3's "type your own answer" field for questions.

| input | permission mode | preview: lightbox | preview: right panel |
|---|---|---|---|
| D-pad up / down | highlight a choice (none until the first press) | nothing | scroll the panel (web page or in-app view) |
| D-pad left / right | nothing | previous / next image of the thread | previous / next image in the panel (a ring marks it) |
| Left stick | scroll the chat | nothing | scroll the panel |
| Cross | answer with the highlighted choice | nothing | show the picked image large |
| Circle | back without answering | close; the highlight is on the last image seen | from a large image: back; else close the panel |
| L2 | back to chat without answering | nothing | nothing |
| Create (hold) | menu | menu | menu |

**Preview mode** (automatic): entered when Cross opened the image lightbox or something in T3's
right panel (a new tab there, or the panel opening), so a panel you keep open for other things does
not take the pad; left when it closes, however it closes. One mode for both, with the actions split
by what is open: the lightbox steps through every image of the open thread in reading order
(mounted messages; T3's lightbox shows one image, so the pad closes it and opens the neighbour), the
right panel scrolls and walks images. **What the right panel is**: web pages are Electron
`<webview>`s, each its own CDP target the module is not injected into; the module drives the visible
one through the webview's own `executeJavaScript` (scroll, outline the picked image, open it on its
own, `history.back()`), no sidecar change. File, media, HTML, diff and PR views are rendered in T3's
own DOM (the PR summary has `data-pull-request-summary-*`), so they are scrolled directly and their
images shown large in a t3-code-pad overlay. Images in web previews load (Wikipedia's sea otter article:
28 images walked and opened). **Circle closes the right panel through T3's own toggle** ("Toggle right
panel", the same as ⌥⌘B), whatever it shows, so it needs no per-content detection, and it never
falls back to history back (that used to switch threads when a file preview was open).

**Tutorial**: on the first connect a welcome card offers a short tour (Cross: start, Circle: not
now; any other button puts it away and does its usual thing); the menu's "Start the tutorial" row
restarts it. Ten steps: pick a sentence, zoom, quote, reply mode, delete, undo, touchpad caret,
dictate, send, menu. Each names one thing, shows the button glyph and its cheat sheet line straight
from `MAP`, and waits until the result is really there (the highlight moved, the level changed, the
reply grew, the reply shrank, the caret moved, a dictation went down and up, a message was sent, the
menu opened). It runs in its own practice thread (see Install, step 5) and goes back to the thread it started from at the end. **Holding Circle skips it**;
while it runs, a short Circle press still does what Circle does (Circle then fires on release). If the practice thread is missing, the card says so and stops.

**Palette mode**: T3's palette is a Base UI autocomplete whose input keeps the focus; the pad sends
ArrowUp / ArrowDown / Enter / Escape key events to that input, which is exactly what T3 listens to
(it moves `aria-activedescendant`). No typing needed; R2 dictates into the search field if you want
to filter.

**Look**: the pill and the menu read T3's own CSS variables (`--popover`, `--border`, `--radius`,
`--glass-blur`, `--glass-saturation`, `--info` / `--warning` / `--success` for the mode colours) at
paint time and inherit T3's font, so they follow its light / dark theme (also custom themes) with no
JS. Action icons are [Lucide](https://lucide.dev) (ISC license, the set T3 itself uses), path data
copied from `lucide-static` 1.61 into `ICONS`. The PlayStation button glyphs are drawn in the module
(`glyph()`), no third-party artwork.

Quote, dictate, quote, dictate gives quote A, text, quote B, text: T3 inserts a chip at the composer
caret and leaves the caret right after it, and R2 never moves the caret (only an untouched draft
whose caret is still at the very start is sent to the end first).

## How it works

```
DualSense --(Gamepad API)--> src/t3pad.js in the T3 renderer
                               | window.t3padNative(...)  (CDP binding)
                               v
             sidecar/sidecar.mjs (node, CDP client) --stdout--> helper (T3Pad.app, Swift)
                                                                 posts Fn+Space -> VoiceInk
```

- `src/t3pad.js`: polls the pad, splits messages into units (`Intl.Segmenter` for sentences), moves
  the selection, clicks T3's buttons. Test hooks on `window.__t3pad`.
- `sidecar/sidecar.mjs`: injects the module (`Page.addScriptToEvaluateOnNewDocument` plus an evaluate
  into the live page), relays page calls to the helper, and keeps T3 on the debug port: if T3 was
  started from the Dock, Spotlight or an auto-update (no flag), it quits and relaunches it with
  `--remote-debugging-port=9222` within about 10 s, in front if it was in front (no mouse needed to get
  it back, and VoiceInk pastes into the frontmost app). It never starts T3 that is not running.
- `helper/main.swift` (`~/Applications/T3Pad.app`, LaunchAgent `com.petr.t3pad`, the author's bundle id, kept so existing installs keep their Accessibility grant): parent of the
  sidecar, so the Accessibility grant belongs to this bundle and not to node. Posts VoiceInk's
  recording shortcut (Fn+Space; override with `T3PAD_PTT_KEYCODE` / `T3PAD_PTT_FLAGS`).
- `touch/main.swift` (`~/Library/Application Support/t3-pad-bin/t3pad-touch`, spawned by the
  sidecar): reads the DualSense touchpad with GameController (`shouldMonitorBackgroundEvents`,
  `GCDualSenseGamepad.touchpadPrimary`) and prints positions at about 60 Hz; the sidecar forwards
  them into the page (`__t3pad.touchNative`). A plain binary outside T3Pad.app on purpose:
  GameController needs no permission, and T3Pad.app (with its Accessibility grant) stays untouched.
  It exits when the sidecar goes away.

Why the buttons are read in the page and not natively: the page path is testable headlessly with a
fake `navigator.getGamepads`, and a native reader would still need Accessibility for the dictation
key, so it would not save a permission. Only the touchpad is read natively, because Chromium does
not expose it by default.

Reply mode works on T3's editor state, not the DOM: the composer is Tiptap (ProseMirror) and its
instance hangs off the element (`[data-testid=composer-editor]`.editor). Selection, delete and undo
are editor commands, units are computed over the ProseMirror doc, the touchpad's character steps are
editor positions (a chip is one step) and its line steps are `Selection.modify("line")`, which
ProseMirror reads back. Verified by sending: the sent message contains exactly what the editor held.

Chromium has DualSense touch support behind `--enable-blink-features=GamepadMultitouch
--enable-features=EnableGamepadMultitouch`; the sidecar adds both when it (re)launches T3. With the
flags `Gamepad.prototype.touchEvents` exists; whether it is filled for the DualSense on macOS is not
verified yet (the page only sees a pad after a button press). Once it delivers a touch, the page uses
it and ignores the native reader.

T3 0.1.0 quirks the module handles: a programmatic selection alone does not show the Cite button
(the module replays a mouse gesture, and only on a visible range); after Cite, T3 opens an
"optional comment" popover where Escape would drop the quote, so the module clicks Save; hiding the
preview panel leaves a floating mini preview, which Circle closes too.

## Install

On the Mac that runs T3:

```sh
git clone https://github.com/PetrBrabec/t3-code-pad && cd t3-code-pad
scripts/install.sh                 # builds the helper, installs the LaunchAgent, starts the sidecar
scripts/install.sh --link-target   # optional: open links in T3's in-app preview (restarts T3)
scripts/install.sh --uninstall
```

1. **Accessibility**: System Settings, Privacy & Security, Accessibility, switch on **T3Pad** (needed
   to post VoiceInk's shortcut). The helper is ad-hoc signed, so every rebuild of `helper/` needs the
   grant again (remove the stale entry with "-" first).
2. **Start T3** normally. The sidecar relaunches it once with `--remote-debugging-port=9222` and keeps
   it on that port (it never starts T3 when it is not running).
3. **Connect the controller** and press any button while T3 is in front (Chromium only exposes a pad
   after a press). The pill in the bottom left says "Controller ready (standard)".
4. **VoiceInk** (optional): keep its recording shortcut on Fn+Space, or set `T3PAD_PTT_KEYCODE` /
   `T3PAD_PTT_FLAGS` for the helper.
5. **Tutorial** (optional): create a practice thread in T3 with a prompt that asks the agent for a
   few paragraphs of text (no tools), then in T3's devtools console or with `scripts/cdp-eval.mjs`:
   `localStorage.setItem("t3pad.tutorialThread", "<thread id>")`. Start it from the menu (hold Create).

Log: `~/Library/Logs/t3-pad.log`.

**Developing on another Mac than the one running T3**: put `T3PAD_REMOTE` (and optionally
`T3PAD_SSH_KEY`) in `.env.local` (see `.env.example`), then `scripts/deploy-air.sh` copies the checkout
over ssh and runs the installer there, and `scripts/dev-air.sh '<cmd>'` runs a command in a synced
dev copy.

## Security

The debug port lets any local process control T3 (read threads, send messages). Chromium binds it to
`127.0.0.1` only (check with `lsof -iTCP:9222 -sTCP:LISTEN`); other machines on your network cannot
reach it. It is open only while T3 runs with the flag. `scripts/install.sh --uninstall` removes the
agent; relaunch T3 normally to close the port.

## Known limitations

- Built against T3 Code 0.1.x internals; selectors and T3's own quirks are handled in `src/t3pad.js`
  and may need updating after a T3 release (`scripts/grep-bundle.mjs` helps find renamed ones).
- **Options sends on a single tap**, into whatever thread is open.
- Touchpad: read natively through GameController, because Chromium does not expose it by default;
  the tuning defaults (travel per line, axis lock) are a first guess, adjustable in the menu.
- The image lightbox only reaches images of messages T3 has mounted (its list is virtualized).
- Quoting a *user* message falls back to inserting `> text` (T3 has Cite for assistant messages only).
- Each Cross on a link opens a new preview tab; tabs pile up.
- A permission choice that only lives behind T3's "..." menu ("Always allow this session", "Cancel")
  is implemented but has not run against a real request yet.

## Development and tests

`test/e2e.mjs` and `test/modes.mjs` drive the live app through a fake gamepad and assert on the DOM;
they are optional and need staged fixture threads. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

MIT, see [LICENSE](LICENSE). Third-party material: action icons are path data from
[Lucide](https://lucide.dev) (ISC license, notice in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md));
the PlayStation button glyphs are drawn in code. "PlayStation" and "DualSense" are trademarks of
Sony Interactive Entertainment; T3 Code is a separate project. This project is not affiliated with
either. The demo video was made with [product-video](https://github.com/PetrBrabec/product-video).
