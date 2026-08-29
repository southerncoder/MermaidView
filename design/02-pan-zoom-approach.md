# Canvas & Pan/Zoom Design

## The Canvas

The canvas is an infinite 2D space where diagram cards are displayed.
It supports two levels of pan/zoom:

### Level 1: Canvas Pan/Zoom (move between diagrams)

| Action | Input |
|--------|-------|
| Pan canvas | Click empty space + drag |
| Zoom in | Mouse wheel up, `+`, pinch out |
| Zoom out | Mouse wheel down, `-`, pinch in |
| Fit all | `F` — auto-fit all cards in view |
| Reset view | `R` — return to default zoom/position |
| Navigate cards | Arrow keys (move between cards) |

**Implementation:** CSS `transform: translate() scale()` on the canvas
container. All cards are children of this container, so they move/scale
together. Hardware-accelerated via `will-change: transform`.

### Level 2: Diagram Pan/Zoom (within a focused diagram)

When you double-click a card (or press Enter), it enters **focus mode**:
the card expands to fill the viewport, and you can pan/zoom within the
SVG itself.

| Action | Input |
|--------|-------|
| Pan within SVG | Click + drag |
| Zoom in | Mouse wheel up, `+` |
| Zoom out | Mouse wheel down, `-` |
| Fit to screen | `F` |
| Reset | `R` |
| Exit focus | `Esc` or double-click |

**Implementation:** `svg-pan-zoom` library applied to the SVG element
within the focused card. Independent of canvas transform.

*Implemented as a small native JS SVG pan/zoom handler in `web/app.js`
to avoid an extra vendored dependency.*

## Card Layout

### Gallery Mode (default)

Cards arranged in a responsive grid:
- Auto-sized based on viewport
- Gap between cards (configurable)
- Cards maintain aspect ratio of their SVG content
- Empty space if fewer diagrams than grid slots

```
┌─────┐ ┌─────┐ ┌─────┐
│ D1  │ │ D2  │ │ D3  │
│     │ │     │ │     │
└─────┘ └─────┘ └─────┘
┌─────┐ ┌─────┐
│ D4  │ │ D5  │
│     │ │     │
└─────┘ └─────┘
```

### Card Content

Each card displays:
- **Header bar:** Diagram title (first non-keyword line), type badge
  (flowchart, sequence, etc.), source file name, line range
- **Body:** Rendered SVG (scaled to fit card width)
- **Footer (on hover):** "Open source" button, "Export SVG" button

```
┌──────────────────────────────┐
│ 📊 User Flow · flowchart     │
│ README.md · L42-68           │
├──────────────────────────────┤
│                              │
│     [ rendered SVG ]         │
│                              │
├──────────────────────────────┤
│ [ Open Source ] [ Export ]   │  ← on hover
└──────────────────────────────┘
```

### Layout Algorithm (Phase 1)

Simple grid: calculate columns based on viewport width and a target
card width (e.g., 400px). Cards flow top-to-bottom, left-to-right.

### Layout Algorithm (Phase 2+)

Options for future:
- **Auto-flow:** Pack cards by size (masonry layout)
- **Grouped by file:** Cards grouped by source file with section headers
- **Manual:** Drag cards to custom positions, persist layout
- **Type-grouped:** Group by diagram type (all flowcharts together)

## Live Update Behavior

When a diagram's source changes in Zed:

1. WebSocket receives update event with new source text
2. Card shows a subtle "rendering" indicator (pulsing border)
3. `mermaid.render()` called with new source
4. New SVG replaces old SVG in the card
5. Card resizes if the diagram dimensions changed
6. Canvas layout reflows if needed
7. Pan/zoom state of the canvas is preserved
8. If the card was in focus mode, its pan/zoom state is reset (SVG changed)

### Error Handling

If `mermaid.render()` fails (syntax error):
- Card shows error state with the error message
- Error message includes line number if available
- Card border turns red
- Source text is shown in a `<pre>` block as fallback

## Enormous Diagram Support

For diagrams with 500+ nodes:

1. **Card preview:** Render at a smaller scale (CSS `transform: scale()`)
   for the gallery thumbnail. Full quality only when focused.

2. **Focus mode:** Full SVG rendered in browser — hardware-accelerated.
   Browsers can handle SVGs with tens of thousands of elements.

3. **Lazy rendering:** Only render visible cards (plus buffer). Cards
   off-screen are not rendered until scrolled into view. Use
   `IntersectionObserver` to detect visibility.

4. **Debouncing:** Multiple rapid edits are debounced (200ms). Only the
   final state is rendered.

5. **Memory:** mermaid.js creates DOM nodes for each element. For
   extreme cases (10,000+ nodes), consider rendering to an off-DOM
   canvas and displaying as an image. (Future optimization.)

## Theme

The canvas app matches Zed's theme:

```css
:root {
  --bg: #1e1e2e;          /* from Zed dark theme */
  --bg-card: #2a2a3c;
  --fg: #cdd6f4;
  --fg-muted: #7f849c;
  --accent: #89b4fa;
  --border: #45475a;
  --error: #f38ba8;
}

:root[data-theme="light"] {
  --bg: #ffffff;
  --bg-card: #f5f5f5;
  --fg: #1e1e2e;
  /* ... */
}
```

Theme is pushed from the server via WebSocket on connection, based on
Zed's current theme. Falls back to `prefers-color-scheme` if unavailable.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `F` | Fit all cards in view |
| `R` | Reset zoom/position |
| `+` / `=` | Zoom in |
| `-` | Zoom out |
| `Enter` | Focus selected card |
| `Esc` | Exit focus mode |
| `↑↓←→` | Navigate between cards |
| `Tab` | Next diagram |
| `Shift+Tab` | Previous diagram |
| `E` | Export focused diagram as SVG |
| `?` | Show keyboard shortcuts |