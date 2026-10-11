// @ts-check
// Touch gestures for the lists: swipe a card to vote on it, pull the page down to refresh it.
// Both only act on a finger, never a mouse, and the owner's gestures switch turns them off.

/** How far a card has to travel sideways before letting go counts as a vote. */
const SWIPE_AT = 96;
/** How far the page has to be pulled before letting go refreshes it. */
const PULL_AT = 80;

/**
 * @param {HTMLElement} card
 * @param {(vote: 1 | -1) => void} onVote
 * @param {() => boolean} enabled
 */
export function attachSwipe(card, onVote, enabled) {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let id = -1;
  let tracking = false;
  let moving = false;
  let swallow = false;
  card.style.touchAction = "pan-y";

  card.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" || !event.isPrimary || !enabled()) return;
    if (/** @type {HTMLElement} */ (event.target).closest("input, textarea, select, button")) return;
    tracking = true;
    moving = false;
    startX = event.clientX;
    startY = event.clientY;
    dx = 0;
    id = event.pointerId;
  });

  card.addEventListener("pointermove", (event) => {
    if (!tracking || event.pointerId !== id) return;
    const mx = event.clientX - startX;
    const my = event.clientY - startY;
    if (!moving) {
      // A mostly vertical move is the page scrolling: leave it alone.
      if (Math.abs(my) > 14 && Math.abs(my) > Math.abs(mx)) {
        tracking = false;
        return;
      }
      if (Math.abs(mx) < 14 || Math.abs(mx) < Math.abs(my) * 1.5) return;
      moving = true;
      card.setPointerCapture(id);
      card.classList.add("swiping");
    }
    dx = mx;
    card.style.transform = `translateX(${Math.max(-140, Math.min(140, dx * 0.7))}px)`;
    card.dataset["swipe"] = dx > SWIPE_AT ? "like" : dx < -SWIPE_AT ? "dislike" : dx > 0 ? "liking" : "disliking";
  });

  /** @param {PointerEvent} event @param {boolean} commit */
  const finish = (event, commit) => {
    if (event.pointerId !== id) return;
    tracking = false;
    if (!moving) return;
    moving = false;
    card.classList.remove("swiping");
    card.style.transform = "";
    delete card.dataset["swipe"];
    // The tap that ends a swipe would otherwise open the link under the finger.
    swallow = true;
    setTimeout(() => {
      swallow = false;
    }, 0);
    if (commit && Math.abs(dx) > SWIPE_AT) onVote(dx > 0 ? 1 : -1);
  };
  card.addEventListener("pointerup", (event) => finish(event, true));
  card.addEventListener("pointercancel", (event) => finish(event, false));
  card.addEventListener(
    "click",
    (event) => {
      if (!swallow) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
}

/**
 * Pull down from the top of the page to run a refresh.
 * @param {{ enabled: () => boolean, refresh: () => Promise<void>, show: (distance: number, ready: boolean, busy: boolean) => void }} options
 */
export function attachPull(options) {
  let startY = 0;
  let pulling = false;
  let distance = 0;
  let busy = false;

  window.addEventListener(
    "touchstart",
    (event) => {
      pulling = !busy && options.enabled() && window.scrollY <= 0 && event.touches.length === 1;
      distance = 0;
      if (pulling) startY = /** @type {Touch} */ (event.touches[0]).clientY;
    },
    { passive: true },
  );
  window.addEventListener(
    "touchmove",
    (event) => {
      if (!pulling) return;
      distance = /** @type {Touch} */ (event.touches[0]).clientY - startY;
      if (distance <= 0 || window.scrollY > 0) {
        distance = 0;
        options.show(0, false, false);
        return;
      }
      options.show(Math.min(distance, 140), distance >= PULL_AT, false);
    },
    { passive: true },
  );
  const release = async () => {
    if (!pulling) return;
    pulling = false;
    if (distance < PULL_AT) {
      options.show(0, false, false);
      return;
    }
    busy = true;
    options.show(PULL_AT, false, true);
    try {
      await options.refresh();
    } finally {
      busy = false;
      options.show(0, false, false);
    }
  };
  window.addEventListener("touchend", release, { passive: true });
  window.addEventListener("touchcancel", () => {
    pulling = false;
    options.show(0, false, false);
  }, { passive: true });
}
