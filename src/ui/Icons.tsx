/**
 * The icon set.
 *
 * Four buttons in the toolbar's right-hand cluster carry an icon and no words — Share,
 * Connections, Assistant, Inspector. They are the actions that are reached for rather than
 * read: a toolbar that spells all four out spends most of its width on labels nobody re-reads
 * after the first week, and the labels were pushing the run controls toward the edge on a
 * narrow window. `FilterIcon` is the fifth and the first one drawn outside the toolbar, in a
 * viewer caption at two thirds the size.
 *
 * **Every one keeps its name where it counts.** `title` gives the hover tooltip and `aria-label`
 * the accessible name, so a screen reader still hears "Connections" and the tests still find the
 * buttons by it. An icon-only control with neither is a control only its author can use.
 *
 * **Drawn here rather than pulled from an icon set.** Four glyphs is not a dependency, and the
 * ones a set would give are these shapes anyway — a box with an arrow leaving it, a branch, a
 * lens, a head. Hand-drawn also means they share a grid and a weight with each other rather than
 * being four samples of somebody else's system dropped into ours.
 *
 * The grid is the usual 24 units with a 2-unit stroke, which is what makes them legible at the
 * 15px the toolbar draws them at: at that size a 1.5-unit stroke greys out against
 * `--text-secondary` and a 2.5 turns the lens into a blob. Everything paints in `currentColor`,
 * so an icon takes the ink of the button it sits in and follows its hover and pressed states —
 * the same rule `CodaMark` follows, and for the same reason: an accent-coloured icon here would
 * be the same blue as a Table socket and read as a typed port rather than as chrome.
 */

/** What the toolbar draws them at. A caption asks for less; see `FilterIcon`. */
const ICON_PX = 15

function Icon({ children, size = ICON_PX }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/**
 * Share — a box with an arrow leaving it.
 *
 * The open corner is the whole glyph: a closed box with an arrow inside it reads as "expand",
 * and the two are next to each other in most toolbars. So the box is drawn as one path that
 * stops short of the top-right, and the arrow crosses where the corner would have been.
 */
export function ShareIcon() {
  return (
    <Icon>
      <path d="M18 12.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6.5" />
      <path d="M14 3h7v7" />
      <path d="M11.5 12.5 21 3" />
    </Icon>
  )
}

/**
 * Connections — a branch.
 *
 * Not a plug or a key, which are the other two obvious readings of "credentials": the panel is
 * about *where Coda talks to*, and a branch is the shape everybody already reads as one thing
 * splitting into another. The arc leaves the upper node tangentially and lands on the lower
 * one's edge, so the three parts read as joined rather than as a curve near two circles.
 */
export function ConnectionsIcon() {
  return (
    <Icon>
      <path d="M6 4.5v11" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M18 8.5a9.5 9.5 0 0 1-9.5 9.5" />
    </Icon>
  )
}

/**
 * Assistant — a robot head.
 *
 * The eyes are **filled dots, not circles**: at 15px a stroked 1.2-unit circle closes up into a
 * smudge, and two smudges on a rounded rectangle is not a face. The antenna and the side stubs
 * are what stop the outline reading as a plain rounded rectangle — which is what it did without
 * them, at which point it was a card icon rather than a robot.
 */
export function AssistantIcon() {
  return (
    <Icon>
      <rect x="4" y="8.5" width="16" height="11.5" rx="3" />
      <path d="M12 5.5v3" />
      <path d="M2 13v3M22 13v3" />
      <circle cx="12" cy="4" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="9.25" cy="14" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="14.75" cy="14" r="1.3" fill="currentColor" stroke="none" />
    </Icon>
  )
}

/** Inspector — a lens. The handle leaves the circle on the tangent, or it reads as a balloon. */
export function InspectorIcon() {
  return (
    <Icon>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.4 15.4 5.1 5.1" />
    </Icon>
  )
}

/**
 * Filter — three lines tapering to a point.
 *
 * Not a funnel, which is the more obvious reading and does not survive the size. This one is
 * drawn in a viewer caption at 11px, where the 2-unit stroke that keeps the lens legible at 15
 * closes a funnel's throat into a blob; three straight lines are the same weight at any size.
 * It cannot be confused with the sort control beside it either, since that is a `▴`/`▾` on the
 * column itself rather than a glyph in the caption.
 */
export function FilterIcon({ size }: { size?: number }) {
  return (
    <Icon {...(size ? { size } : {})}>
      <path d="M3 6h18" />
      <path d="M7 12h10" />
      <path d="M10.5 18h3" />
    </Icon>
  )
}
