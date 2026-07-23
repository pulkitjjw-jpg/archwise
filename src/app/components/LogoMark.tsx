// The app's icon mark -- a literal rounded arch (flat base, semicircular top), the most direct
// unambiguous visual for "Arch-wise". An earlier version used 3 connected nodes as a network/
// system-diagram glyph, but at nav/favicon sizes it reliably pattern-matched as a head-and-
// shoulders "user profile" icon instead (face pareidolia) -- confirmed via a live screenshot, not
// just guessed. A single solid arch shape has no such ambiguity. Colors are hardcoded (not CSS
// vars) so the mark renders identically here and in app/icon.tsx (favicon), which is a static
// ImageResponse with no access to globals.css custom properties.
export function LogoMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="9" fill="#5B4FE8" />
      <path d="M10 25 L10 19 A6 6 0 0 1 22 19 L22 25 Z" fill="#F6F7FB" />
    </svg>
  );
}
