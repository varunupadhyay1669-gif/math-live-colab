import React, { useRef } from 'react';

interface FileEntry {
  id: string;
  name: string;
  html: string;
  uploadedAt: number;
}

interface FileSidebarProps {
  viewMode: 'split' | 'code' | 'preview';
  files: FileEntry[];
  activeFileId: string | null;
  htmlCode: string;
  setHtmlCode: (code: string) => void;
  uploadFileFromInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
  setShowPasteModal: (show: boolean) => void;
  switchFile: (fileId: string) => void;
  deleteFile: (fileId: string) => void;
  runPreview: () => void;
  activeFile: FileEntry | undefined;
}

export default function FileSidebar({
  viewMode, files, activeFileId, htmlCode, setHtmlCode,
  uploadFileFromInput, setShowPasteModal, switchFile, deleteFile,
  runPreview, activeFile
}: FileSidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showLeftPanel = viewMode === 'split' || viewMode === 'code';
  if (!showLeftPanel) return null;

  return (
    <div
      className="flex flex-col overflow-hidden transition-[width] duration-300 ease-in-out border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)]"
      style={{
        width: viewMode === 'code' ? '100%' : '40%',
        minWidth: viewMode === 'split' ? '320px' : undefined,
      }}
    >
      {/* Upload Bar */}
      <div className="flex items-center gap-3 px-4 py-3 shrink-0 border-b border-[var(--border-subtle)]">
        <input type="file" accept=".html,.htm" ref={fileInputRef} onChange={uploadFileFromInput} className="hidden" multiple />
        <button onClick={() => fileInputRef.current?.click()} className="btn-accent text-[12px]">
          📤 Upload HTML
        </button>
        <button onClick={() => setShowPasteModal(true)} className="btn text-[12px]">
          📋 Paste Code
        </button>
      </div>

      {/* File Tabs */}
      {files.length > 0 && (
        <div className="flex gap-1.5 px-4 py-2 overflow-x-auto shrink-0 scrollbar-hide border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          {files.map(f => (
            <button key={f.id} onClick={() => switchFile(f.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] shrink-0 transition-all group border ${
                activeFileId === f.id
                  ? 'bg-[var(--bg-secondary)] text-[var(--accent-indigo)] border-[var(--border-default)] font-semibold shadow-[var(--shadow-sm)]'
                  : 'bg-transparent text-[var(--text-secondary)] border-transparent font-normal shadow-none'
              }`}
            >
              <span className="max-w-[120px] truncate">{f.name}</span>
              <span onClick={(e) => { e.stopPropagation(); deleteFile(f.id); }}
                className="opacity-0 group-hover:opacity-100 ml-1 cursor-pointer text-base leading-none transition-opacity text-[var(--text-muted)]"
              >×</span>
            </button>
          ))}
        </div>
      )}

      {/* Code Area */}
      <div className="flex-1 flex flex-col overflow-hidden relative min-h-0">
        {files.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center p-8">
            <div className="text-center max-w-sm p-10 rounded-2xl animate-slide-up bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
              <div className="text-5xl mb-5 animate-gentle-bounce">📄</div>
              <h3 className="font-display text-xl font-bold mb-3 text-[var(--text-primary)]">Empty Canvas</h3>
              <p className="text-sm mb-8 text-[var(--text-muted)] leading-relaxed">
                Upload an HTML file or paste a code snippet to get started.
              </p>
              <div className="flex flex-col gap-3">
                <button onClick={() => fileInputRef.current?.click()} className="btn-primary justify-center text-sm">
                  Browse Files
                </button>
                <button onClick={() => setShowPasteModal(true)} className="btn-secondary justify-center text-sm">
                  Paste Snippet
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Editor header */}
            <div className="flex items-center justify-between px-4 py-2.5 shrink-0 border-b border-[var(--border-subtle)]">
              <span className="badge badge-indigo">
                {activeFile?.name || 'Editor'}
              </span>
              <div className="flex items-center gap-3">
                <span className="text-[11px] font-mono hidden sm:inline text-[var(--text-muted)]">⌘+Enter</span>
                <button onClick={runPreview} className="btn-primary text-[12px] px-[14px] py-[6px]">
                  ▶ Run & Sync
                </button>
              </div>
            </div>
            <textarea
              value={htmlCode}
              onChange={(e) => setHtmlCode(e.target.value)}
              className="flex-1 w-full p-4 resize-none focus:outline-none code-editor font-mono text-[13px] leading-relaxed bg-[var(--bg-code)] text-[#D4D4D8] caret-[var(--accent-indigo)]"
              spellCheck={false}
              placeholder="Paste or write your HTML code here..."
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runPreview(); }
                if (e.key === 'Tab') {
                  e.preventDefault();
                  const ta = e.currentTarget;
                  const start = ta.selectionStart;
                  const end = ta.selectionEnd;
                  setHtmlCode(ta.value.substring(0, start) + '  ' + ta.value.substring(end));
                  requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 2; });
                }
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
