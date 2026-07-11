// Client-side export of the topology diagram as a standalone image file -- deliberately separate
// from the Terraform/K8s export (Workstream D explicitly wants "the picture" and "the deployable
// code" kept as clearly different actions, not merged into one dropdown). No backend involved.

// The live diagram's appearance comes entirely from Tailwind utility classes (via the app's own
// stylesheet). A cloned SVG serialized on its own has no access to that stylesheet -- opened
// standalone, every className resolves to nothing. The fix for the SVG-file export below is to
// walk the live (attached) tree and copy each element's *computed* style onto the matching clone
// as an inline `style` attribute, so the export is fully self-contained.
const STYLE_PROPS = [
  "fill",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-opacity",
  "fill-opacity",
  "color",
  "background-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "box-shadow",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-transform",
  "text-align",
  "display",
  "flex-direction",
  "align-items",
  "justify-content",
  "gap",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "width",
  "height",
  "min-width",
  "max-width",
  "opacity",
  "overflow",
  "white-space",
  "text-overflow",
  "flex",
  "flex-shrink",
  "flex-grow",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "transform",
];

function inlineComputedStyles(original: Element, clone: Element) {
  const computed = window.getComputedStyle(original);
  const cssText = STYLE_PROPS.map((prop) => `${prop}:${computed.getPropertyValue(prop)}`).join(";");
  clone.setAttribute("style", cssText);

  const origChildren = original.children;
  const cloneChildren = clone.children;
  for (let i = 0; i < origChildren.length; i++) {
    if (cloneChildren[i]) inlineComputedStyles(origChildren[i], cloneChildren[i]);
  }
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function exportDiagramAsSvg(svgEl: SVGSVGElement, filenameBase: string) {
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  inlineComputedStyles(svgEl, clone);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  clone.querySelectorAll("foreignObject > div").forEach((el) => {
    el.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  });

  const bgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bgRect.setAttribute("x", "0");
  bgRect.setAttribute("y", "0");
  bgRect.setAttribute("width", "100%");
  bgRect.setAttribute("height", "100%");
  bgRect.setAttribute("fill", "#F6F7FB");
  clone.insertBefore(bgRect, clone.firstChild);

  const serialized = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`], {
    type: "image/svg+xml;charset=utf-8",
  });
  triggerDownload(blob, `${filenameBase}.svg`);
}

// --- PNG export -----------------------------------------------------------------------------
// Browsers treat ANY <svg> containing a <foreignObject> as tainting a <canvas> it's drawn into
// (a security measure against foreignObject smuggling external content), regardless of whether
// the content is same-origin -- canvas.toBlob()/toDataURL() throws unconditionally in that case.
// The live diagram's node cards are HTML rendered via foreignObject, so that path is a dead end
// for PNG export. Instead, PNG export builds its own plain-SVG twin (rect/text/path only, no
// HTML, no per-service icons -- a small, deliberate fidelity trade-off) from the same node/edge
// data the interactive diagram already computed, which rasterizes via canvas without issue.

export interface PngExportNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  serviceName: string;
  isCompliance: boolean;
  isOverride: boolean;
  accentHex: string;
}

export interface PngExportEdge {
  d: string;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function buildPlainDiagramSvg(
  nodes: PngExportNode[],
  edges: PngExportEdge[],
  width: number,
  height: number
): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`
  );
  parts.push(`<rect x="0" y="0" width="100%" height="100%" fill="#FFFFFF"/>`);
  parts.push(
    `<defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#5B4FE8"/></marker></defs>`
  );

  for (const edge of edges) {
    parts.push(`<path d="${edge.d}" fill="none" stroke="#5B4FE8" stroke-opacity="0.45" stroke-width="1.5" marker-end="url(#flow-arrow)"/>`);
  }

  for (const node of nodes) {
    const x = node.x - node.width / 2;
    const y = node.y - node.height / 2;
    const borderColor = node.isCompliance ? "#9A5B0A" : "#CBD1DC";
    const dash = node.isOverride ? ` stroke-dasharray="4 3"` : "";
    parts.push(
      `<rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="14" fill="#FFFFFF" stroke="${borderColor}" stroke-width="1.5"${dash}/>`
    );
    parts.push(
      `<circle cx="${x + 22}" cy="${y + node.height / 2}" r="10" fill="${node.accentHex}" fill-opacity="0.15"/>`
    );
    parts.push(
      `<text x="${x + 42}" y="${y + node.height / 2 - 6}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="9" font-weight="700" letter-spacing="0.5" fill="#8891A0">${escapeXml(
        truncate(node.label.toUpperCase(), 24)
      )}</text>`
    );
    parts.push(
      `<text x="${x + 42}" y="${y + node.height / 2 + 12}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" font-weight="700" fill="#12161F">${escapeXml(
        truncate(node.serviceName, 22)
      )}</text>`
    );
  }

  parts.push("</svg>");
  return parts.join("");
}

export function exportDiagramAsPng(
  nodes: PngExportNode[],
  edges: PngExportEdge[],
  width: number,
  height: number,
  filenameBase: string,
  scale = 2
): Promise<void> {
  const svgString = buildPlainDiagramSvg(nodes, edges, width, height);
  const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(svgUrl);
      reject(new Error("Timed out rendering the diagram to an image."));
    }, 15000);

    const img = new Image();
    img.onload = () => {
      if (settled) return;
      const canvas = document.createElement("canvas");
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        settled = true;
        clearTimeout(timeout);
        URL.revokeObjectURL(svgUrl);
        reject(new Error("Canvas not supported"));
        return;
      }
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(svgUrl);
      canvas.toBlob((blob) => {
        settled = true;
        clearTimeout(timeout);
        if (!blob) {
          reject(new Error("Failed to render PNG"));
          return;
        }
        triggerDownload(blob, `${filenameBase}.png`);
        resolve();
      }, "image/png");
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      URL.revokeObjectURL(svgUrl);
      reject(new Error("Failed to load diagram for PNG export"));
    };
    img.src = svgUrl;
  });
}
