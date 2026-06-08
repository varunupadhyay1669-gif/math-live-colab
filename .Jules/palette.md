## 2023-10-27 - Symbol Buttons Require ARIA Labels
**Learning:** Buttons containing only text emojis or Unicode characters (like `✕` or `🗑`) are often skipped or read confusingly by screen readers because they lack semantic meaning or text content.
**Action:** Always include an explicit `aria-label` attribute on buttons where the only content is a text symbol or emoji to ensure clear and consistent screen reader announcements.
