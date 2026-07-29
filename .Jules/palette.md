## 2024-05-18 - Missing ARIA labels on text emojis
**Learning:** Using Unicode text icons like ✕ or 🗑 for buttons can be entirely skipped by screen readers if no `aria-label` is present, just like `<svg>` tags.
**Action:** Always verify text-emoji buttons have explicit `aria-label`s, as visual characters are not reliably read. Ensure inner SVGs have `aria-hidden="true"` while the parent `<button>` receives the `aria-label`.
