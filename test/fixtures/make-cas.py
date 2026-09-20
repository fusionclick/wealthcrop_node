# Regenerates test/fixtures/cas-sample.pdf — a password-protected statement laid out the
# way CAMS and KFintech lay theirs out. Not run by the test suite; kept so the fixture can
# be rebuilt or extended without hunting for a real investor's statement.
#
#   python test/fixtures/make-cas.py
#
# Every cell is drawn as its own text run at its own x, exactly as the real RTAs emit them,
# so the test exercises pdfLines' regroup-by-row step rather than a convenient one-line-per
# -string PDF that would pass no matter what.

import io
import os

from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

# A statement is issued to a PAN, and casImport refuses one whose PAN is not the signed-in
# investor's (cas_pan_mismatch, 403). So testing the import against a real account means
# building a copy issued to THAT account's PAN — otherwise the upload is rejected before a
# single holding is parsed, which reads as "the import is broken".
#
#   CAS_PAN=XXXXX0000X CAS_OUT=/tmp/mine.pdf python test/fixtures/make-cas.py
#
# A real CAS uses the PAN as its own password, and so does this one.
PAN = os.environ.get("CAS_PAN", "ABCDE1234F").strip().upper()
PASSWORD = PAN
OUT = os.environ.get("CAS_OUT") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "cas-sample.pdf"
)

# Every ISIN below belongs to the scheme printed beside it — verified against AMFI's live
# list. That was not true of the first version: INF179K01XQ0 is HDFC Mid Cap Fund, and it sat
# next to a line reading "HDFC Liquid Fund". The parser resolved the ISIN, which is the
# identifier, and showed Mid Cap and its real NAV of 231.41 — correct behaviour that read as a
# broken matcher. Two other ISINs were invented outright, so those rows came back "not in our
# catalogue" and looked like a gap in the fund database. Neither was a product bug; both were
# this file. If you add a scheme here, look its ISIN up first.

# (y, [(x, text), ...]) — y counts down from the top as we draw.
ROWS = [
    [(40, "Consolidated Account Statement")],
    [(40, "01-Apr-2024"), (130, "To"), (160, "31-Mar-2025")],
    [(40, "Email Id: investor@example.com")],
    [(40, f"PAN: {PAN}"), (200, "KYC: OK"), (300, "PAN: OK")],
    [],
    [(40, "HDFC Mutual Fund")],
    [(40, "Folio No: 12345678 / 90"), (220, f"PAN: {PAN}"), (380, "KYC: OK")],
    [(40, "HDFC123-HDFC Mid Cap Fund - Growth Option"), (300, "(Advisor: ARN-0000)"), (430, "Registrar : CAMS")],
    [(40, "ISIN: INF179K01XQ0")],
    [(300, "Opening Unit Balance:"), (450, "0.000")],
    [(40, "02-Apr-2024"), (110, "Purchase"), (300, "10,000.00"), (370, "245.678"), (440, "40.6998"), (500, "245.678")],
    [(40, "15-Jun-2024"), (110, "Redemption"), (300, "(5,000.00)"), (370, "(120.500)"), (440, "41.4938"), (500, "125.178")],
    [(40, "10-Aug-2024"), (110, "*** Stamp Duty ***"), (300, "0.50")],
    [(300, "Closing Unit Balance:"), (430, "125.178"), (480, "NAV on 31-Mar-2025: INR 44.2100")],
    [(300, "Valuation on 31-Mar-2025: INR 5,533.62")],
    [],
    # Same AMC, second folio — proves folios are not collapsed together.
    [(40, "HDFC Mutual Fund")],
    [(40, "Folio No: 99887766"), (220, f"PAN: {PAN}")],
    [(40, "HDFC777-HDFC Flexi Cap Fund - Growth"), (400, "Registrar : CAMS")],
    [(40, "ISIN: INF179K01UT0")],
    [(300, "Opening Unit Balance:"), (450, "0.000")],
    [(40, "05-Apr-2024"), (110, "Purchase-SIP"), (300, "5,000.00"), (370, "3.500"), (440, "1,428.5714"), (500, "3.500")],
    [(40, "05-May-2024"), (110, "Purchase-SIP"), (300, "5,000.00"), (370, "3.400"), (440, "1,470.5882"), (500, "6.900")],
    [(300, "Closing Unit Balance:"), (430, "6.900"), (480, "NAV on 31-Mar-2025: INR 1,600.0000")],
    [(300, "Valuation on 31-Mar-2025: INR 11,040.00")],
    [],
    # KFintech block: "Market Value on", folio with no suffix, and an opening balance that
    # is NOT zero — its cost was paid before this statement, so it must come back unknown.
    [(40, "Axis Mutual Fund")],
    [(40, "Folio No: 91234567890"), (220, f"PAN: {PAN}")],
    [(40, "128TSDGG-Axis ELSS Tax Saver Fund - Regular Plan - Growth"), (420, "Registrar : KFINTECH")],
    [(40, "ISIN: INF846K01131")],
    [(300, "Opening Unit Balance:"), (450, "500.000")],
    [(40, "20-Sep-2024"), (110, "Purchase"), (300, "20,000.00"), (370, "200.000"), (440, "100.0000"), (500, "700.000")],
    [(300, "Closing Unit Balance:"), (430, "700.000"), (480, "NAV on 31-Mar-2025: INR 110.0000")],
    [(300, "Market Value on 31-Mar-2025: INR 77,000.00")],
    [],
    # Fully redeemed — still held units are 0, so it must NOT come back as a holding.
    [(40, "SBI Mutual Fund")],
    [(40, "Folio No: 55555555"), (220, f"PAN: {PAN}")],
    [(40, "SBI001-SBI Large Cap Fund - Growth"), (400, "Registrar : CAMS")],
    [(40, "ISIN: INF200K01QV8")],
    [(300, "Opening Unit Balance:"), (450, "0.000")],
    [(40, "01-Jul-2024"), (110, "Purchase"), (300, "1,000.00"), (370, "10.000"), (440, "100.0000"), (500, "10.000")],
    [(40, "01-Dec-2024"), (110, "Redemption"), (300, "(1,100.00)"), (370, "(10.000)"), (440, "110.0000"), (500, "0.000")],
    [(300, "Closing Unit Balance:"), (430, "0.000"), (480, "NAV on 31-Mar-2025: INR 115.0000")],
    [(300, "Valuation on 31-Mar-2025: INR 0.00")],
]


def build() -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    width, height = A4
    y = height - 50
    for row in ROWS:
        if y < 60:  # new page mid-statement, like a real multi-page CAS
            c.showPage()
            y = height - 50
        c.setFont("Helvetica", 7)
        for x, text in row:
            c.drawString(x, y, text)
        y -= 14
    c.showPage()
    c.save()

    reader = PdfReader(io.BytesIO(buf.getvalue()))
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    writer.encrypt(PASSWORD)  # same standard security handler CAMS/KFintech use
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


if __name__ == "__main__":
    with open(OUT, "wb") as fh:
        fh.write(build())
    print(f"wrote {OUT} (password: {PASSWORD})")
