## 2026-05-16 - Form Accessibility and UX Feedback
**Learning:** Placeholders are insufficient for screen readers; inputs need explicit `aria-label` attributes. Additionally, disabled buttons lacking context can frustrate users; providing a `title` attribute when a button is disabled helps users understand what action is required to enable it.
**Action:** Always add `aria-label` or an associated `<label>` to form inputs. Always include a `title` attribute on disabled buttons to explain why they are disabled.
