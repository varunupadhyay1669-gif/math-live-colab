import React from 'react';
import { useTheme } from 'next-themes';
import { Moon, Sun } from 'lucide-react';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <button
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      className="btn-icon"
      data-tip={theme === 'dark' ? 'Daytime (Light)' : 'Nighttime (Dark)'}
      style={{
        background: 'var(--bg-surface)',
        border: '2px solid var(--border-default)',
        boxShadow: 'var(--shadow-sm)',
        color: 'var(--text-primary)',
        width: '40px',
        height: '40px',
      }}
    >
      {theme === 'dark' ? <Moon size={20} /> : <Sun size={20} />}
    </button>
  );
}
