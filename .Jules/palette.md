## 2024-05-05 - Add aria-labels to icon-only buttons with tooltips
**Learning:** The codebase relies on `data-tip` or `title` attributes to provide tooltips for icon-only buttons, but frequently omits the required `aria-label` attribute, making these buttons inaccessible to screen readers.
**Action:** When working on tooltips (`data-tip` or `title`) for icon-only buttons, always ensure an equivalent `aria-label` attribute is added.
