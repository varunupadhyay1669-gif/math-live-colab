## 2024-05-04 - Adding ARIA labels to data-tip tooltips
**Learning:** The custom `data-tip` attribute used for tooltips does not automatically provide screen reader accessibility. Many icon-only buttons rely on this tooltip for their visible label but are missing an explicit `aria-label`.
**Action:** When creating new components or buttons using `data-tip` for tooltip behavior, ensure an `aria-label` with the exact same text is also provided to support screen readers, especially for icon-only buttons.
