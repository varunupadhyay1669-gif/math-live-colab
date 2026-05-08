## 2024-05-24 - Missing Aria Labels on Tooltips
**Learning:** The codebase frequently uses custom data-tip attributes for tooltips on icon-only buttons. These attributes do not get automatically read by screen readers.
**Action:** Always ensure icon-only buttons with tooltips have explicitly defined aria-label attributes for accessibility.
