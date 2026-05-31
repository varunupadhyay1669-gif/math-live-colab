## 2024-05-31 - Tooltip Aria Label Redundancy
**Learning:** Tooltip components (like the `data-tip` attribute pattern used here) provide visual hints but do not automatically communicate their content to screen readers if the element only contains an icon.
**Action:** When adding or encountering icon-only buttons with `data-tip` or `title` attributes, ensure they have an explicitly defined `aria-label` matching the tooltip text. Furthermore, any internal `<svg>` icons must have `aria-hidden="true"` to prevent screen readers from attempting to parse the svg content redundantly.
