## 2025-02-27 - Icon-only buttons Accessibility
**Learning:** Found several icon-only buttons across components (TeacherControls, ChatPanel, Leaderboard) that lacked `aria-label`s. While visual tooltips (`data-tip` or `title`) provide contextual help to sighted users, screen readers need explicit `aria-label`s to announce the button's action. Input elements also missed `aria-label`s.
**Action:** Consistently added `aria-label` attributes to icon-only buttons to match their visual tooltip text or implied action. Added `aria-label` to chat input fields.
