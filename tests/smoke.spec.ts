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
import { test, expect, type Page, type Frame, type Locator } from '@playwright/test';

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

/**
 * How much genuine ink a canvas or an <img> holds, and how many colours.
 *
 * Read in the page rather than from a screenshot, because a screenshot proves
 * only that the app drew something — the question here is whether the PIXELS
 * that crossed the wire have a picture in them. White is painted first, exactly
 * as the beam does: a transparent board read straight comes back black
 * everywhere and would look like solid ink.
 */
async function inkStats(locator: Locator) {
  return locator.evaluate((el) => {
    const src = el as HTMLImageElement & HTMLCanvasElement;
    const w = src.naturalWidth || src.width;
    const h = src.naturalHeight || src.height;
    if (!w || !h) return { colours: 0, dark: 0, w: 0, h: 0 };
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    g.drawImage(src, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const seen = new Set<number>();
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      if (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < 120) dark++;
    }
    return { colours: seen.size, dark, w, h };
  });
}

/**
 * Everything a page's socket SENT, as {event, seconds-since-t0}.
 *
 * Reads the websocket frames rather than trusting the UI, because the questions
 * below are about what one person's page makes ANOTHER person's page do, and
 * that only exists on the wire. Socket.IO opens on long-polling and upgrades,
 * so the first second of a page's traffic is not here — everything these tests
 * measure happens well after that.
 */
function sentFrames(page: Page, t0 = Date.now()) {
  const sent: Array<{ ev: string; at: number; body: string }> = [];
  page.on('websocket', ws => {
    ws.on('framesent', d => {
      const s = typeof d.payload === 'string' ? d.payload : String(d.payload);
      const m = s.match(/^42\["([a-z_]+)"/);
      if (m) sent.push({ ev: m[1], at: Math.round((Date.now() - t0) / 100) / 10, body: s });
    });
  });
  return sent;
}

/**
 * Where the ink is on an annotation canvas: the top fifth against the bottom
 * half, counted in pixels that are not transparent.
 *
 * WHERE rather than HOW MUCH, because the two screens are different sizes and
 * the question is only ever "which surface does this canvas think it is on".
 */
async function inkByHalf(page: Page) {
  const c = page.locator('canvas').first();
  if (!(await c.count())) return { top: 0, bottom: 0 };
  return c.evaluate((el) => {
    const cv = el as HTMLCanvasElement;
    if (!cv.width || !cv.height) return { top: 0, bottom: 0 };
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
    let top = 0, bottom = 0;
    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        if (d[(y * cv.width + x) * 4 + 3] > 20) {
          if (y < cv.height * 0.2) top++; else if (y > cv.height * 0.5) bottom++;
        }
      }
    }
    return { top, bottom };
  });
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

  test("the beam puts the tutor's board on the learner's screen, and names who is receiving it", async ({ browser }) => {
    // The founder's request, 4 Sep 2026: "at least the student knows exactly
    // what I'm showing — although he cannot interact in that case, but he
    // should know exactly."
    //
    // The BOARD source rather than the screen one, and not only because
    // getDisplayMedia needs a permission this cannot grant headlessly: the
    // board is the source whose failure is invisible. <Whiteboard> renders null
    // when it is not the surface in front, so getCanvas() returns null and a
    // beam started from anywhere else sends nothing at all, silently — which is
    // the exact failure ("I thought he could see it") the feature exists to end.
    //
    // Real ink is drawn first and the pixels are read at the far end. An empty
    // board is a legitimately blank frame, so a test that passed on one would
    // pass just as happily on a beam that was transmitting nothing.
    const code = room('beam');
    const teacher = await (await browser.newContext()).newPage();
    const learner = await (await browser.newContext()).newPage();

    await teacher.goto(`${BASE}/room/${code}?name=Teacher`);
    await runLesson(teacher, '<!doctype html><html><body><h1 id="t">Beam</h1></body></html>');
    await lessonFrame(teacher, 'Beam');

    await learner.goto(`${BASE}/live/${code}?name=Learner`);
    await lessonFrame(learner, 'Beam');

    // To the board, and pick up a pen — the board opens on the select tool.
    await teacher.locator('[data-tip="Open the shared whiteboard"]').first().click();
    const board = teacher.locator('.whiteboard-canvas-wrap canvas').first();
    await board.waitFor({ timeout: 20_000 });
    await teacher.locator('[aria-label="Pen"]').first().click();

    // A block of ink, not a hairline. The frame is scaled to a 1280px long edge
    // and encoded at WebP 0.6, and a single 4px stroke can be softened past the
    // point where reading one pixel proves anything. Drawn centre-right: the
    // board's own tool rail owns the left edge.
    const box = (await board.boundingBox())!;
    const x0 = box.x + box.width * 0.42;
    const y0 = box.y + box.height * 0.34;
    for (let row = 0; row < 12; row++) {
      const y = y0 + row * 4;
      await teacher.mouse.move(x0, y);
      await teacher.mouse.down();
      await teacher.mouse.move(x0 + 240, y, { steps: 10 });
      await teacher.mouse.up();
    }

    // The ink is on the tutor's own board BEFORE anything is beamed. Without
    // this, a beam that carried a blank board perfectly would fail below and
    // read as a broken beam rather than a pen that never drew.
    const drawn = await inkStats(board);
    expect(drawn.dark, "the pen drew nothing on the tutor's own board").toBeGreaterThan(200);

    // Start the beam: the toolbar button, then "The whiteboard" from its menu.
    // Both by data-testid — the parent app floats fixed controls over the
    // lesson area that swallow a click aimed at anything else.
    await teacher.locator('[data-testid="beam-button"]').click();
    await teacher.locator('[data-testid="beam-board"]').click();

    // 1. A picture arrives at all, as a data: URL over the lesson socket —
    //    no peer connection, no relay, nothing that can be blocked separately.
    const img = learner.locator('[data-testid="beam-image"]');
    await img.waitFor({ timeout: 25_000 });
    await expect.poll(async () => (await img.getAttribute('src'))?.slice(0, 5), {
      timeout: 20_000,
      message: 'the learner has no frame — the beam sent nothing',
    }).toBe('data:');

    // 2. It is a picture OF SOMETHING. Polled, because the first frame can
    //    legitimately land before the stroke does.
    await expect.poll(async () => (await inkStats(img)).dark, {
      timeout: 25_000,
      message: "the beamed frame has no ink in it — the tutor's board did not travel",
    }).toBeGreaterThan(50);
    const got = await inkStats(img);
    expect(got.colours, 'the beamed frame is one flat colour — it captured nothing')
      .toBeGreaterThan(1);

    // 3. The learner is told, in words, that this is not something to touch.
    //    A greyed-out cursor is not a message a child reads.
    await expect(learner.locator('[data-testid="beam-viewonly"]')).toHaveText('VIEW ONLY');

    // 4. And the tutor is told, BY NAME, that it actually arrived. This is the
    //    point of the feature: "My screen" set its state from the tutor's own
    //    getDisplayMedia call, so it said "Sharing" to an empty room. This is
    //    built from acks the learner sent back.
    await expect(teacher.locator('[data-testid="beam-reach"]')).toContainText('Learner', {
      timeout: 20_000,
    });
    await expect(teacher.locator('[data-testid="beam-reach"]')).toContainText('can see this', {
      timeout: 20_000,
    });

    await teacher.close();
    await learner.close();
  });

  test('a learner handed the controls is offered the geometry tools', async ({ browser }) => {
    // "Pls protractor and compass feature to mathslive … and if he want for the
    // students also." The tools already existed — verified by driving them in a
    // browser — but they were teacher-only on BOTH sides, so a learner could
    // watch a construction and never make one.
    //
    // This covers the half a browser must answer: are they on the learner's
    // screen. Whether the server accepts what they draw is asserted against the
    // real protocol in verify-mirror's LIVE section, because a tool that
    // appears and is then silently refused is worse than one that never
    // appeared.
    const code = room('geom');
    const teacher = await (await browser.newContext()).newPage();
    const learner = await (await browser.newContext()).newPage();

    await teacher.goto(`${BASE}/room/${code}?name=Teacher`);
    await learner.goto(`${BASE}/live/${code}?name=Learner`);
    // A fresh room already allows interaction — the state a class starts in,
    // and the permission these tools now follow.
    await expect(learner.getByText('INTERACTIVE')).toBeVisible({ timeout: 20_000 });

    // Onto the shared board. The teacher's toggle takes the learner with them.
    await teacher.locator('[data-tip="Open the shared whiteboard"]').first().click();

    for (const name of ['Compass', 'Ruler', 'Protractor']) {
      await expect(learner.getByRole('button', { name }).first(),
        `${name} is missing from the learner's rail`).toBeVisible({ timeout: 25_000 });
    }

    await teacher.close();
    await learner.close();
  });

  test('the tutor can hand a calculator to the learner, and take it back', async ({ browser }) => {
    // "different calculator options for the teacher and if he want for the
    // students also." The "if he want" is the whole feature: a calculator that
    // is simply there would be wrong in half of his lessons, because mental
    // arithmetic is the thing being taught.
    const code = room('calc');
    const teacher = await (await browser.newContext()).newPage();
    const learner = await (await browser.newContext()).newPage();

    await teacher.goto(`${BASE}/room/${code}?name=Teacher`);
    await learner.goto(`${BASE}/live/${code}?name=Learner`);
    await expect(learner.getByText(/INTERACTIVE|FOLLOWING TEACHER/)).toBeVisible({ timeout: 20_000 });

    // The tutor's own calculator opens for the tutor and NOT for the learner.
    await teacher.getByTestId('calculator-button').click();
    await expect(teacher.getByTestId('calculator-panel')).toBeVisible({ timeout: 10_000 });
    await expect(learner.getByTestId('calculator-panel')).toBeHidden();

    // Hand one over.
    await teacher.getByTestId('student-calculator-toggle').click();
    await expect(learner.getByTestId('calculator-panel'),
      'the learner was given a calculator and never received it').toBeVisible({ timeout: 20_000 });

    // It has to WORK on their side, not merely appear.
    await learner.getByTestId('calculator-input').fill('12*12');
    await expect.poll(async () => learner.getByTestId('calculator-result').textContent(), {
      timeout: 10_000,
      message: "the learner's calculator did not compute",
    }).toContain('144');

    // And taking it back must remove it, not just close it — otherwise a child
    // reopens it during the mental-arithmetic drill it was taken away for.
    await teacher.getByTestId('student-calculator-toggle').click();
    await expect(learner.getByTestId('calculator-panel')).toBeHidden({ timeout: 20_000 });

    await teacher.close();
    await learner.close();
  });

  test('an SVG the lesson draws with script reaches the learner', async ({ browser }) => {
    // Reported 10 Sep 2026 with two photographs: "the student cannot see the
    // animation. He can see the slider but cannot see the animation."
    //
    // The lesson is a matchstick simulator whose <svg> is EMPTY in the uploaded
    // file and filled entirely by script — createElementNS('…/svg', 'line') on
    // every slider move. The learner runs no lesson script by design, so those
    // elements can only ever arrive through the mirror. Everything else on that
    // page — the slider, the stat cards, the styling — is in the source file,
    // which is exactly why the rest looked perfect and only the drawing was
    // missing.
    const code = room('svg');
    const teacher = await (await browser.newContext()).newPage();
    const learner = await (await browser.newContext()).newPage();

    await teacher.goto(`${BASE}/room/${code}?name=Teacher`);
    await runLesson(teacher, `<!doctype html><html><body>
      <style>
        :root { --match-wood: #d97706; --match-head: #dc2626; }
        .match-line { stroke: var(--match-wood); stroke-width: 5; stroke-linecap: round; }
        .match-head { fill: var(--match-head); r: 4; }
      </style>
      <h1 id="t">Matchsticks</h1>
      <div class="lab-stage">
        <svg id="lab" width="300" height="90" viewBox="0 0 300 90"><!-- filled by script --></svg>
      </div>
      <p id="count">0</p>
      <button id="more">more</button>
      <script>
        var svg = document.getElementById('lab');
        function draw(n) {
          svg.innerHTML = '';
          for (var i = 0; i < n; i++) {
            var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', 10 + i * 30); line.setAttribute('y1', 20);
            line.setAttribute('x2', 10 + i * 30); line.setAttribute('y2', 70);
            line.setAttribute('class', 'match-line');
            g.appendChild(line);
            svg.appendChild(g);
          }
          document.getElementById('count').textContent = String(n);
        }
        var n = 3; draw(n);
        document.getElementById('more').onclick = function () { draw(++n); };
      </script>
    </body></html>`);
    const src = await lessonFrame(teacher, 'Matchsticks');
    expect(await src.locator('#lab line').count(), 'the lesson did not draw on the teacher').toBe(3);

    await learner.goto(`${BASE}/live/${code}?name=Learner`);
    const fol = await lessonFrame(learner, 'Matchsticks');

    // The drawing itself, on the learner. This is the whole report.
    await expect.poll(async () => fol.locator('#lab line').count(), {
      timeout: 20_000,
      message: 'the learner has the SVG box and none of the matchsticks in it',
    }).toBe(3);

    // And it must keep up when the teacher changes it, or the learner is left
    // looking at a drawing from earlier in the lesson.
    await src.locator('#more').click();
    await expect.poll(async () => fol.locator('#lab line').count(), {
      timeout: 20_000,
      message: "the learner's drawing did not follow the teacher's",
    }).toBe(4);

    // Painted, not merely present: an SVG element in the wrong namespace sits
    // in the DOM and renders nothing, which looks identical to this bug.
    const painted = await fol.locator('#lab line').first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { ns: el.namespaceURI, w: r.width, h: r.height };
    });
    expect(painted.ns, 'the line is in the HTML namespace, so it will never render')
      .toBe('http://www.w3.org/2000/svg');
    expect(painted.h, 'the line occupies no space on screen').toBeGreaterThan(0);

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

  test('closing an explanation and coming back keeps what the learner typed', async ({ browser }) => {
    // 15 Sep 2026, from the founder, mid-class: a student had half a worksheet
    // done inside an explanation. The tutor closed it to work question 4 through
    // on the whiteboard, opened it again, and every answer was gone — the student
    // had to start from the top. Closing unmounted the explanation's iframe, so
    // reopening loaded the file afresh.
    const code = room('x');
    const teacher = await (await browser.newContext()).newPage();
    const learner = await (await browser.newContext()).newPage();

    await teacher.goto(`${BASE}/room/${code}?name=Teacher`);
    await runLesson(teacher, '<!doctype html><html><body><h1>Main lesson</h1></body></html>');
    await lessonFrame(teacher, 'Main lesson');

    await teacher.getByTitle('Upload an HTML explainer or paste HTML code to overlay on top of the current example').click();
    await teacher.getByPlaceholder('Title (optional, e.g. Step-by-step quadratic)').fill('Conversion Matrix');
    await teacher.getByPlaceholder('Paste your HTML code here...').fill(`<!doctype html><html><body>
      <h2>Triple Conversion Matrix</h2>
      <p>XP: <b id="xp">0</b></p>
      <input id="d1" placeholder="e.g. 0.25"><button id="c1">check</button>
      <script>
        var xp = 0;
        document.getElementById('c1').onclick = function () {
          if (document.getElementById('d1').value.trim() === '.8') {
            xp += 10;
            document.getElementById('xp').textContent = String(xp);
          }
        };
      </script>
    </body></html>`);
    await teacher.getByRole('button', { name: /Show explainer/ }).click();

    const sheet = await lessonFrame(teacher, 'Triple Conversion Matrix');
    await learner.goto(`${BASE}/live/${code}?name=Learner`);
    await lessonFrame(learner, 'Triple Conversion Matrix');

    // The score exists only in the running document: a reload puts it back to 0,
    // which is exactly what the class saw.
    await sheet.locator('#d1').fill('.8');
    await sheet.locator('#c1').click();
    await expect(sheet.locator('#xp')).toHaveText('10');

    // Out of the explanation, onto the whiteboard, back, and open it again.
    await teacher.getByTitle(/^Showing: Conversion Matrix/).click();
    await teacher.getByTitle(/Open the shared whiteboard temporarily/).click();
    await teacher.getByTitle(/Return to the HTML simulation/).click();
    // The tab's text is the explanation's name; "Show … again" is its tooltip.
    await teacher.getByTitle('Show Conversion Matrix again').click();

    const reopened = await lessonFrame(teacher, 'Triple Conversion Matrix');
    await expect(reopened.locator('#d1')).toHaveValue('.8');
    await expect(reopened.locator('#xp')).toHaveText('10');

    // And the learner, whose screen is a copy of that document, sees it too.
    await expect.poll(async () => {
      const f = await lessonFrame(learner, 'Triple Conversion Matrix');
      return (await f.locator('#xp').textContent())?.trim();
    }, { timeout: 20_000, message: "the learner's worksheet came back empty" }).toBe('10');

    await teacher.close();
    await learner.close();
  });

  test('reopening an explanation puts the learner where the tutor left it', async ({ browser }) => {
    // 15 Sep 2026, the afternoon after kept explanations shipped: a reopened
    // explanation came back where the tutor had left it, but the learner's copy
    // started at the top. The founder, mid-class: "the student somewhere else,
    // I'm somewhere else."
    const code = room('y');
    const teacher = await (await browser.newContext()).newPage();
    const learner = await (await browser.newContext()).newPage();
    const tall = (label: string) => `<!doctype html><html><head><title>${label}</title></head><body style="margin:0">
      <h1>${label} top</h1><div style="height:3000px"></div><h2>${label} bottom</h2><div style="height:800px"></div>
    </body></html>`;
    const addExplanation = async (name: string, html: string) => {
      const another = teacher.getByTitle('Add another explanation');
      if (await another.count()) await another.first().click();
      else await teacher.getByTitle('Upload an HTML explainer or paste HTML code to overlay on top of the current example').click();
      await teacher.getByPlaceholder('Title (optional, e.g. Step-by-step quadratic)').fill(name);
      await teacher.getByPlaceholder('Paste your HTML code here...').fill(html);
      await teacher.getByRole('button', { name: /Show explainer/ }).click();
    };

    await teacher.goto(`${BASE}/room/${code}?name=Teacher`);
    await runLesson(teacher, '<!doctype html><html><body><h1>Main lesson</h1></body></html>');
    await lessonFrame(teacher, 'Main lesson');
    await addExplanation('Alpha', tall('Alpha'));
    const alpha = await lessonFrame(teacher, 'Alpha top');
    await learner.goto(`${BASE}/live/${code}?name=Learner`);
    await lessonFrame(learner, 'Alpha top');

    await alpha.evaluate(() => window.scrollTo(0, 2000));
    await addExplanation('Beta', tall('Beta'));
    await lessonFrame(learner, 'Beta top');

    // Back to Alpha, which the tutor left 2000px down.
    await teacher.getByTitle('Show Alpha again').click();
    expect(await alpha.evaluate(() => Math.round(window.scrollY))).toBe(2000);
    await expect.poll(async () => {
      let best = 0;
      for (const f of learner.frames()) {
        if (f === learner.mainFrame()) continue;
        try {
          if ((await f.content()).includes('Alpha top')) best = Math.max(best, Math.round(await f.evaluate(() => window.scrollY)));
        } catch { /* navigating */ }
      }
      return best;
    }, { timeout: 15_000, message: 'the learner was left at the top of the reopened explanation' }).toBe(2000);

    await teacher.close();
    await learner.close();
  });

  test('a learner staring at nothing never stops asking', async ({ browser }) => {
    // 17 Sep 2026, from the production journal: 80 "request_content" across 95
    // joins, and 14 of 17 student sockets sent them at offsets [0, 3, 8, 18] —
    // every rung of a four-rung ladder, which means every one of those students
    // still had an empty screen when it ran out. After that the page went
    // silent for good: the effect's dependencies do not change while a student
    // is stuck, so nothing re-armed it. One student pressed Retry Loading
    // fourteen times in 4.3 seconds and then reloaded.
    //
    // A student with nothing on their screen must keep asking for as long as
    // they have nothing on their screen.
    const code = room('r');
    const teacher = await (await browser.newContext()).newPage();
    const learner = await (await browser.newContext()).newPage();

    // The tutor is here, but has not started. This is the common early arrival.
    await teacher.goto(`${BASE}/room/${code}?name=Teacher`);
    await teacher.waitForTimeout(1500);

    const sent = sentFrames(learner);
    await learner.goto(`${BASE}/live/${code}?name=Learner`);
    await expect(learner.getByText('Waiting for teacher...')).toBeVisible({ timeout: 15_000 });

    // Long enough for the old ladder to finish (20s) and for the steady cadence
    // that replaced its silence to come round at least once.
    await learner.waitForTimeout(42_000);
    const asks = sent.filter(s => s.ev === 'request_content').map(s => s.at);

    // The early rungs are still there: a lesson usually lands in the first
    // couple of seconds and a student who is merely early must not wait.
    expect(asks.filter(at => at < 25).length,
      `the early attempts stopped happening (asks at ${JSON.stringify(asks)})`).toBeGreaterThanOrEqual(4);
    // And it did not give up.
    expect(asks.filter(at => at >= 25).length,
      `the learner gave up asking and sat on an empty screen (asks at ${JSON.stringify(asks)})`).toBeGreaterThan(0);

    // The button says something back. It did its work silently before, which is
    // why a real student pressed it fourteen times and then left.
    const retry = learner.getByRole('button', { name: /Retry Loading/ });
    await retry.click();
    await expect(learner.getByText(/Asking your teacher/),
      'pressing Retry Loading still gives the student no sign that anything happened').toBeVisible({ timeout: 5_000 });

    // Ten more presses in a couple of seconds must not become ten more asks:
    // the room pays for every one of them.
    const before = sent.filter(s => s.ev === 'request_content').length;
    for (let i = 0; i < 10; i++) await retry.click();
    await learner.waitForTimeout(1000);
    expect(sent.filter(s => s.ev === 'request_content').length - before,
      'a rage-clicked button put one ask per press on the wire').toBeLessThanOrEqual(2);

    await teacher.close();
    await learner.close();
  });

  test('one learner asking again does not hand the class the explanation', async ({ browser }) => {
    // 17 Sep 2026. "request_content" is a student saying there is nothing on
    // their screen. It used to be answered by asking the TUTOR's page for its
    // current document — and the tutor's explanations are mirror sources too,
    // so while an explanation was open it was the EXPLANATION that answered,
    // and its markup was stored as the room's live lesson. Every student who
    // hydrated after that got the explainer installed underneath their
    // explanation overlay, and found it there when the tutor closed it: the
    // tutor on the worksheet, the student on the thing explained five minutes
    // ago. The same answer also re-broadcast the lesson to the whole room, so
    // one student's private "I can't see anything" reached everybody.
    //
    // The student should be served from the mirror instead, which is the only
    // copy that knows which surface the class is on.
    const code = room('q');
    const teacher = await (await browser.newContext()).newPage();
    const learner = await (await browser.newContext()).newPage();
    const tutorSent = sentFrames(teacher);

    await teacher.goto(`${BASE}/room/${code}?name=Teacher`);
    await runLesson(teacher, '<!doctype html><html><body><h1>Main lesson</h1></body></html>');
    await lessonFrame(teacher, 'Main lesson');
    await learner.goto(`${BASE}/live/${code}?name=Learner`);
    await lessonFrame(learner, 'Main lesson');

    await teacher.getByTitle('Upload an HTML explainer or paste HTML code to overlay on top of the current example').click();
    await teacher.getByPlaceholder('Title (optional, e.g. Step-by-step quadratic)').fill('Explainer');
    await teacher.getByPlaceholder('Paste your HTML code here...')
      .fill('<!doctype html><html><body><h1>EXPLAINER DOC</h1></body></html>');
    await teacher.getByRole('button', { name: /Show explainer/ }).click();
    await lessonFrame(teacher, 'EXPLAINER DOC');
    const shown = await lessonFrame(learner, 'EXPLAINER DOC');
    await learner.waitForTimeout(1500);

    // Everything the tutor's page sends from here is caused by the student.
    const mark = tutorSent.length;

    // The learner asks for the lesson again, through the product's own path for
    // it: the surface on their screen reporting that it could not follow along.
    await shown.evaluate(() => window.parent.postMessage({ type: 'SYNC_REPLAY_MISS' }, '*'));
    await teacher.waitForTimeout(4000);
    const caused = tutorSent.slice(mark);

    const uploaded = caused.filter(c => c.ev === 'sync_html_update' || c.ev === 'run_preview');
    expect(uploaded.map(u => u.ev + (u.body.includes('EXPLAINER DOC') ? ' (the EXPLANATION!)' : '')),
      'a student asking for the lesson made the tutor re-seed the room').toEqual([]);
    // And the student was answered by the thing that knows what is on screen.
    expect(caused.some(c => c.ev === 'mirror_dom'),
      'nothing asked the mirror for a frame, so the student got no picture').toBe(true);

    await teacher.close();
    await learner.close();
  });

  test('a learner who arrives mid-explanation draws on the same page as the tutor', async ({ browser }) => {
    // 17 Sep 2026. Ink is tagged with the surface it was drawn on, and each
    // side only paints ink belonging to the surface it is showing. The copy of
    // the explanation sent to a JOINING student carries no id, and the student
    // was writing that missing id straight over the correct one it had been
    // given a moment earlier — so the student's layer fell back to 'main'.
    //
    // A second message usually repaired it within a round trip, which is why
    // this was invisible for so long. It does not arrive while the tutor's seat
    // is inside its 45-second grace, and the journal has six of those with a
    // student in the room. Then: the tutor circles a term on the explanation
    // and says "this one", the student sees no circle, and sees instead
    // whatever the tutor drew on the LESSON earlier, floating over the
    // explanation. Two people pointing at different things.
    //
    // The lesson's ink goes at the top of the surface and the explanation's at
    // the bottom, so which surface each screen believes it is on is readable as
    // where the ink is.
    const code = room('m');
    const teacher = await (await browser.newContext()).newPage();
    await teacher.goto(`${BASE}/room/${code}?name=Teacher`);
    await runLesson(teacher, '<!doctype html><html><body><h1>Main lesson</h1></body></html>');
    await lessonFrame(teacher, 'Main lesson');

    await teacher.locator('[data-tip="Ink (permanent)"]').click();
    const box = await teacher.locator('iframe').first().boundingBox();
    if (!box) throw new Error('the tutor has no lesson surface to draw on');
    const stroke = async (y1: number, y2: number) => {
      await teacher.mouse.move(box.x + 60, box.y + y1);
      await teacher.mouse.down();
      await teacher.mouse.move(box.x + 300, box.y + y2, { steps: 12 });
      await teacher.mouse.up();
      await teacher.waitForTimeout(1200);
    };
    await stroke(box.height * 0.06, box.height * 0.10); // on the LESSON

    await teacher.getByTitle('Upload an HTML explainer or paste HTML code to overlay on top of the current example').click();
    await teacher.getByPlaceholder('Title (optional, e.g. Step-by-step quadratic)').fill('Explainer');
    await teacher.getByPlaceholder('Paste your HTML code here...')
      .fill('<!doctype html><html><body><h1>EXPLAINER DOC</h1></body></html>');
    await teacher.getByRole('button', { name: /Show explainer/ }).click();
    await lessonFrame(teacher, 'EXPLAINER DOC');
    await stroke(box.height * 0.80, box.height * 0.84); // on the EXPLANATION

    // The tutor's socket drops — the seat grace, with nobody able to answer for
    // a joining student.
    const offline = teacher.context();
    await offline.setOffline(true);
    await teacher.waitForTimeout(2000);

    const learner = await (await browser.newContext()).newPage();
    await learner.goto(`${BASE}/live/${code}?name=Learner`);
    await lessonFrame(learner, 'EXPLAINER DOC');
    await learner.waitForTimeout(4000);

    const tutorInk = await inkByHalf(teacher);
    const learnerInk = await inkByHalf(learner);
    expect(tutorInk.bottom, "the tutor's own explanation ink is missing — the walk is wrong, not the app").toBeGreaterThan(0);
    expect(tutorInk.top, "the tutor is showing the lesson's ink over the explanation").toBe(0);

    expect(learnerInk.bottom,
      "the tutor's marks on the explanation never reached the learner").toBeGreaterThan(0);
    expect(learnerInk.top,
      "the learner has the LESSON's old ink floating over the explanation").toBe(0);

    await offline.setOffline(false);
    await teacher.close();
    await learner.close();
  });
});
