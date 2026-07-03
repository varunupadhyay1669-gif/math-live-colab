## 2024-05-18 - Tooltips on disabled buttons
**Learning:** Adding `title` attributes directly to a `<button disabled>` tag often fails to show tooltips in many browsers because disabled elements swallow mouse/pointer events.
**Action:** The codebase frequently uses `<button disabled>` for buttons that temporarily cannot be used. We must instead wrap these buttons in a `<span>` and put the title there, or manage disabled states via `aria-disabled` and CSS.
