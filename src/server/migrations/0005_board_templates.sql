-- 0005 — board templates, in the account rather than in one browser.
--
-- PLAN.md task 2.5, the twin of 0004. The founder teaches from a laptop and an
-- iPad. Since 9 Sep 2026 a lesson saved on one is in the library on the other;
-- a board template saved on the laptop still did not exist on the iPad, because
-- templates were `mathlive:templates` in localStorage (src/lib/prefs.ts) and
-- nothing else.
--
-- Nothing to rescue server-side, unlike 0004: templates never reached the
-- database. The browser copies are imported by the client the first time a
-- signed-in teacher's template list loads (src/lib/templatesApi.ts), keeping
-- their ids so every old /room/X?template=abc234 link still opens.

CREATE TABLE IF NOT EXISTS board_templates (
  -- The same 6-character slug prefs.ts has generated since templates shipped
  -- (#68). Unique per OWNER, not globally: ids were minted in separate browsers
  -- with no coordination, so two teachers can legitimately hold the same one,
  -- and a global key would let one teacher's import fail on — and so reveal —
  -- another teacher's template. The CHECK keeps every stored id usable in a link.
  id               text NOT NULL CHECK (id ~ '^[a-z0-9]{6}$'),
  owner_user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Recorded, not trusted. Access is by owner, exactly as lessons are by
  -- teacher, until a team workspace exists to share with; like the columns 0002
  -- added to classes, it is written now so it never needs a guessed backfill.
  workspace_id     text,
  name             text NOT NULL,
  -- The whiteboard as the room stores it: objects, strokes, shapes, texts,
  -- instruments, gridMode, view. Pictures are /api/board-image URLs, never
  -- inline data: URLs — inline pictures are what made one room 128MB.
  snapshot         jsonb NOT NULL,
  -- Measured once at write time, so listing templates never has to cast a
  -- snapshot to text just to say how big it is.
  bytes            integer NOT NULL DEFAULT 0,
  -- Reserved for a thumbnail: a board_images id. Clearing class data treats it
  -- as a picture in use (src/server/classData.ts), so a thumbnail can never be
  -- deleted out from under its template.
  preview_image_id text,
  -- When the teacher saved it. Kept from the browser copy on import, so a
  -- template saved in June does not claim to be from today.
  saved_at         timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, id)
);

CREATE INDEX IF NOT EXISTS board_templates_owner_saved_idx
  ON board_templates (owner_user_id, saved_at DESC);
