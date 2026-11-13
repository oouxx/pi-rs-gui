/** Shared motion presets — short, quiet transitions for a dense desktop UI.
 *  `MotionConfig reducedMotion="user"` (AppShell) strips transform/layout
 *  animation when the OS asks for reduced motion. */

export const EASE_OUT = [0.2, 0.8, 0.2, 1] as const;

/** Enter-only transition for view/tab swaps: a 6px lift, never a large slide.
 *  Exits are skipped so switching stays snappy (no wait-for-exit delay). */
export const enter = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
};

/** Disclosure panels: height auto is measured by Motion. */
export const expand = {
  initial: { height: 0, opacity: 0 },
  animate: { height: "auto", opacity: 1 },
  exit: { height: 0, opacity: 0 },
};

export const FAST_TRANSITION = { duration: 0.16, ease: EASE_OUT } as const;
export const PANEL_TRANSITION = { duration: 0.18, ease: EASE_OUT } as const;
