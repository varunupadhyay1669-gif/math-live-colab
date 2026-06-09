## 2024-05-18 - Avoid Static ARIA Labels for Dynamic Content
**Learning:** Adding static `aria-label`s to buttons whose visual text frequently changes (e.g., remaining challenge time, sync status) entirely overrides the text for screen readers, effectively hiding critical app state.
**Action:** Before indiscriminately adding an `aria-label`, analyze whether the button displays stateful text. If it does, ensure the `aria-label` string dynamically reflects the same variables or reconsider if `aria-label` is needed over simple text + `aria-hidden` icons.
