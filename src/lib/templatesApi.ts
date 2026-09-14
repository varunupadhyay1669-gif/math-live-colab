// Board templates for the screens: the account first, this browser second.
//
// PLAN.md task 2.5, 14 Sep 2026. The founder teaches from a laptop and an iPad,
// and a template saved on one did not exist on the other, because templates
// were localStorage and nothing else (prefs.ts). They live in the account now
// (src/server/templates.ts); this file is how the home page, the room and the
// whiteboard reach them.
//
// The browser copy is kept and merged rather than replaced, for the same reason
// the lesson library keeps its own (SimulationLibrary.tsx): a tutor who is
// signed out, offline, or in an anonymous demo room still has their templates,
// and nothing saved before today quietly vanishes.
//
// Three promises the screens rely on:
//
//   * Nothing here throws. Every call answers with what it could do and a
//     sentence for the teacher, because every caller sits next to a live class.
//   * Nothing here waits forever. Each request has a timeout, so an iPad on a
//     bad connection falls back to this browser's copies instead of spinning.
//   * The first signed-in template list moves this browser's templates into the
//     account, once, keeping their ids — so /room/X?template=abc234 links made
//     before today still open — and deletes none of the local copies.
import { apiFetch } from './passcode';
import { prefs, templates as deviceStore, type LessonTemplate } from './prefs';

/** One row of a template list. Never carries the board itself. */
export interface TemplateSummary {
  id: string;
  name: string;
  /** ms epoch */
  savedAt: number;
  /** In the account (every device), or only in this browser. */
  source: 'account' | 'device';
}

/**
 * The media type a template save is sent as.
 *
 * Mirrors src/server/templates.ts, which explains it: the server's global JSON
 * parser stops at 100kB, and a board with a few hundred strokes passes that.
 * Written out here rather than imported so the browser bundle never pulls in
 * server code; verify-mirror checks the two are the same string.
 */
export const TEMPLATE_MEDIA_TYPE = 'application/vnd.mathslive.template+json';

/** The notice, word for word, shown once after the first templates move. */
export const IMPORT_NOTICE = 'Your board templates are now saved to your account';

/** An id a link can carry — the same pattern the server and its table enforce. */
export function isLinkableTemplateId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9]{6}$/.test(id);
}

// ── Pure: the decisions, testable without a browser ──────────────────────────

/**
 * One list from two: the account's templates and this browser's.
 *
 * Deduplicated by id, and the ACCOUNT copy wins: it is the one every device
 * sees, and its pictures are image-store URLs where a browser copy may still
 * hold them inline. A browser copy the account does not have is kept and
 * marked as this device's only.
 *
 * With one exception, which is what `importedIds` is for. An id this browser
 * already moved into the account, that the account no longer has, was deleted
 * there — on the iPad, say. Showing the laptop's old copy again would bring
 * back a template the teacher removed.
 */
export function mergeTemplateLists(
  account: TemplateSummary[],
  device: TemplateSummary[],
  importedIds: Iterable<string> = [],
): TemplateSummary[] {
  const inAccount = new Set(account.map(t => t.id));
  const deletedThere = new Set(importedIds);
  const seen = new Set<string>();
  const out: TemplateSummary[] = [];
  const candidates = [
    ...account.map(t => ({ ...t, source: 'account' as const })),
    ...device
      .filter(t => !inAccount.has(t.id) && !deletedThere.has(t.id))
      .map(t => ({ ...t, source: 'device' as const })),
  ];
  for (const t of candidates) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  // Newest first, as the browser list always was. Array sort is stable, so
  // the account copy of two same-second saves stays ahead.
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/** What this browser remembers about moving its templates into one account. */
export interface ImportRecord {
  /** Now in the account because this browser put them there. */
  imported: string[];
  /** Refused by the account for good — too large, a picture it cannot keep, a
   *  full account. Still usable here; not re-sent on every visit. */
  refused: string[];
  /** The one-time notice has been on screen. */
  noticeShown: boolean;
}

export function readImportRecord(raw: unknown): ImportRecord {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ImportRecord, unknown>>;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return { imported: ids(r.imported), refused: ids(r.refused), noticeShown: r.noticeShown === true };
}

/**
 * The browser copies still to offer the account.
 *
 * Not already there, not already sent, not already refused — and only ones a
 * link can reach and that actually hold a board. Everything else stays exactly
 * where it is, on this device.
 */
export function planTemplateImport(
  device: LessonTemplate[],
  accountIds: Iterable<string>,
  record: ImportRecord,
): LessonTemplate[] {
  const skip = new Set<string>([...accountIds, ...record.imported, ...record.refused]);
  return device.filter(t =>
    !!t && isLinkableTemplateId(t.id) && !skip.has(t.id)
    && !!t.whiteboard && typeof t.whiteboard === 'object' && !Array.isArray(t.whiteboard));
}

// ── The network, reduced to three outcomes ───────────────────────────────────

interface Failed { ok: false; kind: 'signed-out' | 'refused' | 'unreachable'; status: number; message: string; }
type Outcome<T> = { ok: true; body: T } | Failed;

/**
 * The failure half of an outcome, or null when it worked. This project compiles
 * without strictNullChecks, where testing `!r.ok` does not narrow the union, so every
 * failure branch reads the failure through this instead.
 */
function failure<T>(o: Outcome<T>): Failed | null {
  return o.ok ? null : (o as Failed);
}

/**
 * One request, never a throw.
 *
 * 'refused' is the account answering no and meaning it (too large, full, not
 * found); 'unreachable' is everything that might go through on another try,
 * including a server that answered with something other than JSON — which is
 * what an SPA fallback page looks like to a fetch.
 */
async function call<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Outcome<T>> {
  const { timeoutMs = 10_000, ...rest } = init;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await apiFetch(path, { ...rest, credentials: 'same-origin', signal: controller?.signal });
    let body: any = null;
    try { body = await res.json(); } catch { /* not JSON; judged below */ }
    const said = typeof body?.error === 'string' ? body.error : '';
    if (res.status === 401) return { ok: false, kind: 'signed-out', status: 401, message: said || 'Not signed in.' };
    if (res.ok) {
      if (!body || typeof body !== 'object') {
        return { ok: false, kind: 'unreachable', status: res.status, message: 'The server did not answer as expected.' };
      }
      return { ok: true, body: body as T };
    }
    const definite = [400, 404, 409, 413, 422].includes(res.status);
    return {
      ok: false,
      kind: definite ? 'refused' : 'unreachable',
      status: res.status,
      message: said || (res.status === 413 ? 'That board is too large to save as a template.' : `The server answered ${res.status}.`),
    };
  } catch {
    return { ok: false, kind: 'unreachable', status: 0, message: 'Could not reach the server.' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fromServerRow(row: any): TemplateSummary | null {
  if (!row || !isLinkableTemplateId(row.id)) return null;
  const savedAt = Date.parse(String(row.saved_at ?? ''));
  return {
    id: row.id,
    name: String(row.name || 'Untitled template'),
    savedAt: Number.isFinite(savedAt) ? savedAt : 0,
    source: 'account',
  };
}

function deviceSummaries(): TemplateSummary[] {
  return deviceStore.list()
    .filter(t => !!t && typeof t.id === 'string' && t.id.length > 0)
    .map(t => ({
      id: t.id,
      name: String(t.name || 'Untitled template'),
      savedAt: Number(t.savedAt) || 0,
      source: 'device' as const,
    }));
}

const importKey = (userId: string) => `templatesImport:${userId}`;

function writeImportRecord(userId: string, record: ImportRecord): void {
  prefs.setJson(importKey(userId), {
    imported: [...new Set(record.imported)],
    refused: [...new Set(record.refused)],
    noticeShown: record.noticeShown,
  });
}

// ── What the screens call ────────────────────────────────────────────────────

/** This browser's templates, straight away — what a list shows before the account answers. */
export function deviceTemplateList(): TemplateSummary[] {
  return mergeTemplateLists([], deviceSummaries());
}

export interface TemplateListResult {
  templates: TemplateSummary[];
  /** 'account': the account answered. 'device': signed out, so this browser's
   *  copies. 'unreachable': signed in, but the account could not be read. */
  from: 'account' | 'device' | 'unreachable';
  /** IMPORT_NOTICE, until markImportNoticeShown is called for this teacher. */
  notice: string | null;
  /** A sentence for the teacher when something did not work; nothing is lost. */
  problem: string | null;
}

// One run per teacher at a time. React mounts effects twice in development, and
// two overlapping imports would each send every template.
const inflight = new Map<string, Promise<TemplateListResult>>();

/**
 * The template list for the home page, moving this browser's templates into
 * the account on the way. Signed out (no userId) it is this browser's copies.
 */
export function loadTemplateList(userId: string | null): Promise<TemplateListResult> {
  if (!userId) {
    return Promise.resolve({ templates: deviceTemplateList(), from: 'device', notice: null, problem: null });
  }
  const running = inflight.get(userId);
  if (running) return running;
  const run = loadForAccount(userId)
    .catch((): TemplateListResult => ({
      templates: deviceTemplateList(), from: 'unreachable', notice: null,
      problem: 'Could not read your templates — showing the ones saved on this device.',
    }))
    .finally(() => { inflight.delete(userId); });
  inflight.set(userId, run);
  return run;
}

async function loadForAccount(userId: string): Promise<TemplateListResult> {
  const local = deviceSummaries();
  const listed = await call<{ templates?: unknown }>('/api/templates');
  if (!listed.ok || !Array.isArray(listed.body.templates)) {
    if (failure(listed)?.kind === 'signed-out') {
      return { templates: mergeTemplateLists([], local), from: 'device', notice: null, problem: null };
    }
    return {
      templates: mergeTemplateLists([], local), from: 'unreachable', notice: null,
      problem: 'Could not reach your account — showing the templates saved on this device.',
    };
  }

  let account = (listed.body.templates as unknown[])
    .map(fromServerRow)
    .filter((t): t is TemplateSummary => t !== null);
  const record = readImportRecord(prefs.getJson(importKey(userId), null));
  const todo = planTemplateImport(deviceStore.list(), account.map(t => t.id), record);

  // One at a time, oldest problem first: a full account or a dropped connection
  // stops the run rather than failing the same way twenty-four more times.
  let retryLater = false;
  const refusedNow: string[] = [];
  for (const tpl of todo) {
    const sent = await call<{ template?: unknown }>('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': TEMPLATE_MEDIA_TYPE },
      body: JSON.stringify({ id: tpl.id, name: tpl.name, savedAt: tpl.savedAt, snapshot: tpl.whiteboard }),
      timeoutMs: 30_000,
    });
    if (sent.ok) {
      record.imported.push(tpl.id);
      const row = fromServerRow(sent.body.template);
      if (row) account = [row, ...account.filter(t => t.id !== row.id)];
    } else if (failure(sent)?.kind === 'refused') {
      record.refused.push(tpl.id);
      refusedNow.push(`"${tpl.name}": ${failure(sent)!.message}`);
    } else {
      retryLater = true;
      break;
    }
  }
  if (todo.length > 0) writeImportRecord(userId, record);

  let problem: string | null = null;
  if (refusedNow.length > 0) {
    problem = `${refusedNow.length === 1 ? 'A template' : `${refusedNow.length} templates`} could not move to your account and ${refusedNow.length === 1 ? 'stays' : 'stay'} on this device only — ${refusedNow[0]}`;
  } else if (retryLater) {
    problem = 'Some templates on this device have not moved to your account yet. They will be tried again next time.';
  }

  return {
    templates: mergeTemplateLists(account, local, record.imported),
    from: 'account',
    notice: record.imported.length > 0 && !record.noticeShown ? IMPORT_NOTICE : null,
    problem,
  };
}

/** Called once the notice has actually been on screen, so a page closed mid-import still shows it next time. */
export function markImportNoticeShown(userId: string): void {
  const record = readImportRecord(prefs.getJson(importKey(userId), null));
  if (record.noticeShown) return;
  record.noticeShown = true;
  writeImportRecord(userId, record);
}

export interface TemplateLoad {
  template: LessonTemplate | null;
  from: 'account' | 'device' | null;
  /** Why there is no template, when there is none. */
  problem: string | null;
}

/**
 * One template with its board, for starting a class from it.
 *
 * The account first — that is what makes a link made on the laptop open on the
 * iPad — and this browser's copy when signed out, offline, or not in the account.
 */
export async function getTemplate(id: string): Promise<TemplateLoad> {
  const local = deviceStore.get(id);
  if (!isLinkableTemplateId(id)) {
    return local
      ? { template: local, from: 'device', problem: null }
      : { template: null, from: null, problem: 'That template link is not valid.' };
  }
  const r = await call<{ template?: any }>(`/api/templates/${encodeURIComponent(id)}`);
  if (r.ok) {
    const t = r.body.template;
    if (t && t.snapshot && typeof t.snapshot === 'object') {
      const savedAt = Date.parse(String(t.saved_at ?? ''));
      return {
        template: {
          id: String(t.id), name: String(t.name || 'Untitled template'),
          savedAt: Number.isFinite(savedAt) ? savedAt : Date.now(), whiteboard: t.snapshot,
        },
        from: 'account',
        problem: null,
      };
    }
  }
  if (local) return { template: local, from: 'device', problem: null };
  if (failure(r)?.kind === 'signed-out') {
    return { template: null, from: null, problem: 'That template is not on this device. Sign in to use the templates in your account.' };
  }
  if (failure(r)?.kind === 'unreachable') {
    return { template: null, from: null, problem: 'Could not reach your account to load that template. Check the connection and open the link again.' };
  }
  return { template: null, from: null, problem: 'That template is not in your account or on this device.' };
}

export interface TemplateSave {
  /** False only when the template is saved nowhere at all. */
  ok: boolean;
  saved: TemplateSummary | null;
  /** The toast, as the teacher should read it. */
  message: string;
}

/** Keep it in this browser, and read it back: prefs swallows a full localStorage without a word. */
function saveOnDevice(name: string, whiteboard: unknown): TemplateSummary | null {
  try {
    const tpl = deviceStore.save(name, whiteboard);
    if (!deviceStore.get(tpl.id)) return null;
    return { id: tpl.id, name: tpl.name, savedAt: tpl.savedAt, source: 'device' };
  } catch {
    return null;
  }
}

/**
 * Save the board as a new template: to the account when signed in, to this
 * browser otherwise — and when the account cannot take it, to this browser
 * anyway, saying so. Before this release every template saved here; none may
 * stop saving because the account is unreachable.
 */
export async function saveTemplate(name: string, whiteboard: unknown): Promise<TemplateSave> {
  const cleanName = name.trim() || `Template ${new Date().toLocaleDateString()}`;
  const sent = await call<{ template?: unknown }>('/api/templates', {
    method: 'POST',
    headers: { 'Content-Type': TEMPLATE_MEDIA_TYPE },
    body: JSON.stringify({ name: cleanName, snapshot: whiteboard }),
    timeoutMs: 30_000,
  });
  const row = sent.ok ? fromServerRow(sent.body.template) : null;
  if (row) return { ok: true, saved: row, message: `✓ Saved to your account: ${row.name}` };

  const signedOut = failure(sent)?.kind === 'signed-out';
  const refusedBecause = failure(sent)?.kind === 'refused' ? failure(sent)!.message : null;
  const local = saveOnDevice(cleanName, whiteboard);
  if (!local) {
    const why = refusedBecause || (signedOut ? '' : 'could not reach your account');
    return {
      ok: false, saved: null,
      message: `⚠️ Could not save the template${why ? ` (${why})` : ''}, and this device has no room left for it.`,
    };
  }
  if (signedOut) return { ok: true, saved: local, message: `✓ Saved on this device: ${local.name}` };
  if (refusedBecause) return { ok: true, saved: local, message: `⚠️ ${refusedBecause} Saved on this device only.` };
  return {
    ok: true, saved: local,
    message: `✓ Saved on this device: ${local.name}. Your account could not be reached; it moves there next time your templates load.`,
  };
}

/**
 * Remove a template everywhere this browser can reach.
 *
 * An account template is deleted from the account first, and if that cannot
 * happen nothing is removed — a template that vanished here but lived on in the
 * account would reappear on the iPad. This browser's copy goes too: the teacher
 * asked for this template to go, and a local copy left behind would be back the
 * next time they were signed out. (Only this explicit remove deletes a local
 * copy; the import never does.)
 */
export async function removeTemplate(
  template: Pick<TemplateSummary, 'id' | 'source'>,
  userId: string | null,
): Promise<{ ok: boolean; problem: string | null }> {
  if (userId && template.source === 'account' && isLinkableTemplateId(template.id)) {
    const r = await call<{ ok?: boolean }>(`/api/templates/${encodeURIComponent(template.id)}`, { method: 'DELETE' });
    const failed = failure(r);
    if (failed && failed.kind !== 'signed-out') {
      return { ok: false, problem: 'Could not remove that template from your account. Check the connection and try again.' };
    }
  }
  deviceStore.remove(template.id);
  return { ok: true, problem: null };
}
