## 2024-05-24 - Missing accessibility context for inputs relying on placeholders
**Learning:** Found multiple instances where `input` and `textarea` fields lacked explicitly linked `<label>` or `aria-label` tags, using only the `placeholder` property to inform the users.
**Action:** Always ensure that `input` and `textarea` fields have explicit accessibility information either through a linked `<label>` element or by providing an `aria-label` matching the functionality, even when a `placeholder` exists.
