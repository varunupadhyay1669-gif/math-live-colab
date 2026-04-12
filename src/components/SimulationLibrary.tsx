import React, { useState, useEffect } from 'react';

interface FileEntry {
  id: string;
  name: string;
  html: string;
  uploadedAt: number;
}

interface LibraryItem {
  id: string;
  name: string;
  html: string;
  topic: string;
  savedAt: number;
}

const TOPICS = ['Algebra', 'Geometry', 'Calculus', 'Fractions', 'Probability', 'Trigonometry', 'Statistics', 'Other'];
const STORAGE_KEY = 'mathslive_simulation_library';

interface SimulationLibraryProps {
  isOpen: boolean;
  onClose: () => void;
  onLoad: (html: string, name: string) => void;
  currentHtml?: string;
  currentName?: string;
}

export default function SimulationLibrary({ isOpen, onClose, onLoad, currentHtml, currentName }: SimulationLibraryProps) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [saveName, setSaveName] = useState('');
  const [saveTopic, setSaveTopic] = useState('Other');
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Load from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setItems(JSON.parse(stored));
    } catch {}
  }, []);

  const save = (updated: LibraryItem[]) => {
    setItems(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  };

  const handleSave = () => {
    if (!currentHtml || !saveName.trim()) return;
    const newItem: LibraryItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: saveName.trim(),
      html: currentHtml,
      topic: saveTopic,
      savedAt: Date.now(),
    };
    save([newItem, ...items]);
    setShowSaveForm(false);
    setSaveName('');
  };

  const handleDelete = (id: string) => {
    save(items.filter(i => i.id !== id));
  };

  if (!isOpen) return null;

  const filtered = items.filter(item => {
    if (selectedTopic && item.topic !== selectedTopic) return false;
    if (searchQuery && !item.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const topicCounts = TOPICS.reduce((acc, topic) => {
    acc[topic] = items.filter(i => i.topic === topic).length;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch" style={{ background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)' }}>
      {/* Backdrop click to close */}
      <div className="flex-1" onClick={onClose} />

      {/* Panel */}
      <div className="w-full max-w-md flex flex-col animate-slide-in-right"
        style={{ background: 'var(--bg-card)', borderLeft: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-xl)' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 shrink-0"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div>
            <h2 className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>📚 Simulation Library</h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{items.length} saved simulations</p>
          </div>
          <button onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '20px' }}>✕</button>
        </div>

        {/* Save current */}
        {currentHtml && (
          <div className="px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            {showSaveForm ? (
              <div className="space-y-2 animate-slide-down">
                <input value={saveName} onChange={e => setSaveName(e.target.value)}
                  placeholder={currentName || 'Simulation name'}
                  className="input-field text-sm" style={{ padding: '7px 10px' }} />
                <div className="flex gap-2">
                  <select value={saveTopic} onChange={e => setSaveTopic(e.target.value)}
                    className="input-field text-sm flex-1" style={{ padding: '7px 10px' }}>
                    {TOPICS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <button onClick={handleSave} disabled={!saveName.trim()} className="btn-primary text-[12px] disabled:opacity-40"
                    style={{ padding: '7px 14px' }}>Save</button>
                  <button onClick={() => setShowSaveForm(false)} className="btn text-[12px]"
                    style={{ padding: '7px 12px' }}>✕</button>
                </div>
              </div>
            ) : (
              <button onClick={() => { setShowSaveForm(true); setSaveName(currentName || ''); }}
                className="btn-accent w-full justify-center text-[12px]">
                💾 Save Current Simulation
              </button>
            )}
          </div>
        )}

        {/* Search */}
        <div className="px-4 py-2 shrink-0">
          <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            placeholder="🔍 Search simulations..."
            className="input-field text-sm" style={{ padding: '7px 10px' }} />
        </div>

        {/* Topic filters */}
        <div className="flex gap-1.5 px-4 py-2 overflow-x-auto shrink-0 scrollbar-hide">
          <button onClick={() => setSelectedTopic(null)}
            className={`btn text-[11px] ${!selectedTopic ? 'btn-toolbar-active' : ''}`}
            style={{ padding: '4px 10px' }}>
            All ({items.length})
          </button>
          {TOPICS.filter(t => topicCounts[t] > 0).map(topic => (
            <button key={topic} onClick={() => setSelectedTopic(topic === selectedTopic ? null : topic)}
              className={`btn text-[11px] ${selectedTopic === topic ? 'btn-toolbar-active' : ''}`}
              style={{ padding: '4px 10px' }}>
              {topic} ({topicCounts[topic]})
            </button>
          ))}
        </div>

        {/* Items list */}
        <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2">
          {filtered.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-4xl mb-3 opacity-30">📚</div>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {items.length === 0 ? 'No saved simulations yet' : 'No results found'}
              </p>
            </div>
          ) : filtered.map(item => (
            <div key={item.id} className="flex items-center gap-3 p-3 rounded-xl transition-all group card-hover"
              style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{item.name}</div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="badge text-[9px]" style={{ background: 'var(--accent-indigo-light)', color: 'var(--accent-indigo)' }}>
                    {item.topic}
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {new Date(item.savedAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
              <button onClick={() => onLoad(item.html, item.name)}
                className="btn-primary text-[11px]" style={{ padding: '5px 12px' }}>
                Load
              </button>
              <button onClick={() => handleDelete(item.id)}
                className="opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '14px' }}>
                🗑
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
