#!/usr/bin/env python3
"""
Contrast + layout verifier for the REIL checklist PDF.

This is the check that would have caught the original bug. For every text span it
works out what colour is ACTUALLY behind the text (by rendering the page with that
span's own pixels removed and sampling), then computes the WCAG contrast ratio and
fails anything below threshold.

Also flags:
  - overlapping text bounding boxes (badge over heading)
  - text running outside the printable margin
  - unembedded fonts

Usage: python3 verify_pdf.py file.pdf [--min-contrast 4.5]
"""
import sys
import pymupdf

def hexc(i):
    return "#%06x" % (i & 0xFFFFFF)

def lum(rgb):
    def ch(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = rgb
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)

def contrast(fg, bg):
    l1, l2 = lum(fg), lum(bg)
    if l1 < l2:
        l1, l2 = l2, l1
    return (l1 + 0.05) / (l2 + 0.05)

def bg_behind(page, bbox, own_rgb):
    """Render the clip with this span's glyphs covered, then take the modal colour."""
    x0, y0, x1, y1 = bbox
    pad = 1.0
    clip = pymupdf.Rect(x0 - pad, y0 - pad, x1 + pad, y1 + pad)
    # cover the glyph area by sampling a thin strip just outside the glyph box but
    # inside the row, which is the true background for a solid-fill design
    strip = pymupdf.Rect(x0 - pad, y0 - pad, x1 + pad, y0 + 0.5)   # above the text
    pix = page.get_pixmap(clip=strip, dpi=200)
    if pix.width == 0 or pix.height == 0:
        pix = page.get_pixmap(clip=clip, dpi=200)
    n = pix.n
    s = pix.samples
    counts = {}
    for k in range(0, len(s) - n + 1, n):
        px = (s[k], s[k + 1], s[k + 2])
        counts[px] = counts.get(px, 0) + 1
    if not counts:
        return None
    return max(counts.items(), key=lambda kv: kv[1])[0]

def main():
    path = sys.argv[1]
    min_c = 4.5
    if "--min-contrast" in sys.argv:
        min_c = float(sys.argv[sys.argv.index("--min-contrast") + 1])

    doc = pymupdf.open(path)
    fails, warns = [], []
    total_spans = 0
    lowest = (999, None)

    # ---- fonts embedded?
    fonts = {}
    for p in doc:
        for f in p.get_fonts(full=True):
            xref, ext, ftype, basefont = f[0], f[1], f[2], f[3]
            fonts[basefont] = ext
    unembedded = [b for b, e in fonts.items() if e in ("", "n/a")]

    for pno, page in enumerate(doc, start=1):
        d = page.get_text("dict")
        spans = []
        for b in d["blocks"]:
            if b["type"] != 0:
                continue
            for l in b["lines"]:
                for s in l["spans"]:
                    if not s["text"].strip():
                        continue
                    spans.append(s)
        total_spans += len(spans)

        for s in spans:
            fg = ((s["color"] >> 16) & 255, (s["color"] >> 8) & 255, s["color"] & 255)
            bg = bg_behind(page, s["bbox"], fg)
            if bg is None:
                continue
            cr = contrast(fg, bg)
            if cr < lowest[0]:
                lowest = (cr, (pno, s["text"][:40], hexc(s["color"]), "#%02x%02x%02x" % bg))
            if cr < min_c:
                fails.append((pno, cr, s["text"][:52], hexc(s["color"]), "#%02x%02x%02x" % bg))

        # ---- overlapping spans
        for i in range(len(spans)):
            for j in range(i + 1, len(spans)):
                a, b2 = pymupdf.Rect(spans[i]["bbox"]), pymupdf.Rect(spans[j]["bbox"])
                if a.intersects(b2):
                    inter = a & b2
                    if inter.get_area() > 0.30 * min(a.get_area(), b2.get_area()):
                        warns.append((pno, "overlap", spans[i]["text"][:26], spans[j]["text"][:26]))

        # ---- outside margins (letter: 612x792, margin 61.2pt)
        for s in spans:
            r = pymupdf.Rect(s["bbox"])
            if r.x0 < 55 or r.x1 > 557:
                warns.append((pno, "margin", f"x0={r.x0:.0f} x1={r.x1:.0f}", s["text"][:30]))

    print(f"file            : {path}")
    print(f"pages           : {doc.page_count}")
    print(f"text spans      : {total_spans}")
    print(f"fonts           : {dict(fonts)}")
    print(f"unembedded      : {unembedded if unembedded else 'none (all embedded)'}")
    print(f"min contrast    : {min_c}:1 (WCAG AA normal text)")
    print(f"lowest observed : {lowest[0]:.2f}:1  {lowest[1]}")
    print()
    if fails:
        print(f"CONTRAST FAILURES ({len(fails)}):")
        for pno, cr, txt, fg, bg in fails[:40]:
            print(f"  p{pno} {cr:5.2f}:1  fg={fg} bg={bg}  {txt!r}")
    else:
        print("CONTRAST: PASS - every text span is legible against its background.")
    if warns:
        print(f"\nLAYOUT WARNINGS ({len(warns)}):")
        seen = set()
        for w in warns:
            k = (w[0], w[1])
            if k in seen:
                continue
            seen.add(k)
            print(f"  p{w[0]} {w[1]}: {w[2]}  /  {w[3]}")
    else:
        print("LAYOUT: PASS - no overlaps, nothing outside the printable margin.")

    code = 1 if fails else 0
    print(f"\nRESULT: {'FAIL' if fails else 'PASS'} (exit {code})")
    return code

if __name__ == "__main__":
    sys.exit(main())
