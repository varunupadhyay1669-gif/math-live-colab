import SaveBoardBanner from './SaveBoardBanner';
import { stripMode } from '../lib/roomChrome';

// One line of room status, not three.
//
// These used to be three separate full-width banners stacked above the board:
// the expiry countdown, the "keep a record of this lesson" prompt, and the
// "saved by" confirmation. Nothing stopped two of them showing at once, and for
// a signed-in tutor with an unsaved board two always did. Together with the
// header and the toolbar that pushed the whiteboard ~150px down a 720px
// screen — held permanently, for prompts that concern two clicks a lesson.
//
// Now: at most one row, chosen by stripMode, and only when something is
// actually actionable.

interface Props {
  expiresAt: number | null;
  claimed: boolean;
  claimedBy: string | null;
  savingBoard: boolean;
  onSaveBoard: () => void;
  canSaveHistory: boolean;
  savingHistory: boolean;
  onSaveHistory: () => void;
  /** True while the whiteboard is open — every pixel here costs board. */
  slim: boolean;
}

export default function RoomStatusStrip({
  expiresAt, claimed, claimedBy, savingBoard, onSaveBoard,
  canSaveHistory, savingHistory, onSaveHistory, slim,
}: Props) {
  const mode = stripMode({ expiresAt, claimed, claimedBy, canSaveHistory, slim });
  if (mode === 'none') return null;

  if (mode === 'saved') {
    return (
      <div className="ml-status-strip is-ok">
        <span>✓ Saved by {claimedBy}</span>
        <span style={{ opacity: 0.7 }}>· this board keeps working for 30 days</span>
      </div>
    );
  }

  // The countdown owns a live clock, so when it is alone it stays its own
  // component — it just no longer stacks with anything.
  if (mode === 'expiry') {
    return <SaveBoardBanner expiresAt={expiresAt!} saving={savingBoard} onSave={onSaveBoard} slim={slim} />;
  }

  return (
    <div className="ml-status-strip">
      <span className="ml-status-strip-text">
        {mode === 'both'
          ? 'This board expires unless you save it.'
          : 'Keep a record of this lesson for the student.'}
      </span>
      {mode === 'both' && (
        <button className="ml-status-strip-btn is-primary" onClick={onSaveBoard} disabled={savingBoard}>
          {savingBoard ? 'Saving…' : 'Save board'}
        </button>
      )}
      <button className="ml-status-strip-btn" onClick={onSaveHistory} disabled={savingHistory}>
        {savingHistory ? 'Saving…' : '💾 Save to history'}
      </button>
    </div>
  );
}
