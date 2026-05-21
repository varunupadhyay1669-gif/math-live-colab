## 2024-05-18 - Missing Aria Labels and Disabled Titles
**Learning:** Found that form inputs heavily relied on placeholders for accessibility which fails WCAG guidelines. Furthermore, the "Create room" and "Join room" buttons were completely silent to users as to *why* they were disabled.
**Action:** When inspecting forms, ensure `aria-label` or explicit labels are attached to every input. Apply informative `title` attributes that explicitly describe conditions needed for enabling buttons.
