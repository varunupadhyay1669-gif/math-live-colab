// The check that has been done by hand, done by a machine.
//
// PLAN.md task 1.8. Everything else in this repository's test suite is offline:
// the injected scripts run in jsdom, the pure functions are called directly,
// the socket protocol is exercised against a headless server. All of that is
// worth having and none of it can answer the only question that matters — does
// a teacher's lesson appear on a learner's screen, and change when the teacher
// changes it.
//
// That question has been answered three times this week by opening two browser
// windows and looking. This is the same walk, run on every push.
//
// The specific failure it exists for is PLAN.md Step 7.4 R4: the mirror
// degrades on a browser update and nobody notices until a tutor says "it isn't
// working" with no way to know which of a dozen things that means.
//
//   npx playwright test              (needs `npm run dev` on :4000)
//   npx playwright install chromium  (once, to fetch the browser)
import { test, expect, type Page, type Frame } from '@playwright/test';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:4000';

/** A room code nobody else is using, without Math.random in a test. */
const room = (name: string) => `smoke${name}${process.env.SMOKE_RUN_ID || Date.now().toString(36).slice(-5)}`;

/**
 * The lesson iframe, once it holds the lesson rather than about:blank.
 *
 * Waited for rather than assumed: the frame is created empty and its blob: URL
 * is set a tick later, and a test that grabs it too early is a test that fails
 * for a reason that has nothing to do with the product.
 */
async function lessonFrame(page: Page, contains: string, timeoutMs = 25_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      try {
        const html = await f.content();
        if (html.includes(contains)) return f;
      } catch { /* navigating; try again */ }
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`no lesson frame containing ${JSON.stringify(contains)} after ${timeoutMs}ms`);
}

/** Paste a lesson into the teacher's room and run it. */
async function runLesson(teacher: Page, html: string) {
  await teacher.getByRole('button', { name: /Paste snippet|Paste Code/ }).first().click();
  await teacher.locator('textarea').first().fill(html);
  await teacher.getByRole('button', { name: /Add & Run|Run & Sync/ }).first().click();
}

test.describe('the mirror', () => {
  test.setTimeout(120_000);

  test('a lesson reaches the learner, and so do the teacher\'s changes', async ({ browser }) => {
    const code = room('a');
    const teacher = await (await browser.newContext()).newPage();
    const learner = await (await browser.newContext()).newPage();

    await teacher.goto(`${BASE}/room/${code}?name=Teacher`);
    await runLesson(teacher, `<!doctype html><html><body>
      <h1 id="t">Fractions</h1>
      <p id="count">0</p>
      <button id="go" onclick="document.getElementById('count').textContent='1'">next</button>
    </body></html>`);
    const src = await lessonFrame(teacher, 'Fractions');
    expect(await src.locator('#t').textContent()).toBe('Fractions');

    await learner.goto(`${BASE}/live/${code}?name=Learner`);
    const fol = await lessonFrame(learner, 'Fractions');
    // The lesson is on the learner's screen at all. This is the product.
    expect(await fol.locator('#t').textContent()).toBe('Fractions');

    // And it MOVES. A shell that merely rendered the uploaded markup would pass
    // the assertion above and fail this one, which is the difference between a
    // mirror and a screenshot.
    await src.locator('#go').click();
    await expect.poll(async () => fol.locator('#count').textContent(), {
      timeout: 20_000,
      message: 'the teacher clicked and the learner never saw it',
    }).toBe('1');

    await teacher.close();
    await learner.close();
  });

  test('a hostile lesson does not run on the learner', async ({ browser }) => {
    const code = room('b');
    const teacher = await (await browser.newContext()).newPage();
    const learner = await (await browser.newContext()).newPage();

    await teacher.goto(`${BASE}/room/${code}?name=Teacher`);
    // Exactly the payload the sanitiser was written against: a script, and a
    // handler that needs no script tag at all. The image src is broken on
    // purpose, so the error event certainly fires wherever the attribute
    // survives.
    await runLesson(teacher, `<!doctype html><html><body>
      <h1 id="t">Worksheet</h1>
      <p>2 + 2 = <input id="ans" value="4"></p>
      <img id="evil" src="does-not-exist.png" onerror="window.__OWNED_BY_ONERROR=1">
      <a id="jsurl" href="javascript:void(0)">tap</a>
      <script>window.__OWNED_BY_SCRIPT=1</script>
    </body></html>`);

    const src = await lessonFrame(teacher, 'Worksheet');
    // On the teacher's copy it all runs, and should: that is the one
    // authoritative instance. If this ever fails, the lesson is broken, not
    // secured.
    expect(await src.evaluate(() => !!(window as any).__OWNED_BY_SCRIPT)).toBe(true);
    expect(await src.evaluate(() => !!(window as any).__OWNED_BY_ONERROR)).toBe(true);

    await learner.goto(`${BASE}/live/${code}?name=Learner`);
    const fol = await lessonFrame(learner, 'Worksheet');

    expect(await fol.locator('#t').textContent()).toBe('Worksheet');
    // A worksheet the learner types into is a first-class lesson type here, so
    // the sanitiser must not eat the form.
    expect(await fol.locator('#ans').inputValue()).toBe('4');

    expect(await fol.evaluate(() => !!(window as any).__OWNED_BY_SCRIPT)).toBe(false);
    expect(await fol.evaluate(() => !!(window as any).__OWNED_BY_ONERROR)).toBe(false);
    expect(await fol.locator('#evil').count()).toBe(1);
    expect(await fol.locator('#evil').getAttribute('onerror')).toBeNull();
    expect(await fol.locator('#jsurl').getAttribute('href')).toBeNull();
    // Our own injected observer lives in this frame and is supposed to; what
    // must not be here is a script that came from the lesson.
    const lessonScripts = await fol.evaluate(() =>
      [...document.querySelectorAll('script')].filter(s => !s.id.startsWith('mathslive')).length);
    expect(lessonScripts, 'a script from the lesson reached the learner').toBe(0);

    await teacher.close();
    await learner.close();
  });

  test('the learner\'s frame has no access to the app', async ({ browser }) => {
    const code = room('c');
    const teacher = await (await browser.newContext()).newPage();
    const learner = await (await browser.newContext()).newPage();

    await teacher.goto(`${BASE}/room/${code}?name=Teacher`);
    await runLesson(teacher, '<!doctype html><html><body><h1>Isolated</h1></body></html>');
    await lessonFrame(teacher, 'Isolated');

    await learner.goto(`${BASE}/live/${code}?name=Learner`);
    await lessonFrame(learner, 'Isolated');

    // The attribute, and then the thing the attribute is for. Checking only the
    // sandbox string would pass on a browser that ignored it.
    const sandbox = await learner.locator('iframe').first().getAttribute('sandbox');
    expect(sandbox).not.toContain('allow-same-origin');
    const readable = await learner.evaluate(() => {
      const f = document.querySelector('iframe') as HTMLIFrameElement | null;
      try { return !!f?.contentDocument; } catch { return false; }
    });
    expect(readable, 'the parent could still read into the learner frame').toBe(false);

    await teacher.close();
    await learner.close();
  });
});
