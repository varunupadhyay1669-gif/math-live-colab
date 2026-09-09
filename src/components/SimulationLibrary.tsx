import React, { useState, useEffect } from 'react';
import { SEED_LESSONS } from '../lib/seedLessons';
import { PRODUCT } from '../lib/product';

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
  /** Ships with the app. Cannot be deleted; a teacher saves their own copy. */
  builtin?: boolean;
  blurb?: string;
}

/**
 * The lessons that come with the product, shaped like saved ones.
 *
 * A library that opens empty is why a trial ends after one lesson: the tutor
 * has to build the product's value before they can judge it. These sit at the
 * top, are never deletable, and are otherwise ordinary items — loading one is
 * the same click as loading your own.
 */
const BUILTIN: LibraryItem[] = SEED_LESSONS.map(l => ({
  id: l.id, name: l.name, html: l.html, topic: l.topic,
  savedAt: 0, builtin: true, blurb: l.blurb,
}));

const TOPICS = PRODUCT.subjects;
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

  const [syncing, setSyncing] = useState(false);

  // The account first, this browser second.
  //
  // Until 9 Sep 2026 this was localStorage and nothing else, which had two
  // consequences that turned out to be the same one. A lesson written on the
  // laptop could not be opened on the iPad. And when 33 lesson files were found
  // living inside rooms — with a button three days old that deletes rooms — the
  // database's only copy of a term of work was inside the rows about to be
  // erased. Migration 0004 lifted them out; this is where they reappear.
  //
  // The local copy is kept and merged rather than replaced: a tutor who is
  // signed out, offline, or in an anonymous demo room still has their library,
  // and nothing they saved before today quietly vanishes.
  useEffect(() => {
    let alive = true;
    let local: LibraryItem[] = [];
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) local = JSON.parse(stored);
    } catch { /* a corrupt library is an empty one, not a crash */ }
    if (alive) setItems(local);

    (async () => {
      try {
        const r = await fetch('/api/lessons', { credentials: 'include' });
        if (!r.ok) return;                       // signed out: local is the library
        const { lessons } = await r.json();
        if (!alive || !Array.isArray(lessons)) return;
        // The list carries no html — it is fetched when one is opened, because
        // a teacher with fifty lessons should not download all of them to read
        // a list of names.
        const remote: LibraryItem[] = lessons.map((l: any) => ({
          id: l.id, name: l.name, html: '', topic: l.topic || 'Other',
          savedAt: new Date(l.updated_at).getTime(), blurb: l.source || undefined,
        }));
        const seen = new Set(remote.map(x => x.id));
        setItems([...remote, ...local.filter(x => !seen.has(x.id))]);
      } catch { /* offline: local is the library */ }
    })();
    return () => { alive = false; };
  }, []);

  const save = (updated: LibraryItem[]) => {
    setItems(updated);
    // Still written locally, so the library survives being signed out.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated.filter(i => i.html)));
    } catch { /* quota: the account copy is the one that matters */ }
  };

  /** Fetch the body of a lesson that lives in the account. */
  const openItem = async (item: LibraryItem) => {
    if (item.html) { onLoad(item.html, item.name); return; }
    setSyncing(true);
    try {
      const r = await fetch(`/api/lessons/${encodeURIComponent(item.id)}`, { credentials: 'include' });
      if (!r.ok) throw new Error('not found');
      const { lesson } = await r.json();
      onLoad(lesson.html, lesson.name);
    } catch {
      alert('Could not open that lesson. Check you are signed in.');
    } finally {
      setSyncing(false);
    }
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
    // To the account as well, so it is there on the iPad this evening. Failure
    // is deliberately quiet: the lesson is already saved locally, and a tutor
    // mid-class does not need a dialog about sync.
    void (async () => {
      try {
        const r = await fetch('/api/lessons', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newItem.name, html: newItem.html, topic: newItem.topic }),
        });
        if (!r.ok) return;
        const { lesson } = await r.json();
        // Adopt the server's id, so deleting it later deletes it there too.
        setItems(prev => prev.map(i => (i.id === newItem.id ? { ...i, id: lesson.id } : i)));
      } catch { /* offline; it is saved in this browser */ }
    })();
  };

  const handleDelete = (id: string) => {
    save(items.filter(i => i.id !== id));
    if (id.startsWith('les-')) {
      void fetch(`/api/lessons/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' })
        .catch(() => { /* it is gone from this browser either way */ });
    }
  };

  if (!isOpen) return null;

  // A teacher's own saved work first, then the shipped set — theirs is the
  // reason they opened this, ours is the reason there is anything here at all.
  const all: LibraryItem[] = [...items, ...BUILTIN.filter(b => !items.some(i => i.id === b.id))];

  const filtered = all.filter(item => {
    if (selectedTopic && item.topic !== selectedTopic) return false;
    if (searchQuery && !item.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const topicCounts = TOPICS.reduce((acc, topic) => {
    acc[topic] = all.filter(i => i.topic === topic).length;
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
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {all.length} to run{items.length > 0 ? ` · ${items.length} yours` : ''}
            </p>
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
                {item.blurb && (
                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                    {item.blurb}
                  </div>
                )}
                <div className="flex items-center gap-2 mt-1">
                  <span className="badge text-[9px]" style={{ background: 'var(--accent-indigo-light)', color: 'var(--accent-indigo)' }}>
                    {item.topic}
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {item.builtin ? 'included' : new Date(item.savedAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
              {/* Goes through openItem, because a lesson that lives in the
                  account arrives here without its html — the list deliberately
                  does not carry fifty lesson bodies just to draw fifty names. */}
              <button onClick={() => void openItem(item)} disabled={syncing}
                className="btn-primary text-[11px]" style={{ padding: '5px 12px' }}>
                {syncing ? 'Opening…' : 'Load'}
              </button>
              {/* Built-ins have no delete: a teacher who cleared the shipped set
                  by accident would be back to the empty shelf this exists to
                  fix, with no way to get it back. */}
              {!item.builtin && (
                <button onClick={() => handleDelete(item.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '14px' }}>
                  🗑
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
