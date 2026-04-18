import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Socket } from 'socket.io-client';

interface WhiteboardProps {
  socket: Socket | null;
  roomId: string;
  isOpen: boolean;
  onClose: () => void;
  isTeacher: boolean;
  interactive: boolean;
}

interface DrawPoint {
  x: number;
  y: number;
}

interface DrawStroke {
  points: DrawPoint[];
  color: string;
  width: number;
  tool: 'pen' | 'eraser';
}

interface WhiteboardState {
  imageUrl: string | null;
  strokes: DrawStroke[];
}

const COLORS = ['#000000', '#EF4444', '#10B981', '#3B82F6', '#F59E0B', '#8B5CF6', '#FFFFFF'];
const WIDTHS = [2, 4, 6, 8, 12];

export default function Whiteboard({ socket, roomId, isOpen, onClose, isTeacher, interactive }: WhiteboardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [strokes, setStrokes] = useState<DrawStroke[]>([]);
  const [currentStroke, setCurrentStroke] = useState<DrawPoint[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
  const [color, setColor] = useState('#000000');
  const [width, setWidth] = useState(4);
  const [showUpload, setShowUpload] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);

  // Redraw canvas when strokes or image change
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw image if exists
    if (imageRef.current && imageUrl) {
      const img = imageRef.current;
      const scale = Math.min(
        canvas.width / img.width,
        canvas.height / img.height,
        1
      );
      const w = img.width * scale;
      const h = img.height * scale;
      const x = (canvas.width - w) / 2;
      const y = (canvas.height - h) / 2;
      ctx.drawImage(img, x, y, w, h);
    }

    // Draw strokes
    strokes.forEach(stroke => {
      ctx.beginPath();
      ctx.strokeStyle = stroke.tool === 'eraser' ? '#ffffff' : stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      stroke.points.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x * canvas.width, p.y * canvas.height);
        else ctx.lineTo(p.x * canvas.width, p.y * canvas.height);
      });
      ctx.stroke();
    });

    // Draw current stroke
    if (currentStroke.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = tool === 'eraser' ? '#ffffff' : color;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      currentStroke.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x * canvas.width, p.y * canvas.height);
        else ctx.lineTo(p.x * canvas.width, p.y * canvas.height);
      });
      ctx.stroke();
    }
  }, [strokes, currentStroke, imageUrl, color, width, tool]);

  // Resize canvas to fit container
  useEffect(() => {
    if (!isOpen) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width * 2;
      canvas.height = rect.height * 2;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      redrawCanvas();
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [isOpen, redrawCanvas]);

  // Redraw when data changes
  useEffect(() => {
    redrawCanvas();
  }, [redrawCanvas]);

  // Socket event handlers for receiving whiteboard data
  useEffect(() => {
    if (!socket) return;

    const handleWhiteboardImage = (data: { imageUrl: string }) => {
      setImageUrl(data.imageUrl);
      if (data.imageUrl) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          imageRef.current = img;
          redrawCanvas();
        };
        img.src = data.imageUrl;
      }
    };

    const handleWhiteboardStroke = (data: { stroke: DrawStroke }) => {
      setStrokes(prev => [...prev, data.stroke]);
    };

    const handleWhiteboardClear = () => {
      setStrokes([]);
      setImageUrl(null);
      imageRef.current = null;
    };

    const handleWhiteboardReset = () => {
      setStrokes([]);
    };

    socket.on('whiteboard_image', handleWhiteboardImage);
    socket.on('whiteboard_stroke', handleWhiteboardStroke);
    socket.on('whiteboard_clear', handleWhiteboardClear);
    socket.on('whiteboard_reset', handleWhiteboardReset);

    return () => {
      socket.off('whiteboard_image', handleWhiteboardImage);
      socket.off('whiteboard_stroke', handleWhiteboardStroke);
      socket.off('whiteboard_clear', handleWhiteboardClear);
      socket.off('whiteboard_reset', handleWhiteboardReset);
    };
  }, [socket, redrawCanvas]);

  // Drawing handlers
  const getCanvasCoords = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
  }, []);

  const startDrawing = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!interactive) return;
    try {
      (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
    } catch {}
    setIsDrawing(true);
    setCurrentStroke([getCanvasCoords(e)]);
  };

  const moveDrawing = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !interactive) return;
    setCurrentStroke(prev => [...prev, getCanvasCoords(e)]);
  };

  const endDrawing = (e?: React.PointerEvent<HTMLCanvasElement>) => {
    if (e) {
      try {
        (e.currentTarget as HTMLCanvasElement).releasePointerCapture(e.pointerId);
      } catch {}
    }
    if (!isDrawing) return;
    setIsDrawing(false);

    if (currentStroke.length > 1) {
      const stroke: DrawStroke = {
        points: currentStroke,
        color,
        width,
        tool,
      };
      setStrokes(prev => [...prev, stroke]);
      if (socket) {
        socket.emit('whiteboard_draw', { roomId, stroke });
      }
    }
    setCurrentStroke([]);
  };

  // Image upload handler
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      if (dataUrl) {
        setImageUrl(dataUrl);
        const img = new Image();
        img.onload = () => {
          imageRef.current = img;
          redrawCanvas();
        };
        img.src = dataUrl;
        if (socket) {
          socket.emit('whiteboard_set_image', { roomId, imageUrl: dataUrl });
        }
      }
    };
    reader.readAsDataURL(file);
    setShowUpload(false);
  };

  const clearWhiteboard = () => {
    setStrokes([]);
    if (socket) {
      socket.emit('whiteboard_reset', { roomId });
    }
  };

  const clearImage = () => {
    setImageUrl(null);
    imageRef.current = null;
    setStrokes([]);
    if (socket) {
      socket.emit('whiteboard_clear', { roomId });
    }
  };

  const downloadWhiteboard = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `whiteboard-${Date.now()}.png`;
    link.href = canvas.toDataURL();
    link.click();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}>
      <div className="w-full max-w-6xl h-[90vh] flex flex-col rounded-2xl overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-xl)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-elevated)' }}>
          <div className="flex items-center gap-3">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent-indigo)' }}>
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
            <h3 className="font-display font-bold" style={{ color: 'var(--text-primary)' }}>Collaborative Whiteboard</h3>
            {!interactive && (
              <span className="text-xs px-2 py-1 rounded-full" style={{ background: 'var(--bg-locked)', color: 'var(--text-muted)' }}>
                View Only
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isTeacher && (
              <>
                <button
                  onClick={() => setShowUpload(true)}
                  className="btn text-xs px-3 py-1.5"
                  style={{ background: 'var(--accent-indigo)', color: '#fff' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-1">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                  </svg>
                  Upload Image
                </button>
                <button
                  onClick={clearWhiteboard}
                  className="btn text-xs px-3 py-1.5"
                  style={{ background: 'var(--bg-locked)', color: 'var(--text-secondary)' }}
                >
                  Clear Drawings
                </button>
                {imageUrl && (
                  <button
                    onClick={clearImage}
                    className="btn text-xs px-3 py-1.5"
                    style={{ background: 'var(--bg-locked)', color: 'var(--text-secondary)' }}
                  >
                    Remove Image
                  </button>
                )}
              </>
            )}
            <button
              onClick={downloadWhiteboard}
              className="btn text-xs px-3 py-1.5"
              style={{ background: 'var(--bg-locked)', color: 'var(--text-secondary)' }}
              title="Download as PNG"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            </button>
            <button
              onClick={onClose}
              className="btn text-xs px-3 py-1.5"
              style={{ background: 'none', color: 'var(--text-muted)' }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-4 px-5 py-3 border-b" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-primary)' }}>
          {/* Tool Selection */}
          <div className="flex items-center gap-1 p-1 rounded-lg" style={{ background: 'var(--bg-elevated)' }}>
            <button
              onClick={() => setTool('pen')}
              className={`p-2 rounded-md transition-all ${tool === 'pen' ? 'active' : ''}`}
              style={tool === 'pen' ? { background: 'var(--accent-indigo)', color: '#fff' } : { color: 'var(--text-secondary)' }}
              title="Pen"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5z"/>
              </svg>
            </button>
            <button
              onClick={() => setTool('eraser')}
              className={`p-2 rounded-md transition-all ${tool === 'eraser' ? 'active' : ''}`}
              style={tool === 'eraser' ? { background: 'var(--accent-indigo)', color: '#fff' } : { color: 'var(--text-secondary)' }}
              title="Eraser"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 20H7L3 16C2 15 2 13 3 12L13 2L22 11L20 20Z"/>
                <path d="M17 17L7 7"/>
              </svg>
            </button>
          </div>

          {/* Color Palette */}
          <div className="flex items-center gap-1">
            {COLORS.map(c => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`w-6 h-6 rounded-full border-2 transition-all ${color === c ? 'scale-110' : ''}`}
                style={{
                  background: c,
                  borderColor: color === c ? 'var(--accent-indigo)' : 'transparent',
                  boxShadow: c === '#FFFFFF' ? 'inset 0 0 0 1px rgba(0,0,0,0.2)' : undefined,
                }}
                title={c === '#FFFFFF' ? 'White' : c}
              />
            ))}
          </div>

          {/* Width Selector */}
          <div className="flex items-center gap-1">
            {WIDTHS.map(w => (
              <button
                key={w}
                onClick={() => setWidth(w)}
                className="flex items-center justify-center w-6 h-6 rounded-full transition-all"
                style={{
                  background: width === w ? 'var(--bg-elevated)' : 'transparent',
                }}
                title={`${w}px`}
              >
                <div
                  className="rounded-full"
                  style={{
                    width: w,
                    height: w,
                    background: tool === 'eraser' ? '#ccc' : color,
                  }}
                />
              </button>
            ))}
          </div>

          <div className="flex-1" />

          {/* Stroke Count */}
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {strokes.length} strokes
          </span>
        </div>

        {/* Canvas Container */}
        <div ref={containerRef} className="flex-1 relative" style={{ background: '#f5f5f5' }}>
          <canvas
            ref={canvasRef}
            className="absolute inset-0 cursor-crosshair"
            style={{
              touchAction: 'none',
              background: '#ffffff',
            }}
            onPointerDown={startDrawing}
            onPointerMove={moveDrawing}
            onPointerUp={endDrawing}
            onPointerCancel={endDrawing}
            onPointerLeave={endDrawing}
          />
          {!imageUrl && strokes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--border-subtle)', margin: '0 auto 16px' }}>
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <polyline points="21 15 16 10 5 21"/>
                </svg>
                <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
                  {isTeacher ? 'Upload an image or start drawing' : 'Waiting for teacher to add content...'}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Upload Modal */}
        {showUpload && (
          <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
            <div className="p-6 rounded-xl max-w-sm" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
              <h4 className="font-bold mb-4" style={{ color: 'var(--text-primary)' }}>Upload Image</h4>
              <input
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                className="block w-full text-sm mb-4"
              />
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setShowUpload(false)}
                  className="btn text-xs px-3 py-1.5"
                  style={{ background: 'var(--bg-locked)', color: 'var(--text-secondary)' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
