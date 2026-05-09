## 2025-03-05 - Visual tooltips vs semantic labels
**Learning:** The app's `data-tip` attribute is heavily used for CSS-only tooltips on icon-only buttons (`.btn-icon`). However, this attribute has no semantic value to screen readers. If there's no visible text and no `aria-label`, the button is completely unlabelled for AT users, even if the tooltip works visually.
**Action:** Always pair `data-tip="<string>"` with an equivalent `aria-label="<string>"` on interactive elements, and add `aria-hidden="true"` to the inner SVG to prevent confusing fallback announcements.
