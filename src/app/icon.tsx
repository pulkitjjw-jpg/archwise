import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

// Next's native icon-file convention -- generates /icon at build/request time, no static
// favicon.ico needed. Same arch mark as components/LogoMark.tsx (see that file's comment on why
// it's a literal arch, not the node-diagram glyph tried first) -- built from plain divs
// (border-radius, no raw SVG path) since that's the subset next/og's Satori renderer reliably
// supports.
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: "#5B4FE8",
          borderRadius: 9,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 10,
            top: 8,
            width: 12,
            height: 17,
            borderTopLeftRadius: 6,
            borderTopRightRadius: 6,
            background: "#F6F7FB",
          }}
        />
      </div>
    ),
    { ...size }
  );
}
