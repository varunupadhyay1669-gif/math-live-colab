## 2024-03-01 - Add ARIA Labels to data-tip buttons
**Learning:** Found multiple instances where `data-tip` attribute was used on buttons without a corresponding `aria-label`, making them inaccessible to screen readers. We need to ensure that any `data-tip` element that acts as an icon-only button also receives an `aria-label` equivalent.
**Action:** When adding `data-tip` for tooltip visualization, always pair it with an `aria-label` of the same content to support accessibility constraints without altering the visual presentation.
