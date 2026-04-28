## 2024-03-20 - Adding ARIA labels to data-tip buttons
**Learning:** The custom `data-tip` attribute is heavily used for tooltips on buttons that only have SVG icons. These elements require explicitly defined `aria-label` attributes to guarantee screen reader accessibility.
**Action:** Always copy the tooltip string to an `aria-label` on elements when using `data-tip` on an icon-only button.
