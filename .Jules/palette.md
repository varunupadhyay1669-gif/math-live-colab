## 2024-05-18 - Improve disabled submit buttons contextual feedback
**Learning:** Submit buttons disabled via a boolean state lack accessibility when not coupled with context. While the form appears visually obvious, screen reader and keyboard-only users miss the cue.
**Action:** Always add a `title` attribute to disabled submit buttons explaining exactly what form fields are required for the button to become active.
