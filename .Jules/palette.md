## 2024-05-22 - Missing aria-label for Delete Button in SimulationLibrary
**Learning:** Found a delete button with a trash icon but no aria-label or tooltip to explain its function to screen reader users or provide extra context. This breaks accessibility for icon-only buttons.
**Action:** Always add aria-labels (and optionally a `title` or `data-tip` if appropriate) for icon-only buttons to ensure they're accessible for all users.
