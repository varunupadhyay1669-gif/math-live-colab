## 2024-06-27 - Icon-only buttons accessibility
**Learning:** Tooltip values in `data-tip` and `title` are not read by all screen readers. Icon-only buttons must have explicitly defined `aria-label` attributes to ensure accessibility, mirroring their tooltip values. Also SVG icons inside buttons should have `aria-hidden=\true\`.
**Action:** Always add `aria-label` to icon-only buttons that matches their intended purpose/tooltip, especially those relying on `data-tip` or `title`. Add `aria-hidden=\true\` to svgs inside these buttons.
