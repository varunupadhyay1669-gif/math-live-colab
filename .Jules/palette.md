## 2024-05-23 - Explicit Labels and Tooltips for Disabled States
**Learning:** Found that forms in this app sometimes rely only on placeholders without explicit ARIA labels. Additionally, action buttons that are disabled dynamically (e.g. based on missing inputs) do not provide clear context on why they are disabled, leading to a confusing UX and poor accessibility.
**Action:** When designing forms and input areas, do not rely on `placeholder` attributes alone. Explicitly use `aria-label` or `htmlFor`. When a button is disabled, ensure it has a `title` tooltip to explain the reason.
