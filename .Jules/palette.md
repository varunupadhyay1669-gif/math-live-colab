## 2026-04-27 - Icon-only Chat Buttons Missing ARIA Labels
**Learning:** The ChatPanel component uses emojis (💬, ✕, ↑) for critical navigation and actions without explicit ARIA labels, rendering them inaccessible to screen readers. This is a common pattern for icon-only buttons in the application.
**Action:** Always verify that buttons containing only icons or emojis have descriptive `aria-label` attributes to ensure keyboard and screen reader accessibility.
