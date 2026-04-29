
## 2023-10-25 - Explicit ARIA Labels for Symbol Buttons
**Learning:** Icon-only buttons with simple text characters like `✕` (Close) or `↑` (Send) are not automatically read as descriptive actions by screen readers, which compromises accessibility.
**Action:** Always add an explicitly defined `aria-label` attribute (e.g., `aria-label="Close"`, `aria-label="Send message"`) to buttons that rely purely on symbols or emojis for their visual meaning.
