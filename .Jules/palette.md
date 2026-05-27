## 2024-05-26 - [Tooltip ARIA Labels]
**Learning:** The application uses custom `data-tip` attributes for tooltips on icon-only buttons, but these are not read by screen readers. Furthermore, inner `<svg>` icons were being announced inconsistently.
**Action:** Always map `data-tip` or `title` values to `aria-label` explicitly, and add `aria-hidden="true"` to decorative inner `<svg>` tags.
