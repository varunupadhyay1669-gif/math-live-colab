import React, { useRef, useEffect, useCallback, useState, useImperativeHandle, forwardRef } from 'react';
import { Socket } from 'socket.io-client';

interface WhiteboardProps {
  socket: Socket | null;
  roomId: string;
  isTeacher: boolean;
  interactive: boolean;
  zoomLevel: number;
  scrollX: number;
  scrollY: number;
  isActive: boolean;
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

export interface WhiteboardRef {
  setImage: (dataUrl: string) => void;
  clearImage: () => void;
  clearDrawings: () => void;
  download: () => void;
  getCanvas: () => HTMLCanvasElement | null;
}

const COLORS = ['#000000', '#EF4444', '#10B981', '#3B82F6', '#F59E0B', '#8B5CF6', '#FFFFFF'];
const WIDTHS = [2, 4, 6, 8, 12];

const Whiteboard = forwardRef<WhiteboardRef, WhiteboardProps>(
  ({ socket, roomId, isTeacher, interactive, zoomLevel, scrollX, scrollY, isActive }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [strokes, setStrokes] = useState<DrawStroke[]>([]);
    const [currentStroke, setCurrentStroke] = useState<DrawPoint[]>([]);
    const [isDrawing, setIsDrawing] = useState(false);
    const [tool, setTool] = useState<'pen' | 'eraser' | 'stroke-eraser'>('pen');
    const [color, setColor] = useState('#000000');
    const [width, setWidth] = useState(4);
    const [showUpload, setShowUpload] = useState(false);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const localScrollRef = useRef({ x: 0, y: 0 });

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
      setImage: (dataUrl: string) => {
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
      },
      clearImage: () => {
        setImageUrl(null);
        imageRef.current = null;
        setStrokes([]);
        if (socket) {
          socket.emit('whiteboard_clear', { roomId });
        }
      },
      clearDrawings: () => {
        setStrokes([]);
        if (socket) {
          socket.emit('whiteboard_reset', { roomId });
        }
      },
      download: () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const link = document.createElement('a');
        link.download = `whiteboard-${Date.now()}.png`;
        link.href = canvas.toDataURL();
        link.click();
      },
      getCanvas: () => canvasRef.current,
    }), [socket, roomId]);

    // Redraw canvas when strokes, image, zoom, or scroll changes
    const redrawCanvas = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Get container dimensions for content size
      const container = containerRef.current;
      const contentWidth = container ? container.scrollWidth : canvas.width;
      const contentHeight = container ? container.scrollHeight : canvas.height;

      // Ensure canvas matches content size
      if (canvas.width !== contentWidth || canvas.height !== contentHeight) {
        canvas.width = contentWidth;
        canvas.height = contentHeight;
      }

      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw white background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Apply zoom transform
      ctx.save();
      ctx.scale(zoomLevel, zoomLevel);

      // Draw image if exists (centered, scaled to fit)
      if (imageRef.current && imageUrl) {
        const img = imageRef.current;
        const maxWidth = canvas.width / zoomLevel;
        const maxHeight = canvas.height / zoomLevel;
        const scale = Math.min(maxWidth / img.width, maxHeight / img.height, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        const x = (maxWidth - w) / 2;
        const y = (maxHeight - h) / 2;
        ctx.drawImage(img, x, y, w, h);
      }

      // Draw strokes with scroll offset
      const offsetX = scrollX / zoomLevel;
      const offsetY = scrollY / zoomLevel;

      strokes.forEach(stroke => {
        ctx.beginPath();
        ctx.strokeStyle = stroke.tool === 'eraser' ? '#ffffff' : stroke.color;
        ctx.lineWidth = stroke.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        stroke.points.forEach((point, index) => {
          const x = (point.x * canvas.width / zoomLevel) - offsetX;
          const y = (point.y * canvas.height / zoomLevel) - offsetY;
          if (index === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        });

        ctx.stroke();
      });

      // Draw current stroke
      if (currentStroke.length > 0) {
        ctx.beginPath();
        ctx.strokeStyle = tool === 'eraser' ? '#ffffff' : color;
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        currentStroke.forEach((point, index) => {
          const x = (point.x * canvas.width / zoomLevel) - offsetX;
          const y = (point.y * canvas.height / zoomLevel) - offsetY;
          if (index === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        });

        ctx.stroke();
      }

      ctx.restore();
    }, [strokes, currentStroke, imageUrl, tool, color, width, zoomLevel, scrollX, scrollY]);

    // Initialize canvas size and redraw
    useEffect(() => {
      if (!isActive || !containerRef.current || !canvasRef.current) return;

      const resize = () => {
        const container = containerRef.current;
        const canvas = canvasRef.current;
        if (!container || !canvas) return;

        // Set canvas to match scrollable content size
        canvas.width = container.scrollWidth;
        canvas.height = container.scrollHeight;
        redrawCanvas();
      };

      resize();
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    }, [isActive, redrawCanvas]);

    // Redraw when dependencies change
    useEffect(() => {
      redrawCanvas();
    }, [redrawCanvas]);

    // Handle clipboard paste for images
    const handlePaste = useCallback(async (e: ClipboardEvent) => {
      if (!isActive || !isTeacher) return;

      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) continue;

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
          reader.readAsDataURL(blob);
          break;
        }
      }
    }, [isActive, isTeacher, roomId, socket, redrawCanvas]);

    // Attach paste listener
    useEffect(() => {
      if (!isActive) return;
      window.addEventListener('paste', handlePaste);
      return () => window.removeEventListener('paste', handlePaste);
    }, [isActive, handlePaste]);

    // Socket event handlers
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

      const handleDeleteStroke = (data: { strokeIndex: number }) => {
        setStrokes(prev => {
          if (data.strokeIndex < 0 || data.strokeIndex >= prev.length) return prev;
          const newStrokes = [...prev];
          newStrokes.splice(data.strokeIndex, 1);
          return newStrokes;
        });
      };

      socket.on('whiteboard_image', handleWhiteboardImage);
      socket.on('whiteboard_stroke', handleWhiteboardStroke);
      socket.on('whiteboard_clear', handleWhiteboardClear);
      socket.on('whiteboard_reset', handleWhiteboardReset);
      socket.on('whiteboard_delete_stroke', handleDeleteStroke);

      return () => {
        socket.off('whiteboard_image', handleWhiteboardImage);
        socket.off('whiteboard_stroke', handleWhiteboardStroke);
        socket.off('whiteboard_clear', handleWhiteboardClear);
        socket.off('whiteboard_reset', handleWhiteboardReset);
        socket.off('whiteboard_delete_stroke', handleDeleteStroke);
      };
    }, [socket, redrawCanvas]);

    // Drawing handlers
    const getCanvasCoords = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      // Account for zoom and scroll
      const x = ((e.clientX - rect.left) / zoomLevel + scrollX) / canvas.width;
      const y = ((e.clientY - rect.top) / zoomLevel + scrollY) / canvas.height;
      return { x, y };
    }, [zoomLevel, scrollX, scrollY]);

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

    // Hit detection for stroke eraser
    const findStrokeAtPoint = useCallback((point: DrawPoint): number => {
      const canvas = canvasRef.current;
      if (!canvas) return -1;

      // Convert normalized point to canvas coordinates
      const px = point.x * canvas.width;
      const py = point.y * canvas.height;

      // Check each stroke in reverse order (top to bottom)
      for (let i = strokes.length - 1; i >= 0; i--) {
        const stroke = strokes[i];
        const hitDistance = stroke.width + 10; // Hit radius

        // Check each line segment in the stroke
        for (let j = 0; j < stroke.points.length - 1; j++) {
          const p1 = stroke.points[j];
          const p2 = stroke.points[j + 1];

          // Convert to canvas coordinates
          const x1 = p1.x * canvas.width;
          const y1 = p1.y * canvas.height;
          const x2 = p2.x * canvas.width;
          const y2 = p2.y * canvas.height;

          // Calculate distance from point to line segment
          const dist = pointToLineDistance(px, py, x1, y1, x2, y2);
          if (dist <= hitDistance) {
            return i;
          }
        }
      }
      return -1;
    }, [strokes]);

    // Helper: distance from point to line segment
    const pointToLineDistance = (px: number, py: number, x1: number, y1: number, x2: number, y2: number): number => {
      const A = px - x1;
      const B = py - y1;
      const C = x2 - x1;
      const D = y2 - y1;

      const dot = A * C + B * D;
      const lenSq = C * C + D * D;
      let param = -1;

      if (lenSq !== 0) {
        param = dot / lenSq;
      }

      let xx, yy;

      if (param < 0) {
        xx = x1;
        yy = y1;
      } else if (param > 1) {
        xx = x2;
        yy = y2;
      } else {
        xx = x1 + param * C;
        yy = y1 + param * D;
      }

      const dx = px - xx;
      const dy = py - yy;

      return Math.sqrt(dx * dx + dy * dy);
    };

    // Delete a specific stroke
    const deleteStroke = useCallback((strokeIndex: number) => {
      if (strokeIndex < 0 || strokeIndex >= strokes.length) return;

      setStrokes(prev => {
        const newStrokes = [...prev];
        newStrokes.splice(strokeIndex, 1);
        return newStrokes;
      });

      if (socket) {
        socket.emit('whiteboard_delete_stroke', { roomId, strokeIndex });
      }
    }, [strokes.length, roomId, socket]);

    const endDrawing = (e?: React.PointerEvent<HTMLCanvasElement>) => {
      if (e) {
        try {
          (e.currentTarget as HTMLCanvasElement).releasePointerCapture(e.pointerId);
        } catch {}
      }
      if (!isDrawing) return;
      setIsDrawing(false);

      if (tool === 'stroke-eraser' && currentStroke.length > 0) {
        // Erase stroke at the clicked point
        const clickPoint = currentStroke[0];
        const strokeIndex = findStrokeAtPoint(clickPoint);
        if (strokeIndex !== -1) {
          deleteStroke(strokeIndex);
        }
      } else if (currentStroke.length > 1) {
        const stroke: DrawStroke = {
          points: currentStroke,
          color,
          width,
          tool: tool === 'eraser' ? 'eraser' : 'pen',
        };
        setStrokes(prev => [...prev, stroke]);
        if (socket) {
          socket.emit('whiteboard_draw', { roomId, stroke });
        }
      }
      setCurrentStroke([]);
    };

    // Handle image upload
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

    // Sync scroll position
    useEffect(() => {
      if (!containerRef.current) return;
      containerRef.current.scrollLeft = scrollX;
      containerRef.current.scrollTop = scrollY;
    }, [scrollX, scrollY]);

    // Handle local scroll to emit sync
    const handleScroll = useCallback(() => {
      if (!containerRef.current || !isTeacher) return;
      const { scrollLeft, scrollTop } = containerRef.current;
      localScrollRef.current = { x: scrollLeft, y: scrollTop };
      
      if (socket) {
        socket.emit('whiteboard_scroll', { roomId, scrollX: scrollLeft, scrollY: scrollTop });
      }
    }, [isTeacher, roomId, socket]);

    // Listen for remote scroll
    useEffect(() => {
      if (!socket || isTeacher) return;

      const handleScroll = (data: { scrollX: number; scrollY: number }) => {
        if (containerRef.current) {
          containerRef.current.scrollLeft = data.scrollX;
          containerRef.current.scrollTop = data.scrollY;
        }
      };

      socket.on('whiteboard_scroll', handleScroll);
      return () => {
        socket.off('whiteboard_scroll', handleScroll);
      };
    }, [socket, isTeacher]);

    if (!isActive) return null;

    return (
      <div className="w-full h-full flex flex-col">
        {/* Toolbar */}
        <div className="flex items-center gap-4 px-4 py-2 border-b" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-elevated)' }}>
          {/* Tool Selection */}
          <div className="flex items-center gap-1 p-1 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
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
            <button
              onClick={() => setTool('stroke-eraser')}
              className={`p-2 rounded-md transition-all ${tool === 'stroke-eraser' ? 'active' : ''}`}
              style={tool === 'stroke-eraser' ? { background: 'var(--accent-rose)', color: '#fff' } : { color: 'var(--text-secondary)' }}
              title="Stroke Eraser (Click to delete entire stroke)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="15" y1="9" x2="9" y2="15"/>
                <line x1="9" y1="9" x2="15" y2="15"/>
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
                style={{ background: width === w ? 'var(--bg-elevated)' : 'transparent' }}
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

          {/* Teacher Controls */}
          {isTeacher && (
            <>
              <button
                onClick={() => setShowUpload(true)}
                className="btn text-xs px-3 py-1.5"
                style={{ background: 'var(--accent-indigo)', color: '#fff' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-1 inline">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <polyline points="21 15 16 10 5 21"/>
                </svg>
                Upload
              </button>
              <button
                onClick={() => setStrokes([])}
                className="btn text-xs px-3 py-1.5"
                style={{ background: 'var(--bg-locked)', color: 'var(--text-secondary)' }}
              >
                Clear
              </button>
              {imageUrl && (
                <button
                  onClick={() => {
                    setImageUrl(null);
                    imageRef.current = null;
                    setStrokes([]);
                    if (socket) socket.emit('whiteboard_clear', { roomId });
                  }}
                  className="btn text-xs px-3 py-1.5"
                  style={{ background: 'var(--bg-locked)', color: 'var(--text-secondary)' }}
                >
                  Remove Image
                </button>
              )}
              <span className="text-xs px-2 py-1 rounded-full" style={{ background: 'var(--accent-indigo-light)', color: 'var(--accent-indigo)' }}>
                Ctrl+V to paste
              </span>
            </>
          )}

          {/* Stroke Count */}
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {strokes.length} strokes
          </span>
        </div>

        {/* Canvas Container with scroll */}
        <div
          ref={containerRef}
          className="flex-1 relative overflow-auto"
          style={{ background: '#f0f0f0' }}
          onScroll={handleScroll}
        >
          <div
            style={{
              width: `${3000 * zoomLevel}px`,
              height: `${2000 * zoomLevel}px`,
              position: 'relative',
            }}
          >
            <canvas
              ref={canvasRef}
              className="absolute top-0 left-0 cursor-crosshair"
              style={{
                touchAction: 'none',
                width: `${3000 * zoomLevel}px`,
                height: `${2000 * zoomLevel}px`,
              }}
              onPointerDown={startDrawing}
              onPointerMove={moveDrawing}
              onPointerUp={endDrawing}
              onPointerCancel={endDrawing}
              onPointerLeave={endDrawing}
            />
          </div>

          {!imageUrl && strokes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--border-subtle)', margin: '0 auto 16px' }}>
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <polyline points="21 15 16 10 5 21"/>
                </svg>
                <h3 className="font-display font-bold" style={{ color: 'var(--text-primary)' }}>Whiteboard</h3>
                <p style={{ color: 'var(--text-muted)', marginTop: 8 }}>
                  {isTeacher
                    ? 'Upload an image or start drawing. Press Ctrl+V to paste from clipboard.'
                    : 'Waiting for teacher to start...'}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Upload Modal */}
        {showUpload && (
          <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
            <div className="bg-white rounded-xl p-6 w-96">
              <h3 className="text-lg font-bold mb-4">Upload Image</h3>
              <input
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                className="w-full mb-4"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => setShowUpload(false)}
                  className="flex-1 py-2 rounded-lg font-medium"
                  style={{ background: 'var(--bg-surface)', color: 'var(--text-secondary)' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
);

export default Whiteboard;
