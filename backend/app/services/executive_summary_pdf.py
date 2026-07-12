from fpdf import FPDF

# Same 5-provider labels used throughout the app (ArchitectureWorkspace.tsx's PROVIDER_LABELS) --
# duplicated here rather than imported since the frontend map isn't reachable from Python, and
# this is the only backend spot that needs a display label instead of the raw provider key.
PROVIDER_LABELS = {
    "aws": "AWS",
    "azure": "Azure",
    "gcp": "Google Cloud",
    "kubernetes": "Kubernetes",
    "private": "Private Cloud",
}

_INK = (18, 22, 31)
_MUTED = (100, 105, 120)
_BODY = (45, 48, 58)
_ACCENT = (91, 79, 232)


def build_executive_summary_pdf(project_name: str, provider: str, version: str, cost: dict, summary: dict) -> bytes:
    """Renders the Executive Summary Export (Workstream T2) as a single-page PDF -- no diagrams,
    no code, no component/service names, business language only. `summary` is the LLM-generated
    dict from generate_executive_summary (overview/scalabilityReadiness/compliancePosture/
    keyRisks); `cost` is calculate_total_cost's deterministic {"min","max"} output, never
    LLM-estimated, so the one number on this page a reader might scrutinize is always grounded in
    the same cost math the rest of the app uses."""
    pdf = FPDF(format="Letter", unit="mm")
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.add_page()
    pdf.set_margins(20, 18, 20)

    pdf.set_font("Helvetica", "B", 22)
    pdf.set_text_color(*_INK)
    # multi_cell defaults to leaving the cursor at the RIGHT edge of the cell just drawn (not the
    # left margin) -- without new_x/new_y here, the next line (a plain cell(), which doesn't
    # reset position on its own) would start drawing from the right margin and run off the page.
    pdf.multi_cell(0, 10, project_name, new_x="LMARGIN", new_y="NEXT")

    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(*_MUTED)
    pdf.cell(0, 6, f"Executive Summary  |  {PROVIDER_LABELS.get(provider, provider)}  |  Design v{version}", new_x="LMARGIN", new_y="NEXT")
    pdf.set_draw_color(*_ACCENT)
    pdf.set_line_width(0.6)
    y = pdf.get_y() + 3
    pdf.line(20, y, 191, y)
    pdf.ln(9)

    def section(title: str, body: str) -> None:
        pdf.set_font("Helvetica", "B", 12.5)
        pdf.set_text_color(*_INK)
        pdf.cell(0, 7, title, new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 10.5)
        pdf.set_text_color(*_BODY)
        pdf.multi_cell(0, 5.4, body)
        pdf.ln(4)

    section("Overview", summary.get("overview") or "")
    section(
        "Estimated Monthly Cost",
        f"${cost.get('min', 0):,.0f} - ${cost.get('max', 0):,.0f} per month, based on the design's current configuration.",
    )
    section("Scalability Readiness", summary.get("scalabilityReadiness") or "")
    section("Compliance Posture", summary.get("compliancePosture") or "")

    pdf.set_font("Helvetica", "B", 12.5)
    pdf.set_text_color(*_INK)
    pdf.cell(0, 7, "Key Risks", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10.5)
    pdf.set_text_color(*_BODY)
    for risk in summary.get("keyRisks") or []:
        pdf.set_x(20)
        pdf.multi_cell(0, 5.4, f"-  {risk}")
        pdf.ln(1)

    output = pdf.output()
    return bytes(output)
