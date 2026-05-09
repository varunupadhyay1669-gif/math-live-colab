## 2024-03-24 - Accessibility for icon-only buttons
**Learning:** In this application, many icon-only buttons use custom `data-tip` attributes for tooltips but lack proper `aria-label`s for screen readers. SVG icons inside these buttons also frequently lack `aria-hidden="true"`.
**Action:** Add explicit `aria-label`s mirroring the `data-tip` content (or explaining the action) and ensure child `<svg>` elements have `aria-hidden="true"` so that the button is announced properly and redundantly reading the SVG is prevented.
