## 2024-05-18 - Home Screen Form Accessibility
**Learning:** Input fields relying solely on `placeholder` attributes present an accessibility issue for screen readers. Providing a `title` on disabled buttons greatly improves the UX by clarifying what is required to enable the action.
**Action:** Always add an explicit `aria-label` or `<label>` element for `<input>` elements. When a primary action button is disabled due to validation, consider adding a `title` attribute to explain what the user needs to provide to proceed.
