## 2024-05-19 - ARIA labels for icon-only buttons with data-tip

**Learning:** Buttons using the custom `data-tip` attribute for tooltips (especially those that are icon-only) are not inherently accessible to screen readers, as screen readers read `aria-label` or inner text, not custom attributes like `data-tip`. We found multiple places across the codebase where `data-tip` was used without an `aria-label`.

**Action:** Whenever using `data-tip` on an element that does not have clear text content (like an icon-only button), ensure that an `aria-label` is also explicitly set with the same or equivalent descriptive text to provide accessibility for screen reader users.
