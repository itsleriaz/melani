// SPDX-License-Identifier: GPL-3.0-only
// Stroke icons drawn on a 24px grid. They inherit the text colour.

const PATHS = {
  binder: (
    <>
      <path className="i-spine" d="M4 5h6M4 5v14" />
      <path className="i-row i-d1" d="M14 5h6" />
      <path className="i-row i-d2" d="M8 12h12" />
      <path className="i-row i-d3" d="M8 19h12" />
    </>
  ),
  codex: (
    <>
      <path className="i-cover" d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z" />
      <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19" />
      <path className="i-line" pathLength="1" d="M9 7h6" />
    </>
  ),
  search: (
    <>
      <circle className="i-lens" cx="11" cy="11" r="7" />
      <path className="i-handle" d="m20 20-3.5-3.5" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle className="i-knob i-k1" cx="15" cy="6" r="2" />
      <circle className="i-knob i-k2" cx="9" cy="12" r="2" />
      <circle className="i-knob i-k3" cx="17" cy="18" r="2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  comment: <path d="M5 5h14v10H9l-4 4z" />,
  sparkle: <path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z" />,
  findings: <path d="M4 7l2 2 3-3M4 15l2 2 3-3M12 8h8M12 16h8" />,
  focus: <path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3" />,
  typewriter: <path d="M5 8h14M7 12h10M5 16h14" />,
  sidebarLeft: (
    <>
      <rect className="i-panel i-left" x="3.8" y="4.8" width="4.6" height="14.4" rx="1" fill="currentColor" fillOpacity="0.28" stroke="none" />
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  sidebarRight: (
    <>
      <rect className="i-panel i-right" x="15.6" y="4.8" width="4.6" height="14.4" rx="1" fill="currentColor" fillOpacity="0.28" stroke="none" />
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  chevronRight: <path d="m9 6 6 6-6 6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronUp: <path d="m6 15 6-6 6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m5 12 5 5 9-10" />,
  pen: <path d="M4 20h4L19 9l-4-4L4 16z" />,
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="13" y="4" width="7" height="7" rx="1" />
      <rect x="4" y="13" width="7" height="7" rx="1" />
      <rect x="13" y="13" width="7" height="7" rx="1" />
    </>
  ),
  scene: (
    <>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4" />
    </>
  ),
  note: (
    <>
      <path d="M5 4h14v12l-4 4H5z" />
      <path d="M15 20v-4h4" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  part: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 3v18" />
    </>
  ),
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  restore: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </>
  ),
  pin: <path d="M12 17v4M8 3h8l-1 6 3 4H6l3-4z" />,
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.7L20 8" />
      <path d="M20 3v5h-5" />
    </>
  ),
  replace: <path d="M4 7h11l-3-3M20 17H9l3 3" />,
  filter: <path d="M4 6h16M7 12h10M10 18h4" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  target: (
    <>
      <circle className="i-ring i-r1" cx="12" cy="12" r="9" />
      <circle className="i-ring i-r2" cx="12" cy="12" r="5" />
      <circle className="i-ring i-r3" cx="12" cy="12" r="1" />
    </>
  ),
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  book: (
    <>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z" />
      <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19" />
      <path d="M9 8h6M9 11h4" />
    </>
  ),
  bold: <path d="M7 4h6a3.5 3.5 0 0 1 0 7H7zM7 11h7a3.5 3.5 0 0 1 0 7H7z" />,
  italic: <path d="M10 4h8M6 20h8M15 4 9 20" />,
  strike: <path d="M4 12h16M16.5 7.5C16 5.5 14.3 4.5 12 4.5c-2.5 0-4.2 1.2-4.2 3 0 1.4 1 2.3 2.7 2.8M7.5 16.5c.5 2 2.2 3 4.5 3 2.6 0 4.2-1.2 4.2-3 0-1-.4-1.7-1.2-2.2" />,
  h1: <path d="M4 5v14M4 12h8M12 5v14M17 9l3-2v12" />,
  h2: <path d="M4 5v14M4 12h8M12 5v14M16 9.5a2.2 2.2 0 1 1 3.8 1.5L16 15.5V17h5" />,
  quote: <path d="M5 6h5v6H5zM14 6h5v6h-5zM5 12c0 3 1 4.5 3 5M14 12c0 3 1 4.5 3 5" />,
  listBullet: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  listOrdered: <path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1v4M4 14.5a1.5 1.5 0 1 1 2.5 1L4 18.5h3" />,
  rule: <path d="M4 12h16M8 6.5h.01M12 6.5h.01M16 6.5h.01M8 17.5h.01M12 17.5h.01M16 17.5h.01" />,
  undo: (
    <>
      <path className="i-head i-back-head" d="M9 14 4 9l5-5" />
      <path className="i-tail" d="M4 9h9a6 6 0 0 1 0 12h-2" />
    </>
  ),
  redo: (
    <>
      <path className="i-head i-fwd-head" d="m15 14 5-5-5-5" />
      <path className="i-tail" d="M20 9h-9a6 6 0 0 0 0 12h2" />
    </>
  ),
  home: (
    <>
      <path className="i-roof" d="M4 11 12 4l8 7" />
      <path d="M6 10v10h4v-5h4v5h4V10" />
    </>
  ),
  codexAdd: (
    <>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v8M5 19.5A1.5 1.5 0 0 0 6.5 21H13M5 4.5v15" />
      <path d="M18 14v6M15 17h6" />
    </>
  ),
  commentAdd: (
    <>
      <path d="M5 5h14v10H9l-4 4z" />
      <path d="M12 8v4M10 10h4" />
    </>
  ),
  footnote: <path d="M3 19l8-10M11 19L3 9M16 8l2-2v7" />,
  sceneSolid: (
    <>
      <path d="M7 3h7l5 5v11.5A1.5 1.5 0 0 1 17.5 21h-10A1.5 1.5 0 0 1 6 19.5v-15A1.5 1.5 0 0 1 7.5 3z" fill="currentColor" stroke="none" />
      <path d="M14 3v4.5A1.5 1.5 0 0 0 15.5 9H19" fill="var(--paper)" fillOpacity="0.55" stroke="none" />
      <path d="M9.5 13h6M9.5 16.5h4" stroke="var(--paper)" strokeOpacity="0.8" />
    </>
  ),
  export: (
    <>
      <path className="i-arrow-up" d="M12 15V4M8 8l4-4 4 4" />
      <path d="M5 14v5h14v-5" />
    </>
  ),
  zoomPlus: <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M8.5 11h5M11 8.5v5" />,
  collapseAll: (
    <>
      <path className="i-chev i-top" d="M7 8l5 4 5-4" />
      <path className="i-chev i-bottom" d="M7 16l5-4 5 4" />
    </>
  ),
  expandAll: (
    <>
      <path className="i-chev i-top" d="M7 4l5 4 5-4" />
      <path className="i-chev i-bottom" d="M7 20l5-4 5 4" />
    </>
  ),
  import: (
    <>
      <path className="i-arrow-down" d="M12 4v11M8 11l4 4 4-4" />
      <path d="M5 19h14" />
    </>
  ),
  highlight: <path d="M15 4l5 5-9 9H7l-3-3v-1zM4 21h16" />,
  collection: (
    <>
      <rect className="i-front" x="3" y="8" width="14" height="11" rx="2" />
      <path className="i-back" d="M7 5h12a2 2 0 0 1 2 2v9" />
    </>
  ),
  outline: (
    <>
      <path className="i-draw i-d1" pathLength="1" d="M4 6h16" />
      <path className="i-draw i-d2" pathLength="1" d="M4 12h16" />
      <path className="i-draw i-d3" pathLength="1" d="M4 18h16" />
      <path className="i-draw i-d4" pathLength="1" d="M9 4v16" />
      <path className="i-draw i-d5" pathLength="1" d="M15 4v16" />
    </>
  ),
  sortUp: <path d="m7 14 5-5 5 5" />,
  sortDown: <path d="m7 10 5 5 5-5" />,
  columns: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M10 4v16M15 4v16" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      key={name}
      data-icon={name}
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </svg>
  );
}

/** A small progress ring, 0..1. */
export function Ring({ value, size = 22 }: { value: number; size?: number }) {
  const c = 2 * Math.PI * 14;
  const v = Math.max(0, Math.min(1, value));
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 36 36" className="ring">
      <circle cx="18" cy="18" r="14" fill="none" strokeWidth="4" className="ring-track" />
      <circle cx="18" cy="18" r="14" fill="none" strokeWidth="4" strokeLinecap="round" strokeDasharray={`${v * c} ${c}`} transform="rotate(-90 18 18)" className="ring-fill" />
    </svg>
  );
}
