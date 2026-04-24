## 2024-04-24 - Missing aria-labels on data-tip tooltips
**Learning:** The application frequently relies on a custom `data-tip` attribute for icon-only buttons to show CSS-based tooltips, leading to the omission of `aria-label` attributes. This breaks accessibility for screen readers.
**Action:** When adding or modifying icon-only buttons with `data-tip`, always explicitly define an `aria-label` attribute with the same or equivalent descriptive text.
