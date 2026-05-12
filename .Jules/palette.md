## 2024-05-15 - Missing aria-label and aria-hidden on TeacherControls buttons
**Learning:** Icon-only buttons with `data-tip` attributes often lack explicit `aria-label` for screen readers. SVG icons inside these buttons should also have `aria-hidden="true"` so they are ignored by screen readers.
**Action:** Add `aria-label` to buttons in `TeacherControls.tsx` and `aria-hidden="true"` to the `<svg>` element inside them.
