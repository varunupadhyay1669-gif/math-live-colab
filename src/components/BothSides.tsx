// The claim the page rests on, shown instead of asserted.
//
// "They see the same board, not a video of your screen" is the whole product,
// and it is also the sentence a tutor has no reason to believe — every video
// call already says something like it. A visitor's real question is narrower
// and more practical: what does the child actually get, on their own cheap
// tablet, and is it readable?
//
// So both sides are drawn side by side with the SAME working on them — the
// working from the demo directly above, so the page tells one story rather
// than three. Deliberately not a screenshot: a screenshot of a whiteboard is
// what every competitor shows, and it proves nothing about liveness.
export default function BothSides() {
  return (
    <div className="ml-sides">
      <figure className="ml-side">
        <figcaption className="ml-side-cap">
          <span className="ml-side-who">You</span>
          <span className="ml-side-dev">laptop</span>
        </figcaption>
        <div className="ml-side-board">
          <span className="ml-side-sum">4 × 21 × 5</span>
          <span className="ml-side-work">= (4 × 5) × 21</span>
          <span className="ml-side-work">= 20 × 21</span>
          <span className="ml-side-ans">= 420</span>
          <span className="ml-side-pen" aria-hidden="true" />
        </div>
      </figure>

      <div className="ml-sides-link" aria-hidden="true">
        <span className="ml-sides-dot" />
        <span className="ml-sides-word">same board</span>
        <span className="ml-sides-dot" />
      </div>

      <figure className="ml-side is-student">
        <figcaption className="ml-side-cap">
          <span className="ml-side-who">Your student</span>
          <span className="ml-side-dev">their iPad</span>
        </figcaption>
        <div className="ml-side-board">
          <span className="ml-side-sum">4 × 21 × 5</span>
          <span className="ml-side-work">= (4 × 5) × 21</span>
          <span className="ml-side-work">= 20 × 21</span>
          <span className="ml-side-ans">= 420</span>
          {/* The point of the whole product: they can write too. */}
          <span className="ml-side-theirs">their turn →</span>
        </div>
      </figure>
    </div>
  );
}
