#!/usr/bin/env python3
"""
Builds The Acquisition Checklist PDF for REIL Acquisitions.

Design decisions (fixing the previous build):
  * Light interior pages with dark text -> readable AND printable.
  * Navy cover only, as a brand statement.
  * Table rows alternate light tints; text is always dark on light.
  * No element overlaps the heading band.
  * Fonts are EMBEDDED so the PDF renders identically everywhere.
  * The official REIL mountain mark replaces the old placeholder "R".

Run:  python3 build_checklist.py /path/to/out.pdf
"""

import sys
import fitz  # PyMuPDF, for embedding the PNG logo

from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, PageTemplate, Paragraph,
                                Spacer, Table, TableStyle, KeepTogether)

# ---------------------------------------------------------------- palette
NAVY      = HexColor("#0A1428")
NAVY_SOFT = HexColor("#1A3A52")
GOLD      = HexColor("#C9A961")
GOLD_DARK = HexColor("#8A5E24")   # darkened from #A67C52 -> 4.8:1 on white (WCAG AA)
TEAL      = HexColor("#0D7377")
INK       = HexColor("#1F2933")   # body text on light
INK_SOFT  = HexColor("#55606D")   # secondary text
RULE      = HexColor("#E2DED6")
TINT      = HexColor("#F7F6F3")   # table row tint
WHITE     = HexColor("#FFFFFF")
PAPER     = HexColor("#FFFFFF")

PAGE_W, PAGE_H = LETTER
MARGIN = 0.85 * inch
CONTENT_W = PAGE_W - 2 * MARGIN

# ---------------------------------------------------------------- fonts (EMBEDDED)
# Base-14 Helvetica is not embedded, which makes the PDF fragile in some mobile
# viewers. Arial is metric-compatible with Helvetica, visually near-identical, and
# ships as embeddable TTFs on macOS. Fall back to Helvetica if they are missing.
from reportlab.pdfbase import pdfmetrics as _pm
from reportlab.pdfbase.ttfonts import TTFont as _TTF
import os as _os

_SYS = "/System/Library/Fonts/Supplemental"
_EMBED = {
    "Helvetica":           (_SYS + "/Arial.ttf",              "Helvetica"),
    "Helvetica-Bold":      (_SYS + "/Arial Bold.ttf",         "Helvetica-Bold"),
    "Helvetica-Oblique":   (_SYS + "/Arial Italic.ttf",       "Helvetica-Oblique"),
    "Helvetica-BoldOblique": (_SYS + "/Arial Bold Italic.ttf", "Helvetica-BoldOblique"),
}
_embedded_ok = True
for _name, (_path, _ps) in _EMBED.items():
    try:
        _pm.registerFont(_TTF(_name, _path, asciiReadable=True))
    except Exception as _e:
        _embedded_ok = False
        print("font embed failed for", _name, _e, file=sys.stderr)

FONT, FONT_B, FONT_I, FONT_BI = "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"
if not _embedded_ok:
    print("NOTE: falling back to base-14 Helvetica (not embedded)", file=sys.stderr)

# ---------------------------------------------------------------- styles
def S(name, **kw):
    base = dict(fontName=FONT, fontSize=10.3, leading=14.6, textColor=INK,
                alignment=TA_LEFT, spaceAfter=0, spaceBefore=0)
    base.update(kw)
    return ParagraphStyle(name, **base)

st_body    = S("body")
st_body_b  = S("bodyb", fontName=FONT_B)
st_h2      = S("h2", fontName=FONT_B, fontSize=18, leading=22, textColor=NAVY, spaceAfter=9)
st_eyebrow = S("eyebrow", fontName=FONT_B, fontSize=8.8, leading=11, textColor=GOLD_DARK, spaceAfter=3)
st_sub     = S("sub", fontName=FONT_B, fontSize=12.6, leading=16, textColor=NAVY, spaceBefore=13, spaceAfter=5)
st_lead    = S("lead", fontSize=11, leading=16.2, textColor=INK)
st_note    = S("note", fontName=FONT_I, fontSize=9.4, leading=13.4, textColor=GOLD_DARK)
st_th      = S("th", fontName=FONT_B, fontSize=8.6, leading=11, textColor=WHITE)
st_td      = S("td", fontSize=9.2, leading=12.4, textColor=INK)
st_td_b    = S("tdb", fontName=FONT_B, fontSize=9.2, leading=12.4, textColor=NAVY)
st_callout = S("callout", fontName=FONT_B, fontSize=10.1, leading=14.4, textColor=NAVY)
st_footnote= S("foot", fontSize=8.4, leading=11.6, textColor=INK_SOFT)

# cover styles
st_cv_eyebrow = S("cveyebrow", fontName=FONT_B, fontSize=10, leading=13, textColor=GOLD)
st_cv_title   = S("cvtitle", fontName=FONT_B, fontSize=34, leading=39, textColor=WHITE)
st_cv_sub     = S("cvsub", fontSize=13, leading=19, textColor=HexColor("#C9CFD8"))
st_cv_small   = S("cvsmall", fontName=FONT_B, fontSize=8.6, leading=12, textColor=GOLD)


def header_footer(canvas, doc):
    """Interior header rule + footer. Never overlaps body content."""
    canvas.saveState()
    pn = canvas.getPageNumber()
    if pn > 1:
        # thin brand rule at the top
        canvas.setFillColor(GOLD)
        canvas.rect(MARGIN, PAGE_H - 0.52 * inch, 34, 2.2, stroke=0, fill=1)

        # footer
        canvas.setFillColor(RULE)
        canvas.rect(MARGIN, 0.68 * inch, CONTENT_W, 0.7, stroke=0, fill=1)
        canvas.setFillColor(INK_SOFT)
        canvas.setFont(FONT, 8.2)
        canvas.drawString(MARGIN, 0.5 * inch,
                          "\u00a9 2026 REIL Acquisitions  \u00b7  reilacquisitions.com")
        canvas.setFont(FONT_B, 8.2)
        canvas.setFillColor(GOLD_DARK)
        canvas.drawRightString(PAGE_W - MARGIN, 0.5 * inch, str(pn))
    canvas.restoreState()


def section(num, title, lead=None):
    out = [Paragraph(num.upper(), st_eyebrow), Paragraph(title, st_h2)]
    if lead:
        out += [Paragraph(lead, st_lead), Spacer(1, 9)]
    return out


def bullets(items):
    """Bold lead-in + explanation, as a clean two-part paragraph."""
    rows = []
    for lead, rest in items:
        rows.append(Paragraph(f"<b>{lead}</b> \u2014 {rest}", st_body))
        rows.append(Spacer(1, 6.5))
    return rows[:-1] if rows else rows


def datatable(header, rows, widths, bold_first_col=True):
    data = [[Paragraph(h, st_th) for h in header]]
    for r in rows:
        data.append([Paragraph(c, st_td_b if (i == 0 and bold_first_col) else st_td)
                     for i, c in enumerate(r)])
    t = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("LINEBELOW", (0, 0), (-1, -1), 0.5, RULE),
        ("BOX", (0, 0), (-1, -1), 0.5, RULE),
    ]
    for i in range(1, len(data)):
        if i % 2 == 0:
            style.append(("BACKGROUND", (0, i), (-1, i), TINT))
    t.setStyle(TableStyle(style))
    return t


def callout(text):
    """Gold-bar callout: light tint, dark text. Never same-colour-as-bg."""
    p = Paragraph(text, st_callout)
    t = Table([[p]], colWidths=[CONTENT_W], hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), HexColor("#FBF7EF")),
        ("LINEBEFORE", (0, 0), (0, 0), 3, GOLD),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ]))
    return t


def sparkle_items(items):
    out = []
    for t in items:
        out.append(Paragraph(f'<font color="#8A5E24">&#9670;</font>&nbsp;&nbsp;{t}', st_body))
        out.append(Spacer(1, 4.5))
    return out[:-1]


# ---------------------------------------------------------------- cover
def cover(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(NAVY)
    canvas.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)

    # decorative arc, kept well clear of the title block
    canvas.setFillColor(NAVY_SOFT)
    canvas.circle(PAGE_W + 90, PAGE_H - 40, 210, stroke=0, fill=1)

    # official logo mark (gold on navy) - top left
    try:
        pic = fitz.Pixmap(LOGO_PNG)
        if pic.alpha:
            pic = fitz.Pixmap(pic, 0)
        tmp = LOGO_TMP
        pic.save(tmp)
        w = 1.62 * inch
        h = w * pic.height / pic.width
        canvas.drawImage(tmp, MARGIN, PAGE_H - 1.05 * inch, width=w, height=h, mask="auto")
    except Exception as exc:      # never let the logo break the build
        print("logo skipped:", exc, file=sys.stderr)

    # gold rule
    canvas.setFillColor(GOLD)
    canvas.rect(MARGIN, PAGE_H - 1.28 * inch, 62, 2.6, stroke=0, fill=1)

    canvas.restoreState()


def build(path):
    doc = BaseDocTemplate(path, pagesize=LETTER,
                          leftMargin=MARGIN, rightMargin=MARGIN,
                          topMargin=MARGIN, bottomMargin=MARGIN,
                          title="The Acquisition Checklist | REIL Acquisitions",
                          author="REIL Acquisitions",
                          subject="How to structure your first $5M-$100M business purchase")

    cover_frame = Frame(MARGIN, MARGIN, CONTENT_W, PAGE_H - 2 * MARGIN, id="cover",
                        leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    body_frame = Frame(MARGIN, MARGIN, CONTENT_W, PAGE_H - 2 * MARGIN, id="body",
                       leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)

    doc.addPageTemplates([
        PageTemplate(id="Cover", frames=[cover_frame], onPage=cover),
        PageTemplate(id="Body", frames=[body_frame], onPage=header_footer),
    ])

    F = []           # flowables
    from reportlab.platypus import NextPageTemplate, PageBreak

    # ------------------------------------------------ COVER
    F.append(Spacer(1, 1.55 * inch))
    F.append(Paragraph("FREE GUIDE FOR BUYERS", st_cv_eyebrow))
    F.append(Spacer(1, 10))
    F.append(Paragraph("The Acquisition<br/>Checklist", st_cv_title))
    F.append(Spacer(1, 16))
    F.append(Paragraph("How to structure your first $5M\u2013$100M business purchase<br/>"
                       "\u2014 and the deal-breakers that end most of them.", st_cv_sub))
    F.append(Spacer(1, 1.15 * inch))
    F.append(Paragraph("PREPARED BY REIL ACQUISITIONS", st_cv_small))
    F.append(Spacer(1, 7))
    F.append(Paragraph("Two-sided M&amp;A representation for the Midwest mid-market.<br/>"
                       "Built by operators who have bought, run and sold their own companies.",
                       st_cv_sub))
    F.append(NextPageTemplate("Body"))
    F.append(PageBreak())

    # ------------------------------------------------ PAGE 2 — how to use
    F += section("How to use this", "Start here",
                 "There are two ways to lose money in an acquisition. The first is paying too much. "
                 "The second \u2014 far more common, and far more expensive \u2014 is buying the wrong "
                 "business. This checklist attacks both.")
    F.append(Paragraph("<b>Work through it in order.</b> The first four sections are preparation you "
                       "complete <b>before</b> you make an offer. The last two are what you run "
                       "<b>after</b> your offer is accepted, when every day of diligence costs money.", st_body))
    F.append(Spacer(1, 13))
    F.append(datatable(
        ["PHASE", "WHAT IT DECIDES"],
        [["1. Pre-Acquisition Readiness", "Whether you are actually able to close a deal right now"],
         ["2. Deal Evaluation", "Whether this specific business is worth a second look"],
         ["3. Valuation Math", "What the business is worth to you \u2014 not what is being asked"],
         ["4. Financing &amp; Structure", "How the deal gets funded and how risk gets split"],
         ["5. The 7 Deal Breakers", "The red flags that should stop the process entirely"],
         ["6. Diligence &amp; Close", "What to verify before you wire a dollar"]],
        [2.15 * inch, CONTENT_W - 2.15 * inch]))
    F.append(Spacer(1, 13))
    F.append(callout("A word of warning: deal-breakers are not negotiating points. Section 5 exists "
                     "because most buyers see a red flag, decide it is manageable, and find out "
                     "eighteen months later that it was not."))

    # ------------------------------------------------ SECTION 1
    F.append(PageBreak())
    F += section("Section 1", "Pre-Acquisition Readiness",
                 "You are ready to buy when a deal can close without panic. Run this list honestly "
                 "\u2014 every item is something a seller or their broker will test you on.")
    F.append(Paragraph("Capital", st_sub))
    F += bullets([
        ("Equity in hand", "10\u201330% of purchase price in liquid capital, not home equity or "
                           "retirement money you cannot access."),
        ("Working capital reserve", "Six to twelve months of the target\u2019s operating expenses on "
                                    "top of the purchase price. Deals die here."),
        ("Deal costs budgeted", "Diligence, legal, accounting and QofE typically run 3\u20136% of "
                                "enterprise value. Budget it before you shop."),
    ])
    F.append(Paragraph("Lender readiness", st_sub))
    F += bullets([
        ("Pre-qualification letter", "A written indication from a lender you have actually spoken "
                                     "with beats a generic bank relationship every time."),
        ("SBA 7(a) eligibility understood", "Most acquisitions of operating businesses qualify. "
                                            "Understand the personal guarantee and the 10-year "
                                            "amortization before you assume it fits."),
        ("A lender who does your industry", "Cash-flow lending on a services business and an "
                                            "asset-based loan on a manufacturer are different animals."),
    ])
    F.append(Paragraph("You, personally", st_sub))
    F += bullets([
        ("Time to run diligence", "60\u2013120 days of part-time attention is not enough. Be "
                                  "realistic about who does this work."),
        ("Advisors lined up", "An M&amp;A attorney and a CPA who have closed acquisitions \u2014 "
                              "not just any attorney and CPA."),
        ("A clear thesis", "One sentence on why this business, this industry, this geography. If "
                           "you cannot write the sentence, you are not ready."),
        ("Exit thinking", "How you eventually get paid back. Buying without this is how buyers "
                          "become owners forever."),
    ])
    F.append(Spacer(1, 8))
    F.append(callout("The readiness test: if your lender, your attorney and your spouse all knew the "
                     "full plan today, would the deal still close? If not, fix that first."))

    # ------------------------------------------------ SECTION 2
    F.append(PageBreak())
    F += section("Section 2", "Deal Evaluation Framework",
                 "Most listings are screened out in twenty minutes. Use this order \u2014 cheapest "
                 "filter first.")
    F.append(Paragraph("Revenue quality", st_sub))
    F += bullets([
        ("Revenue durability", "Recurring, contractual or repeat revenue beats one-off project "
                               "revenue. A three-year customer history is the minimum."),
        ("Customer concentration", "No single customer above 15\u201320% of revenue; top five "
                                   "combined under 40%. Above that, you are buying a customer "
                                   "relationship, not a company."),
        ("Revenue trend", "Three to five years, not one. Declining revenue with \u201cone bad "
                          "year\u201d is declining revenue."),
        ("Gross margin", "Compare to industry norms. Below-average margin usually means pricing "
                         "power you cannot fix quickly."),
    ])
    F.append(Paragraph("Earnings quality", st_sub))
    F += bullets([
        ("SDE vs EBITDA", "For owner-operated businesses under roughly $5M earnings, SDE. Above "
                          "that, EBITDA. Using the wrong one overpays by the owner\u2019s compensation."),
        ("Add-backs verified", "Every add-back must be a genuine, documented, non-recurring "
                               "expense. Personal vehicles, family payroll and \u201crun-rate\u201d "
                               "adjustments are where projections get invented."),
        ("Cash conversion", "Profitable on paper but always short of cash is a working-capital "
                            "problem you are about to inherit."),
    ])
    F.append(Paragraph("Operational dependency", st_sub))
    F += bullets([
        ("Owner dependency", "Would revenue survive a 90-day absence by the owner? If not, price "
                             "the replacement into the deal."),
        ("Key employees", "Are the two or three people who actually run the business staying? Get "
                          "that in writing before LOI."),
        ("Systems and records", "Clean books, documented process, real software. Chaos is a cost, "
                                "and it is yours."),
    ])
    F.append(Spacer(1, 8))
    F.append(callout("Screen-out rule: if two or more of the items above are weak, stop evaluating "
                     "and move on. There is no price at which a bad business becomes a good one."))

    # ------------------------------------------------ SECTION 3
    F.append(PageBreak())
    F += section("Section 3", "Valuation Math, Step by Step",
                 "Valuation is arithmetic wrapped in judgment. Do the arithmetic first \u2014 it is "
                 "not negotiable \u2014 then apply judgment about risk.")
    F += bullets([
        ("Step 1 \u2014 Normalize earnings", "Start with net income. Add back owner compensation "
         "above market rate, personal expenses run through the business, one-time legal or moving "
         "costs, and non-cash items. Subtract anything the business needs but the owner stopped "
         "spending on (deferred maintenance, underfunded marketing). The result is your true "
         "earnings number."),
        ("Step 2 \u2014 Apply the right multiple", "Multiples are a proxy for risk: recurring "
         "revenue, transferable operations and clean books earn more. Owner dependency, "
         "concentration and volatility earn less."),
        ("Step 3 \u2014 Adjust for what you must fix", "Every item on the diligence list that "
         "requires capital, time or new people reduces your number. This is where disciplined "
         "buyers separate from hopeful ones."),
    ])
    F.append(Spacer(1, 11))
    F.append(datatable(
        ["BUSINESS PROFILE", "TYPICAL SDE / EBITDA MULTIPLE"],
        [["Owner-dependent services, high concentration", "2.0x \u2013 3.0x"],
         ["Established services with management in place", "3.0x \u2013 4.5x"],
         ["Niche manufacturing, repeat customers", "4.0x \u2013 6.0x"],
         ["Distribution / logistics with contracts", "4.5x \u2013 6.5x"],
         ["B2B recurring revenue, low churn", "5.0x \u2013 8.0x"],
         ["Healthcare, dental, veterinary practice", "4.0x \u2013 7.0x"]],
        [CONTENT_W - 1.95 * inch, 1.95 * inch]))
    F.append(Spacer(1, 10))
    F.append(Paragraph("Reality check: ranges are market observation, not appraisal. Enterprise "
                       "value moves with deal structure \u2014 seller financing, earnouts and "
                       "contingent payments all transfer risk, and risk transfer is what a multiple "
                       "really prices.", st_note))
    F.append(Spacer(1, 13))
    F.append(Paragraph("The valuation mistakes buyers repeat", st_sub))
    F += sparkle_items([
        "Paying a multiple on <b>projected</b> earnings instead of historical, verified earnings.",
        "Accepting the broker\u2019s SDE without recomputing it from tax returns and bank statements.",
        "Forgetting that the owner\u2019s salary must be replaced \u2014 a $250K add-back is a "
        "real $250K cost.",
        "Ignoring capex: a business that needs $400K of new equipment is worth $400K less.",
        "Falling in love with the business before running the numbers.",
    ])

    # ------------------------------------------------ SECTION 4
    F.append(PageBreak())
    F += section("Section 4", "Financing &amp; Structure",
                 "How a deal is structured matters more than the headline price. Two offers at $5M "
                 "are not the same offer.")
    F.append(datatable(
        ["SOURCE", "TYPICAL SHARE", "WHAT IT USUALLY COSTS"],
        [["Buyer equity", "10\u201330%", "Your cash, at risk first"],
         ["Senior debt / SBA 7(a)", "50\u201370%", "Personal guarantee, fixed amortization"],
         ["Seller note", "10\u201325%", "Stands behind the bank, signals seller confidence"],
         ["Earnout", "0\u201320%", "Paid only on performance you must be able to measure"]],
        [1.62 * inch, 1.02 * inch, CONTENT_W - 2.64 * inch]))
    F.append(Spacer(1, 13))
    F.append(Paragraph("Structure decisions that protect you", st_sub))
    F += bullets([
        ("Seller financing", "The single strongest signal of seller confidence. A seller who "
                             "refuses any note is telling you something."),
        ("Earnout mechanics", "If you use an earnout, define the accounting rules for it before "
                              "signing. Disputes are common and expensive."),
        ("Working capital peg", "Set a target and a mechanism. Without a peg, the seller collects "
                                "receivables on the way out and you fund the gap."),
        ("Asset vs stock purchase", "Asset purchases usually protect the buyer from historical "
                                    "liabilities. Ask your attorney which applies here."),
        ("Reps and warranties", "The seller\u2019s promises are only worth the escrow or holdback "
                                "behind them."),
        ("Non-compete and transition period", "Price the owner\u2019s 6\u201312 month handover "
                                              "into the deal. Without it, you bought a phone book."),
    ])
    F.append(Spacer(1, 8))
    F.append(callout("SBA note: 7(a) loans are the most common path for acquisitions under roughly "
                     "$5M. Expect full personal guarantee, collateral on personal assets, and a "
                     "requirement that the seller carry a note in many cases. Plan for it rather "
                     "than discovering it at closing."))

    # ------------------------------------------------ SECTION 5
    F.append(PageBreak())
    F += section("Section 5", "The 7 Deal Breakers",
                 "This is the most important page in this document. Any single one of these "
                 "justified pausing or walking \u2014 not discounting.")
    BREAKERS = [
        ("1. Customer concentration you cannot diversify quickly",
         "One customer above 25% of revenue, or the top three above 60%. If that customer leaves, "
         "the business you financed is gone while the debt is not."),
        ("2. Owner dependency that will not transfer",
         "The owner holds the relationships, the technical knowledge, or the licenses. If the "
         "seller will not sign a meaningful transition and non-compete, you are buying a job with "
         "extra steps."),
        ("3. Earnings that do not survive the bank statement",
         "Tax returns and bank deposits that do not support the SDE or EBITDA being marketed. "
         "Reconcile every add-back to source documents or walk."),
        ("4. Undisclosed or unliquidated liabilities",
         "Back taxes, payroll exposure, pending litigation, warranty or environmental obligations, "
         "unfunded pension liability. Verify by exception, not by assurance."),
        ("5. Declining revenue with a story attached",
         "Two or more years of decline explained by market conditions, a lost client, or \u201ca "
         "bad hire.\u201d Trends are more honest than narratives."),
        ("6. Numbers the seller will not let you audit",
         "Refusal of a quality-of-earnings review, delay of access, or figures that change between "
         "conversations. Opaque books are the most reliable predictor of a bad deal."),
        ("7. A business that only works with the seller\u2019s undisclosed relationships",
         "Verbal arrangements, handshake supply deals, crony contracts. If it is not written and "
         "assignable, it does not exist after closing."),
    ]
    for head, body in BREAKERS:
        F.append(KeepTogether([Paragraph(head, st_sub), Paragraph(body, st_body), Spacer(1, 3)]))
    F.append(Spacer(1, 7))
    F.append(callout("If you find one of these after LOI, the right response is to re-price the "
                     "deal significantly \u2014 not to talk yourself into the original number. If "
                     "you find two, walk."))

    # ------------------------------------------------ SECTION 6
    F.append(PageBreak())
    F += section("Section 6", "Due Diligence Priorities",
                 "Run these in order of risk, not alphabetical order. The first four sink most deals.")
    F.append(datatable(
        ["AREA", "WHAT YOU ARE ACTUALLY LOOKING FOR"],
        [["Financial", "Three years of tax returns reconciled to bank statements; quality-of-earnings "
                       "review; AR aging; working capital trend"],
         ["Customer", "Contracts, retention over three years, concentration, pricing history, any "
                      "relationship held only by the seller"],
         ["Legal", "Entity standing, litigation, liens, IP ownership, assignability of key contracts "
                   "and licenses"],
         ["Tax", "Sales and use tax compliance, payroll tax filings, nexus exposure, any unpaid "
                 "assessments"],
         ["Employment", "Offer letters, non-competes, accrued PTO, undocumented workers, key-person "
                        "retention plans"],
         ["Operations", "Equipment condition, deferred maintenance, capex history, supplier terms, "
                        "single-source risks"],
         ["Compliance", "Licenses and permits, insurance adequacy, environmental exposure, "
                        "industry-specific regulation"],
         ["Technology", "Ownership of software, data rights, security posture, any critical system "
                        "held in the seller\u2019s name"]],
        [1.18 * inch, CONTENT_W - 1.18 * inch]))
    F.append(Spacer(1, 12))
    F.append(callout("Diligence discipline: get everything in writing and keep a running issues log "
                     "with a dollar value beside each item. An issue without a number is an "
                     "argument; an issue with a number is a negotiation."))

    # ------------------------------------------------ SECTION 7
    F.append(PageBreak())
    F += section("Section 7", "From LOI to Close",
                 "A typical acquisition closes in 60\u2013120 days from accepted letter of intent. "
                 "Here is what should happen, and roughly when.")
    F.append(datatable(
        ["WHEN", "WHAT HAPPENS", "YOUR JOB"],
        [["Day 0", "LOI signed", "Lock exclusivity and the diligence window in writing"],
         ["Days 1\u201310", "Diligence opens", "Request the full document list on day one, not week three"],
         ["Days 10\u201335", "Financial and legal review", "Reconcile earnings to source; keep the issues log current"],
         ["Days 30\u201345", "Financing", "Lender underwriting, appraisal, personal financial package"],
         ["Days 40\u201360", "Purchase agreement", "Negotiate reps, warranties, escrow and working capital peg"],
         ["Days 55\u201375", "Conditions cleared", "Landlord consents, key contracts assigned, licenses transferred"],
         ["Days 70\u2013110", "Closing", "Funds flow, transition begins, employees and customers informed"],
         ["Days 110\u2013200", "Integration", "Systems, reporting, and the handover you negotiated"]],
        [1.05 * inch, 1.62 * inch, CONTENT_W - 2.67 * inch]))
    F.append(Spacer(1, 12))
    F.append(callout("The two most common causes of a blown close: incomplete records discovered in "
                     "week five instead of week one, and financing terms that were never actually "
                     "confirmed with a lender before the LOI was signed."))

    # ------------------------------------------------ SECTION 8 + close
    F.append(PageBreak())
    F += section("Section 8", "First 90 Days After Close",
                 "The deal is not the finish line. Most value is destroyed in the first quarter of "
                 "ownership, usually by moving faster than the business can absorb.")
    F.append(datatable(
        ["WINDOW", "PRIORITY"],
        [["Days 1\u201314", "Communicate. Every employee, every key customer, every supplier. "
                           "Uncertainty is what makes people leave."],
         ["Days 1\u201330", "Secure the money: bank access, payroll continuity, lockbox or payment "
                           "redirection, review every signer on every account"],
         ["Days 15\u201345", "Observe before changing. Learn how the work actually gets done before "
                            "reorganizing it"],
         ["Days 30\u201360", "Install reporting. Monthly financials you trust, a simple KPI set, "
                            "weekly cash visibility"],
         ["Days 45\u201390", "Retain key people with real incentives. Sign the retention agreements "
                            "you negotiated"],
         ["Days 60\u201390", "Begin the integration plan: systems, pricing, and the growth thesis "
                            "you bought the business for"]],
        [1.12 * inch, CONTENT_W - 1.12 * inch]))

    F.append(Spacer(1, 20))
    F.append(Paragraph("Ready for the next step?", S("cta", fontName=FONT_B, fontSize=17,
                                                     leading=21, textColor=NAVY, spaceAfter=7)))
    F.append(Paragraph("REIL represents buyers and sellers of $5M\u2013$100M businesses across "
                       "Wisconsin, Illinois, Iowa, Michigan and Minnesota. If you want vetted, "
                       "confidential opportunities \u2014 or a straight answer about whether you "
                       "are ready to buy \u2014 start a confidential conversation.", st_body))
    F.append(Spacer(1, 9))
    F.append(Paragraph('<font color="#0D7377"><b>reilacquisitions.com \u00b7 '
                       'hello@reilacquisitions.com</b></font>', st_body))
    F.append(Spacer(1, 16))
    F.append(Paragraph("This guide is general information for business buyers, not legal, tax or "
                       "accounting advice. Every transaction is different \u2014 work with "
                       "qualified advisors on your specific deal.", st_footnote))

    doc.build(F)
    print("built:", path)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "REIL-Acquisition-Checklist.pdf"
    LOGO_PNG = sys.argv[2] if len(sys.argv) > 2 else "/tmp/reilwork/assets/reil-mark.png"
    LOGO_TMP = "/tmp/reilwork/_logo_flat.png"
    build(out)
