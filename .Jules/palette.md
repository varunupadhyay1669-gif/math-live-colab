## 2024-06-04 - Icon-Only Buttons with Text/Emoji

**Learning:** Buttons containing only text emojis or Unicode characters (like ✕ or 🗑) often lack screen reader accessibility. While they may appear as icons visually, screen readers might misinterpret them or read out confusing Unicode names, providing a poor experience compared to descriptive SVG icons.
**Action:** Always add explicit `aria-label` attributes to any icon-only button, regardless of whether it uses an SVG, font icon, or text character/emoji, to ensure clear and consistent screen reader announcements.
