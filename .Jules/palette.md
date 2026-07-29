## 2024-05-18 - Tooltip ARIA patterns
**Learning:** The codebase heavily uses `data-tip` attributes for tooltips on buttons, which are not natively announced by screen readers. Furthermore, many icon-only buttons with tooltips contain `<svg>` tags that are not hidden, causing noise.
**Action:** When adding accessible names to icon-only buttons that use `data-tip`, duplicate the `data-tip` text/expression into an explicitly defined `aria-label`, and ensure the internal `<svg>` tags have `aria-hidden="true"`. Do not use static strings for `aria-label` if the `data-tip` relies on dynamic state.
