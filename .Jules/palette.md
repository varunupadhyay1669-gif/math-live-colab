## 2024-05-18 - Ensure aria-labels mirror data-tip for tooltips
**Learning:** Tooltips in this application are predominantly created using a custom `data-tip` attribute on buttons and other interactive elements. This attribute does not automatically expose its value to screen readers.
**Action:** Always ensure that an explicitly defined `aria-label` attribute mirrors the value of the `data-tip` attribute on these interactive elements.
