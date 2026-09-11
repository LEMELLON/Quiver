# Handoff (Revised): Source Panel Overlay Expand, Remove Its Drag Divider, Remove Pane 1 Auto-Float

Revision of `SOURCE_PANEL_OVERLAY_AND_REMOVE_AUTOFLOAT_PROMPT.md`. That handoff's
Part A left `#sourcePanelDivider` (the drag handle between Pane 1 and the source
panel) wired up and unchanged, on the theory that removing it was a separate,
optional concern. **It isn't separate — it's the same bug.** Part A below folds
divider removal in as a required step, not an optional cleanup. Part B
(auto-float removal) is unchanged from the original handoff and included here
only for completeness, so this file is a complete, standalone spec.

---

## Part A — Source panel expand becomes an overlay; its drag divider is removed

### The problem with the original Part A, confirmed against the real code

`#sourcePanelDivider` is independently wired via:

```js
// main.js line 380
setupPaneDrag('source', sourcePanelDividerEl, sourcePaneEl);
```

`setupPaneDrag()` lets a user drag it freely between `PANE_DRAG_CONFIG.source.minWidth`
(96px) and `.maxWidth` (480px). Every drag frame calls `applyWidth('source', pendingWidth)`,
which writes directly to `--source-panel-w` — the live grid track
(`styles.css` line 194: `grid-template-columns: var(--source-panel-w) var(--pane1-w)
minmax(var(--mother-pane-w), 1fr)`).

The overlay fix below only works if `--source-panel-w` never changes except
between two fixed presets (collapsed / expanded-as-overlay). As long as the
divider exists, a user can drag it to any value in [96, 480] and reintroduce
the exact "expanding the source panel pushes Pane 1 / #motherPane" behavior
this handoff exists to eliminate — just via a different input than the toggle
button. **So the divider isn't a nice-to-have removal; it's a precondition
for Part A's fix to actually hold.** With it gone, `--source-panel-w` becomes
a true two-state constant with one single writer (the toggle button), which
is simpler and more robust than the original design, not a workaround.

Confirmed: `.pane-divider` is `position: absolute; right: 0` inside its own
pane's containing block (styles.css ~233-251) — it is not its own grid
column. Deleting the element has no layout side effects on the grid tracks
or on `#pane1Divider` / `#motherPaneDivider`, which are separate elements
using the same shared `.pane-divider` class and are unaffected.

### Fix — keep the grid track pinned, overlay the expanded panel on top

A CSS Grid container is the containing block for its absolutely-positioned
children without needing an explicit `position: relative` on `#layoutRoot`
(CSS Grid Layout Module §10.1, broadly supported). That means an
absolutely-positioned `#sourcePane` scrolls with the page's normal flow
(unlike `position: fixed`, which would need its own scroll-resync logic the
way `#termPanelPopup` needed) — no JS-measured rects, no scroll listener,
just CSS.

**1. `styles.css`** — add the overlay class:

```css
#sourcePane.source-panel-overlay {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  width: var(--source-panel-overlay-w, 320px);
  z-index: 25; /* above .pane-divider (10), below the header (30) — sits over pane1's content, never over nav chrome */
  box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.5); /* reads as floating above #pane1, matching this file's existing shadow-2xl scale */
}
```

`position: absolute` overrides `#sourcePane`'s existing `lg:sticky` utility
while the overlay is open — expected and fine, since `sticky`'s only job
(staying visible while scrolling) is superseded by the element scrolling
naturally with the grid at a fixed absolute position within it. Confirm the
existing `lg:max-h-[...]` / `overflow-y-auto` utilities on `#sourcePane`
still behave correctly with `height: 100%` here — if they conflict,
`height: 100%` may need to become the same `calc(100vh - 5.5rem)` expression
`#pane1` / `#pane2` already use, rather than a percentage.

**2. `main.js`** — remove the divider entirely, and rewrite the toggle
handler to stop touching `--source-panel-w` for the expanded state:

```js
// DELETE — line 380, the divider's drag wiring
setupPaneDrag('source', sourcePanelDividerEl, sourcePaneEl);
```

```js
// PANE_DRAG_CONFIG.source (~205-214) — trim to just what the toggle needs.
// minWidth/maxWidth existed only to feed setupPaneDrag()'s clamp/aria logic
// for the divider; with the divider gone, nothing else in the codebase
// reads them (confirmed: no other reference to PANE_DRAG_CONFIG.source
// exists outside the toggle handler).
source: {
  varName: '--source-panel-w',
  collapsedWidth: 96,
  expandedWidth: 320, // now only seeds --source-panel-overlay-w
},
```

```js
// Toggle handler (~488-499) — rewritten
if (sourcePanelToggleBtn && sourcePaneEl) {
  sourcePanelToggleBtn.addEventListener('click', () => {
    const cfg = PANE_DRAG_CONFIG.source;
    const isOpen = sourcePaneEl.classList.contains('source-panel-overlay');
    const expanded = !isOpen;
    if (expanded) {
      layoutRootEl.style.setProperty('--source-panel-overlay-w', `${cfg.expandedWidth}px`);
    }
    sourcePaneEl.classList.toggle('source-panel-overlay', expanded);
    sourcePaneEl.classList.toggle('source-panel-expanded', expanded); // unchanged — still drives .source-stack-meta's show/hide
    sourcePanelToggleBtn.setAttribute('aria-expanded', String(expanded));
    sourcePanelToggleBtn.title = expanded ? 'Collapse source panel' : 'Expand source panel';
  });
}
```

Note `--source-panel-w` itself is never written by this handler anymore —
it's set once at page load (styles.css line 180, `96px`) and never changes
again for the lifetime of the page, now that both writers (the old
"expanded" branch and the divider) are gone.

**3. `online-quiz-maker.html`** — delete the divider's markup (line 153):

```html
<!-- DELETE -->
<div id="sourcePanelDivider" class="pane-divider" role="separator" aria-orientation="vertical" aria-controls="sourcePane" tabindex="0"></div>
```

Removing `role="separator"` / `tabindex="0"` matters beyond tidiness — an
element left in the DOM with that role but no handler behind it is an
accessibility trap: keyboard/screen-reader users would tab to a "separator"
that does nothing.

**4. `dom-refs.js`** — remove the now-orphaned reference (declaration at
line 85, export at line 169):

```js
// DELETE
const sourcePanelDividerEl = document.getElementById('sourcePanelDivider');
// ...and remove sourcePanelDividerEl from the export block
```

**5. `styles.css`** — no other change needed. `.pane-divider` still styles
`#pane1Divider` / `#motherPaneDivider`, which are untouched.

### Verification checklist (Part A)

- [ ] `#sourcePanelDivider` does not exist in the DOM at all — not hidden,
      not inert, removed.
- [ ] The only way to resize/expand the source panel is
      `sourcePanelToggleBtn`; there is no drag interaction on the source
      panel's edge anymore.
- [ ] `--source-panel-w` on `#layoutRoot` is `96px` for the entire session,
      confirmed via devtools — it never changes value, in either the
      collapsed or expanded state.
- [ ] Clicking the expand button widens `#sourcePane` visually (via
      `--source-panel-overlay-w`), overlapping `#pane1`'s content, without
      moving or resizing `#pane1` / `#motherPane` at all.
- [ ] Collapsing it again returns `#sourcePane` to normal in-grid layout.
- [ ] Scrolling the page while expanded keeps the overlay correctly
      positioned — should work for free via absolute positioning
      inheriting the grid's normal scroll; confirm it actually does.
- [ ] Z-index 25 doesn't visually clash with the sticky header (z-index 30)
      or get hidden behind `#pane1`'s own content.
- [ ] `#pane1Divider` and `#motherPaneDivider` still drag exactly as
      before — fully unaffected by any of the above.

---

## Part B — Remove Pane 1's auto-float behavior entirely

(Unchanged from the original handoff.)

### What's being removed

Two independent triggers currently auto-float Pane 1 into windowed mode
without the user clicking the float button:

**Trigger 1 — drag-overshoot** (`main.js`):
- `PANE_DRAG_CONFIG.pane1.onOvershoot: () => floatPane1('auto')` (~line 226)
  and its two explanatory comment blocks (~218-221, ~227-230)
- `AUTO_FLOAT_OVERSHOOT_PX` constant (~line 247) and its comment
- The branch inside `setupPaneDrag()`'s `onPointerMove()` (~314-325):
  ```js
  if (cfg.onOvershoot && rawRequested < cfg.minWidth - AUTO_FLOAT_OVERSHOOT_PX) {
    ...
    cfg.onOvershoot();
    return;
  }
  ```

**Trigger 2 — resize-based auto-float/auto-redock** ("batch 5C", `main.js`
~707-743): the entire block — `RESIZE_DEBOUNCE_MS`, `REDOCK_HYSTERESIS_PX`,
`resizeDebounceTimer`, `checkAutoFloatOnResize()`, and its
`window.addEventListener('resize', () => { ... checkAutoFloatOnResize ... })`
registration.

### What stays

- The manual float toggle (`pane1FloatToggleBtn`'s click handler,
  `pane1Floating ? dockPane1() : floatPane1()`) — completely unchanged.
  This remains the only way to enter/exit windowed mode.
- Pane 1's ordinary drag-resize clamp — once the overshoot branch above is
  deleted, `onPointerMove()` falls straight through to its normal
  `pendingWidth = clamp(rawRequested, cfg.minWidth, dragMaxWidth)` line,
  which already does exactly "stop at minimum, don't go below" with zero
  extra code needed. Same for the keyboard-resize path (`Home`/`ArrowLeft`
  already clamp against `cfg.minWidth` and never had an overshoot check to
  begin with).
- `getPane1EffectiveMaxWidth()`/the dynamic-max-width fix (previous
  handoff) — entirely unrelated to auto-float, keep as-is.

### Cleanup this enables (optional, flagging rather than requiring)

With both auto-float triggers gone, `floatPane1(reason = 'manual')`'s
`reason` parameter and the module-level `pane1FloatReason` variable
(`main.js` ~509-513, ~538, ~553) only ever get set to `'manual'` now — the
`'auto'` value they were built to distinguish no longer occurs anywhere.
Left in place, they're harmless but slightly misleading dead-weight
(a distinction that no longer distinguishes anything). Simplify by dropping
the parameter/variable entirely if you want the code to read cleanly, or
leave it if you'd rather keep the door open for reintroducing an auto
trigger later — your call, not required for this fix to work correctly.

### Verification checklist (Part B)

- [ ] Dragging `#pane1Divider` narrower stops exactly at Pane 1's
      `minWidth` and stays docked — no auto-float, regardless of how hard
      or far past the limit the drag continues.
- [ ] Shrinking the browser window down to where Pane 1 would previously
      have been squeezed below its minimum no longer auto-floats it either
      — it just stays docked at whatever the grid forces it to.
- [ ] Clicking the float button (`#pane1FloatToggleBtn`) still correctly
      floats/docks Pane 1 — the only remaining way to enter windowed mode.
- [ ] No leftover references to `onOvershoot`, `AUTO_FLOAT_OVERSHOOT_PX`,
      `checkAutoFloatOnResize`, `RESIZE_DEBOUNCE_MS`, or
      `REDOCK_HYSTERESIS_PX` anywhere in `main.js` after this change.
