"""ReportLab PDF generation for verified payment receipts and invoices."""

from __future__ import annotations

from io import BytesIO
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    HRFlowable,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from app.utils import money_str, utcnow

INK = colors.HexColor("#101828")
MUTED = colors.HexColor("#667085")
ACCENT = colors.HexColor("#0E7490")
LINE = colors.HexColor("#E4E7EC")
PANEL = colors.HexColor("#F8FAFC")


def _styles():
    base = getSampleStyleSheet()
    return {
        "brand": ParagraphStyle(
            "brand", parent=base["Title"], fontSize=22, leading=26, textColor=ACCENT, alignment=TA_RIGHT
        ),
        "heading": ParagraphStyle(
            "heading", parent=base["Title"], fontSize=18, leading=22, textColor=INK
        ),
        "sub": ParagraphStyle("sub", parent=base["Normal"], fontSize=9, textColor=MUTED, leading=13),
        "body": ParagraphStyle("body", parent=base["Normal"], fontSize=10, leading=14, textColor=INK),
        "small": ParagraphStyle("small", parent=base["Normal"], fontSize=8, leading=11, textColor=MUTED),
    }


def _header(styles: dict, title: str, subtitle: str):
    return [
        Table(
            [
                [Paragraph("BizFlow", styles["brand"])],
                [Paragraph("Stellar business payments", styles["sub"])],
            ],
            colWidths=[170 * mm],
        ),
        Spacer(1, 8 * mm),
        Paragraph(title, styles["heading"]),
        Paragraph(subtitle, styles["sub"]),
        Spacer(1, 5 * mm),
        HRFlowable(width="100%", thickness=1, color=LINE),
        Spacer(1, 6 * mm),
    ]


def _table(rows: list[list[str]], widths: list[float], header: bool = True) -> Table:
    table = Table(rows, colWidths=widths, hAlign="LEFT")
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.white, PANEL]),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("TEXTCOLOR", (0, 0), (-1, -1), INK),
    ]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), ACCENT), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white)]
    table.setStyle(TableStyle(style))
    return table


def _footer(story: list, styles: dict, note: str) -> None:
    story.extend(
        [
            Spacer(1, 8 * mm),
            HRFlowable(width="100%", thickness=0.6, color=LINE),
            Spacer(1, 3 * mm),
            Paragraph(note, styles["small"]),
            Paragraph(f"Generated {utcnow().strftime('%Y-%m-%d %H:%M UTC')} by BizFlow", styles["small"]),
        ]
    )


def _render(story: list) -> bytes:
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title="BizFlow document",
        author="BizFlow",
    )
    doc.build(story)
    return buffer.getvalue()


def build_invoice_pdf(invoice: Any, supplier: Any, business: Any, items: list[Any]) -> bytes:
    styles = _styles()
    story = _header(
        styles,
        f"Invoice {invoice.invoice_number}",
        f"{business.name} &middot; due {invoice.due_date.date().isoformat()}",
    )
    story.append(
        _table(
            [
                ["Billed by", "Billed to"],
                [
                    f"{business.name}<br/>{business.country or ''}",
                    f"{supplier.business_name}<br/>{supplier.wallet_address}",
                ],
            ],
            [85 * mm, 85 * mm],
        )
    )
    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph(str(invoice.description), styles["body"]))
    story.append(Spacer(1, 5 * mm))

    rows = [["Description", "Qty", "Unit price", "Amount"]]
    for item in items:
        rows.append(
            [
                item.description,
                money_str(item.quantity),
                money_str(item.unit_price),
                money_str(to_dec(item.quantity) * to_dec(item.unit_price)),
            ]
        )
    if not items:
        rows.append([invoice.description, "1", money_str(invoice.amount), money_str(invoice.amount)])
    rows.append(["", "", "Total", money_str(invoice.amount)])
    story.append(_table(rows, [75 * mm, 20 * mm, 35 * mm, 40 * mm]))
    story.append(Spacer(1, 4 * mm))
    story.append(
        Paragraph(
            f"Asset: {invoice.asset_code}"
            + (f" ({invoice.asset_issuer})" if invoice.asset_issuer else " (native)"),
            styles["small"],
        )
    )
    _footer(story, styles, "Payable on Stellar testnet. Status is derived from confirmed on-chain payments.")
    return _render(story)


def build_receipt_pdf(receipt: dict[str, Any]) -> bytes:
    """Receipt for a verified, confirmed payment (all settlement fields included)."""
    styles = _styles()
    story = _header(
        styles,
        "Payment receipt",
        f"Receipt {receipt.get('receipt_id', '')} &middot; {receipt.get('network', 'testnet')}",
    )
    rows = [
        ["Field", "Value"],
        ["Receipt ID", str(receipt.get("receipt_id", ""))],
        ["Payment ID", str(receipt.get("payment_id", ""))],
        ["Invoice number", str(receipt.get("invoice_number", "-"))],
        ["Business", str(receipt.get("business_name", "-"))],
        ["Supplier", str(receipt.get("supplier_name", "-"))],
        ["Amount", f"{money_str(receipt.get('amount', '0'))} {receipt.get('asset_code', '')}"],
        ["Asset issuer", str(receipt.get("asset_issuer") or "native XLM")],
        ["Source account", str(receipt.get("source_account") or "-")],
        ["Destination account", str(receipt.get("destination_account") or "-")],
        ["Memo", str(receipt.get("memo") or "-")],
        ["Transaction hash", str(receipt.get("hash") or "-")],
        [
            "Stellar explorer",
            "https://stellar.expert/explorer/testnet/tx/" + str(receipt.get("hash") or "")
            if receipt.get("hash")
            else "-",
        ],
        ["Ledger", str(receipt.get("ledger") if receipt.get("ledger") is not None else "-")],
        ["Network", str(receipt.get("network", "testnet"))],
        ["Status", str(receipt.get("status", "-"))],
        ["Confirmed at", str(receipt.get("confirmed_at") or "-")],
        ["Verified on-chain", "yes" if receipt.get("verified") else "no"],
    ]
    story.append(_table(rows, [55 * mm, 115 * mm]))
    _footer(
        story,
        styles,
        "This receipt is only issued for transactions confirmed successful on the Stellar ledger.",
    )
    return _render(story)


def to_dec(value):
    from decimal import Decimal

    return Decimal(str(value))
