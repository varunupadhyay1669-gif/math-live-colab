## 2024-05-24 - ChatPanel Accessibility Pattern
**Learning:** Found a recurring pattern where icon buttons have `aria-label` but their inner `<svg>` tags lack `aria-hidden="true"`, causing some screen readers to redundantly announce the SVG role. Also, the chat input relied solely on a placeholder for context.
**Action:** When working with icon-only buttons (`.ml-icon-btn`), always ensure `aria-hidden="true"` is on the inner SVG. When dealing with minimal form inputs like chat bars without visible labels, always add an explicit `aria-label`.
