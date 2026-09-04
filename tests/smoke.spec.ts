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

  test("a finished animation does not stay on the learner's screen", async ({ browser }) => {
    // Reported from two real classes, and read both times as a frame being
    // "stuck": a burst of celebration confetti that sat on top of the question
    // for the rest of the lesson, and a geometry sim smeared with every
    // position a dragged vertex had ever been in.
    //
    // Neither was stuck. A frame is a capture of the WHOLE canvas and WebP
    // carries the alpha, so a follower that painted without clearing first
    // composited every frame onto the one before it. Only pixels can show this:
    // the DOM is identical either way, which is why it survived a suite that
    // was otherwise thorough.
    //
    // The learner must be WATCHING while the animation runs. A learner who
    // joins afterwards receives only the final frame and has nothing to pile
    // up — which is how the first version of this test passed against the bug.
    const code = room('anim');
    const teacher = await (await browser.newContext()).newPage();
    const learner = await (await browser.newContext()).newPage();

    await teacher.goto(`${BASE}/room/${code}?name=Teacher`);
    // A square that MOVES across a transparent canvas, clearing behind itself,
    // and then stops. On the teacher this ends as one square on the right; a
    // follower that accumulates ends with all four.
    await runLesson(teacher, `<!doctype html><html><body style="margin:0">
      <h1 id="t">Celebration</h1>
      <canvas id="cel" width="200" height="100"></canvas>
      <button id="go">celebrate</button>
      <script>
        var c = document.getElementById('cel'), g = c.getContext('2d'), step = 0;
        function draw() {
          g.clearRect(0, 0, 200, 100);
          g.fillStyle = '#ff0000';
          g.fillRect(step * 40, 40, 20, 20);
          if (++step < 4) setTimeout(draw, 250);
        }
        document.getElementById('go').onclick = draw;
      </script>
    </body></html>`);
    const src = await lessonFrame(teacher, 'Celebration');

    await learner.goto(`${BASE}/live/${code}?name=Learner`);
    const fol = await lessonFrame(learner, 'Celebration');
    await fol.locator('#cel').waitFor({ timeout: 20_000 });

    const sample = async () => fol.evaluate(() => {
      const c = document.getElementById('cel') as HTMLCanvasElement | null;
      const g = c && c.getContext('2d');
      if (!g) return null;
      const alphaAt = (x: number, y: number) => g.getImageData(x, y, 1, 1).data[3];
      // Where the animation ENDED, and where it BEGAN.
      return { last: alphaAt(130, 50), first: alphaAt(10, 50) };
    });

    // Now run it, with the learner already watching.
    await src.locator('#go').click();

    await expect.poll(async () => (await sample())?.last ?? 0, {
      timeout: 25_000,
      message: "the learner never received the animation's last frame",
    }).toBeGreaterThan(200);

    const px = await sample();
    expect(px!.first,
      'the start of the animation is still painted on the learner — frames are piling up instead of replacing each other')
      .toBeLessThan(40);

    await teacher.close();
    await learner.close();
  });

  test("a learner who is allowed to drive can work the lesson's own buttons", async ({ browser }) => {
    // The reported failure, 4 Sep 2026: "the student cannot click on the button
    // and go to the next concept … it was never an issue but for the last one
    // or two days this is arising a lot."
    //
    // The learner's copy runs no scripts, so pressing the lesson's Next button
    // does nothing locally by design: the click is forwarded to the teacher's
    // authoritative copy, the lesson advances there, and the new DOM comes back.
    // Three hops, and until now no test covered any of them from this direction
    // — every mirror test drives from the teacher.
    const code = room('drive');
    const teacher = await (await browser.newContext()).newPage();
    const learner = await (await browser.newContext()).newPage();

    await teacher.goto(`${BASE}/room/${code}?name=Teacher`);
    await runLesson(teacher, `<!doctype html><html><body>
      <h1 id="t">Steps</h1>
      <p id="step">1</p>
      <!-- Centred, and that is not cosmetic. The parent app floats fixed
           controls over the lesson on the LEARNER's screen — the annotation
           toolbar top-left, the "Writing down what we say" pill bottom-left,
           the call window, the reaction bar. Two earlier versions of this test
           failed because those swallowed the press before it reached the
           lesson, which is a real fault worth its own test and not the one
           this test is for: this one asks whether a learner's click REACHES
           the teacher's copy at all. -->
      <div style="height:260px"></div>
      <div style="text-align:center">
        <button id="next" onclick="document.getElementById('step').textContent = String(+document.getElementById('step').textContent + 1)">Next</button>
      </div>
      <div style="height:260px"></div>
    </body></html>`);
    const src = await lessonFrame(teacher, 'Steps');

    await learner.goto(`${BASE}/live/${code}?name=Learner`);
    const fol = await lessonFrame(learner, 'Steps');
    expect(await fol.locator('#step').textContent()).toBe('1');

    // A fresh room already allows it — the teacher's toggle reads "Students can
    // interact — click for view-only" — so this is the default state a class
    // starts in, not a special mode the test arranges.
    await expect(learner.getByText('INTERACTIVE')).toBeVisible({ timeout: 20_000 });

    // The learner presses Next.
    await fol.locator('#next').click();

    // It has to advance on the teacher's copy, which is the only one running...
    await expect.poll(async () => src.locator('#step').textContent(), {
      timeout: 20_000,
      message: "the learner's click never reached the teacher's lesson",
    }).toBe('2');
    // ...and come back to the learner, which is what they actually see.
    await expect.poll(async () => fol.locator('#step').textContent(), {
      timeout: 20_000,
      message: 'the lesson advanced for the teacher and the learner stayed behind',
    }).toBe('2');

    await teacher.close();
    await learner.close();
  });

  test('the lesson keeps mirroring after a trip to the whiteboard', async ({ browser }) => {
    // THE 4 Sep 2026 FREEZE. "The student cannot click on the button and go to
    // the next concept." What the screenshots actually showed was the teacher on
    // Sub-Concept 2 and the student still on the page before it.
    //
    // The learner's lesson iframe stays MOUNTED while the whiteboard is over it
    // — hidden, not unmounted, so returning to it is instant. Returning fires no
    // load event. Readiness was cleared on every surface change and could only
    // be set true by a load event or by a rescue that read contentDocument, and
    // that rescue died the moment the frame was given an opaque origin: reading
    // contentDocument cross-origin returns null rather than throwing, so it
    // silently answered "not ready" for ever. Every mirror frame then went to a
    // queue nobody flushed.
    //
    // The student's clicks still travelled — which is why it reads as a dead
    // button rather than a frozen screen: they carried a path computed on a page
    // the teacher had left.
    const code = room('wb');
    const teacher = await (await browser.newContext()).newPage();
    const learner = await (await browser.newContext()).newPage();

    await teacher.goto(`${BASE}/room/${code}?name=Teacher`);
    await runLesson(teacher, `<!doctype html><html><body>
      <h1 id="t">Concepts</h1>
      <p id="step">1</p>
      <button id="go" onclick="document.getElementById('step').textContent='2'">next</button>
    </body></html>`);
    const src = await lessonFrame(teacher, 'Concepts');

    await learner.goto(`${BASE}/live/${code}?name=Learner`);
    const fol = await lessonFrame(learner, 'Concepts');
    expect(await fol.locator('#step').textContent()).toBe('1');

    // Over to the whiteboard and back — the shared board, so the learner goes
    // with him. This is the ordinary thing a tutor does mid-explanation.
    // One button, two tooltips — it renames itself once the board is open.
    await teacher.locator('[data-tip="Open the shared whiteboard"]').first().click();
    await teacher.locator('[data-tip="Back to simulation"]').first().click();
    await expect(teacher.locator('[data-tip="Open the shared whiteboard"]').first())
      .toBeVisible({ timeout: 20_000 });

    // Now teach the next concept.
    await src.locator('#go').click();

    await expect.poll(async () => fol.locator('#step').textContent(), {
      timeout: 20_000,
      message: 'the learner stopped receiving the lesson after the whiteboard — this is the freeze',
    }).toBe('2');

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
