/** One dialog implementation, shared by every overlay.
 *
 *  Focus management was reimplemented three times before this, and
 *  incompletely each time (NEWZWALE_AUDIT.md A-03, A-04, A-05): the mobile
 *  drawer, the topics popover and the saved-articles drawer each opened without
 *  moving focus, none trapped it, none returned it, and none locked background
 *  scroll. A keyboard user tabbing "into" the saved drawer actually tabbed
 *  through the page behind it.
 *
 *  This module is the single correct implementation. Components supply markup
 *  and call `createDialog`; they do not write focus logic.
 *
 *  Deliberately NOT using <dialog>/showModal(): the drawers animate from a
 *  transform, need a custom backdrop that matches the token system, and must
 *  keep working when the page behind them scrolls to a preserved position.
 *  ::backdrop plus the top-layer's own stacking rules fight all three. */

/** Tab-reachable elements. `[hidden]` and `disabled` are excluded by the
 *  selector; zero-size elements are filtered at call time, because a drawer
 *  that is closed but still in the DOM would otherwise report its contents as
 *  focusable. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
]
  .map((s) => `${s}:not([hidden])`)
  .join(',');

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0,
  );
}

/** Body scroll lock, reference counted.
 *
 *  A plain `overflow: hidden` on open and `''` on close breaks as soon as two
 *  overlays are open at once (the saved drawer over the mobile menu): closing
 *  either one unlocks the page under the other. The counter makes close order
 *  irrelevant. The padding compensation stops the layout jumping sideways by
 *  the scrollbar width on desktop. */
let lockCount = 0;
let restorePadding = '';

function lockScroll(): void {
  if (lockCount === 0) {
    const gap = window.innerWidth - document.documentElement.clientWidth;
    restorePadding = document.body.style.paddingRight;
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;
    document.body.style.overflow = 'hidden';
  }
  lockCount += 1;
}

function unlockScroll(): void {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    document.body.style.overflow = '';
    document.body.style.paddingRight = restorePadding;
  }
}

export interface DialogOptions {
  /** The backdrop. Clicking it closes. Omit for non-modal popovers. */
  overlay?: HTMLElement | null;
  /** Called after the dialog is shown, before focus moves in. */
  onOpen?: () => void;
  /** Called after the dialog is hidden, before focus is restored. */
  onClose?: () => void;
  /** Element to focus on open. Defaults to the first focusable descendant. */
  initialFocus?: () => HTMLElement | null;
  /** Modal dialogs lock background scroll and set aria-modal. A popover
   *  (the topics menu) still traps focus and closes on Escape, but must not
   *  freeze the page behind it. */
  modal?: boolean;
}

export interface DialogController {
  open(trigger?: HTMLElement | null): void;
  close(): void;
  toggle(trigger?: HTMLElement | null): void;
  readonly isOpen: boolean;
}

/** Wires accessible dialog behaviour onto existing markup.
 *
 *  `panel` must already carry role="dialog" (or role="menu" for a popover) and
 *  an accessible name — this function manages state and focus, not semantics,
 *  so that the name is visible in the markup where it can be reviewed. */
export function createDialog(panel: HTMLElement, options: DialogOptions = {}): DialogController {
  const { overlay = null, onOpen, onClose, initialFocus, modal = true } = options;

  let openState = false;
  let lastTrigger: HTMLElement | null = null;

  function show(trigger?: HTMLElement | null): void {
    if (openState) return;
    openState = true;

    // Captured BEFORE anything moves focus, so Escape returns the user to the
    // control they actually pressed rather than to <body>.
    lastTrigger =
      trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);

    panel.hidden = false;
    overlay?.removeAttribute('hidden');
    panel.setAttribute('data-open', 'true');
    if (modal) {
      panel.setAttribute('aria-modal', 'true');
      lockScroll();
    }
    lastTrigger?.setAttribute('aria-expanded', 'true');

    onOpen?.();

    const target = initialFocus?.() ?? focusableWithin(panel)[0] ?? panel;
    if (target === panel && !panel.hasAttribute('tabindex')) {
      // An empty dialog still has to receive focus, or Tab would land back in
      // the page behind it.
      panel.setAttribute('tabindex', '-1');
    }

    // Focused synchronously so the move does not depend on a frame being
    // painted, then retried once. The retry covers Safari, where focusing an
    // element that is still zero-size mid-transition is a silent no-op;
    // requestAnimationFrame alone would not, because it does not fire at all in
    // a backgrounded tab.
    target.focus();
    requestAnimationFrame(() => {
      if (openState && !panel.contains(document.activeElement)) target.focus();
    });
  }

  function hide(): void {
    if (!openState) return;
    openState = false;

    panel.removeAttribute('data-open');
    if (modal) {
      panel.removeAttribute('aria-modal');
      unlockScroll();
    }
    overlay?.setAttribute('hidden', '');
    lastTrigger?.setAttribute('aria-expanded', 'false');

    onClose?.();

    // Hiding the panel before restoring focus would drop focus to <body> for a
    // frame, which some screen readers announce as a page change.
    const returnTo = lastTrigger;
    lastTrigger = null;
    if (returnTo && document.contains(returnTo)) returnTo.focus();
    panel.hidden = true;
  }

  panel.hidden = true;
  overlay?.setAttribute('hidden', '');

  overlay?.addEventListener('click', hide);

  panel.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      hide();
      return;
    }

    if (event.key !== 'Tab') return;

    const items = focusableWithin(panel);
    if (items.length === 0) {
      // Nothing to cycle through, but focus must still not escape.
      event.preventDefault();
      return;
    }

    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

  // Escape must work even if focus somehow sits outside the panel, e.g. the
  // user clicked the backdrop, which is not focusable.
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape' && openState && !panel.contains(document.activeElement)) hide();
  });

  return {
    open: show,
    close: hide,
    toggle: (trigger?: HTMLElement | null) => (openState ? hide() : show(trigger)),
    get isOpen() {
      return openState;
    },
  };
}
