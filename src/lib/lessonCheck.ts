// What this lesson will and won't do once it's mirrored to a class.
//
// The mirror sends the teacher's real DOM plus pixels from the canvases it can
// read. A handful of things fall outside that, and every one of them used to
// fail SILENTLY — the tutor found out mid-lesson, from a student, if at all:
//
//   • an embedded page (GeoGebra, Desmos, YouTube) runs on each student's
//     device independently and is never mirrored;
//   • past four canvases, the rest are simply not sent;
//   • an image from another site poisons the canvas it is drawn on, and the
//     browser then refuses to let us read it at all;
//   • sound never reaches students, because their copy runs no scripts.
//
// None of that is fixable at lesson time. All of it is knowable at upload time,
// which is the moment a tutor can still do something about it — swap the lesson,
// re-generate it, or simply know what to expect before a child is watching.
//
// Deliberately string-based rather than DOM-parsed: this runs on a 2MB document
// while the tutor waits, and every check here is a question about the source
// text, not about a rendered page.

export type CheckLevel = 'blocked' | 'warn' | 'note';

export interface LessonIssue {
  level: CheckLevel;
  /** One line, in the tutor's language — never a tag name or an API. */
  title: string;
  /** What to do about it, when there is something to do. */
  detail: string;
}

const MAX_MIRRORED_CANVASES = 4;

function countTags(html: string, tag: string): number {
  const m = html.match(new RegExp('<' + tag + '\\b', 'gi'));
  return m ? m.length : 0;
}

/** Attribute values from every tag of a kind, e.g. every src on an <img>. */
function attrValues(html: string, tag: string, attr: string): string[] {
  const out: string[] = [];
  const re = new RegExp('<' + tag + '\\b[^>]*?' + attr + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(m[2] ?? m[3] ?? '');
  return out;
}

export function checkLesson(html: string, opts: { maxBytes: number }): LessonIssue[] {
  const issues: LessonIssue[] = [];
  if (typeof html !== 'string' || !html.trim()) return issues;

  // ── Size ──
  // Past the cap the upload is refused outright; near it, every DOM frame is
  // also large, and a slow student falls behind on bandwidth alone.
  const bytes = new Blob([html]).size;
  if (bytes > opts.maxBytes) {
    issues.push({
      level: 'blocked',
      title: `This lesson is ${(bytes / 1024 / 1024).toFixed(1)}MB — over the ${Math.round(opts.maxBytes / 1024 / 1024)}MB limit.`,
      detail: 'Trim it or split it into two lessons. Embedded images are usually what makes a page this large.',
    });
  } else if (bytes > opts.maxBytes * 0.7) {
    issues.push({
      level: 'warn',
      title: `This lesson is large (${(bytes / 1024 / 1024).toFixed(1)}MB).`,
      detail: 'It will work, but students on slow connections may lag behind you. Splitting it up helps.',
    });
  }

  // ── Embedded pages ──
  // stripLessonScripts removes <script>, and nothing else. An <iframe> is a
  // whole second page: it loads independently on every student and the mirror
  // never sees inside it, so whatever happens in there happens separately for
  // each person. AI-generated lessons reach for this constantly.
  const iframes = countTags(html, 'iframe');
  if (iframes > 0) {
    const srcs = attrValues(html, 'iframe', 'src');
    const named = srcs.map(u => {
      try { return new URL(u, 'https://x.invalid').hostname.replace(/^www\./, ''); } catch { return ''; }
    }).filter(h => h && h !== 'x.invalid');
    issues.push({
      level: 'warn',
      title: iframes === 1
        ? 'This lesson embeds another page, which cannot be mirrored.'
        : `This lesson embeds ${iframes} other pages, which cannot be mirrored.`,
      detail: (named.length ? `From ${[...new Set(named)].join(', ')}. ` : '')
        + 'Each student loads it separately, so what they do in it is their own — it will not follow your screen. Everything outside it mirrors normally.',
    });
  }

  // ── Canvases ──
  const canvases = countTags(html, 'canvas');
  if (canvases > MAX_MIRRORED_CANVASES) {
    issues.push({
      level: 'warn',
      title: `This lesson has ${canvases} drawing areas; only the first ${MAX_MIRRORED_CANVASES} are sent to students.`,
      detail: 'The rest will look blank on their screen. Combining them into one, or splitting the lesson, fixes it.',
    });
  }

  // ── Images from other sites ──
  // Drawing one onto a canvas taints it, after which the browser refuses to let
  // us read that canvas at all — so the student sees a permanently blank box,
  // with no error anywhere. Only worth raising when there IS a canvas.
  if (canvases > 0) {
    const remote = attrValues(html, 'img', 'src').filter(u => /^https?:\/\//i.test(u));
    if (remote.length > 0) {
      const hosts = [...new Set(remote.map(u => {
        try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u.slice(0, 40); }
      }))];
      issues.push({
        level: 'note',
        title: 'This lesson loads images from other sites and also draws on a canvas.',
        detail: `From ${hosts.slice(0, 3).join(', ')}${hosts.length > 3 ? ` and ${hosts.length - 3} more` : ''}. If one of those images is drawn onto the canvas, the browser stops us reading it and students see a blank area. Copying the image into the lesson avoids it.`,
      });
    }
  }

  // ── Sound ──
  // A student's copy runs no scripts, by design — that is what stops the lesson
  // running twice. Anything the lesson would have played therefore plays only on
  // the teacher's machine.
  if (/\bnew\s+Audio\b|<audio\b|Tone\.|AudioContext|webkitAudioContext|speechSynthesis/i.test(html)) {
    issues.push({
      level: 'note',
      title: 'This lesson makes sound, which students will not hear.',
      detail: 'Only your copy runs the lesson, so audio plays on your machine. Say it aloud on the call, or share your screen for that part.',
    });
  }

  return issues;
}

/** Nothing to say, or something the tutor should read before teaching. */
export function worstLevel(issues: LessonIssue[]): CheckLevel | null {
  if (issues.some(i => i.level === 'blocked')) return 'blocked';
  if (issues.some(i => i.level === 'warn')) return 'warn';
  if (issues.some(i => i.level === 'note')) return 'note';
  return null;
}
