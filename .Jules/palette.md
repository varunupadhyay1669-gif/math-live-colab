## 2024-03-24 - Contextual Disabled States
**Learning:** Adding a `title` to disabled buttons gives screen reader users and mouse users immediate contextual feedback on *why* the interaction is currently blocked (e.g., "Please enter a question first" instead of just a silently unclickable button).
**Action:** When setting `disabled={true}`, simultaneously apply a `title` or tooltip attribute explaining the requirement, especially on forms or toolbars.
