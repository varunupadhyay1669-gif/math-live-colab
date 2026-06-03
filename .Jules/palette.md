
## 2024-05-24 - Explaining Disabled States and Improving Icon-only Buttons
**Learning:** Found that when buttons are disabled at boundaries (e.g., minimum/maximum zoom, first/last step), lacking an explanation can leave users confused. Additionally, some icon-only buttons relied on `data-tip` but missed `aria-label`, and their inner SVG icons lacked `aria-hidden="true"`, causing screen reader verbosity or poor labeling.
**Action:** Always provide context for disabled buttons using dynamic `data-tip` or `title` attributes. Ensure every icon-only button has an explicitly defined `aria-label` and `aria-hidden="true"` on the nested `<svg>`.
