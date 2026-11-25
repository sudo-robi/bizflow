"""Dashboard metrics and CSV exports derived exclusively from database aggregates."""

from __future__ import annotations

import csv
from collections import defaultdict
from decimal import Decimal
from io import BytesIO, StringIO

from fastapi import APIRouter, Depends, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (
    AgreementMilestone,
    BlockchainTransaction,
    Invoice,
    PaymentAgreement,
    PaymentRecord,
    Supplier,
)
from app.security import require_roles
from app.utils import money_str

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/dashboard")
def dashboard(
    membership=Depends(require_roles("finance_manager")), db: Session = Depends(get_db)
):
    business_id = membership.business_id
    by_status = dict(
        db.execute(
            select(Invoice.status, func.count()).where(Invoice.business_id == business_id).group_by(Invoice.status)
        ).all()
    )
    confirmed = db.scalar(
        select(func.coalesce(func.sum(PaymentRecord.amount), 0)).where(
            PaymentRecord.business_id == business_id, PaymentRecord.status == "confirmed"
        )
    )
    counts = {
        "invoices": db.scalar(
            select(func.count()).select_from(Invoice).where(Invoice.business_id == business_id)
        )
        or 0,
        "suppliers": db.scalar(
            select(func.count()).select_from(Supplier).where(Supplier.business_id == business_id)
        )
        or 0,
        "payments_confirmed": db.scalar(
            select(func.count()).select_from(PaymentRecord).where(
                PaymentRecord.business_id == business_id, PaymentRecord.status == "confirmed"
            )
        )
        or 0,
        "payments_pending": db.scalar(
            select(func.count()).select_from(PaymentRecord).where(
                PaymentRecord.business_id == business_id, PaymentRecord.status == "prepared"
            )
        )
        or 0,
        "agreements_active": db.scalar(
            select(func.count()).select_from(PaymentAgreement).where(
                PaymentAgreement.business_id == business_id, PaymentAgreement.status == "active"
            )
        )
        or 0,
        "milestones_released": db.scalar(
            select(func.count())
            .select_from(AgreementMilestone)
            .join(PaymentAgreement, PaymentAgreement.id == AgreementMilestone.agreement_id)
            .where(
                PaymentAgreement.business_id == business_id,
                AgreementMilestone.status == "released",
            )
        )
        or 0,
    }
    recent = db.scalars(
        select(BlockchainTransaction)
        .where(BlockchainTransaction.business_id == business_id)
        .order_by(BlockchainTransaction.created_at.desc())
        .limit(5)
    ).all()
    monthly: dict[str, str] = defaultdict(lambda: "0")
    rows = db.execute(
        select(PaymentRecord.confirmed_at, PaymentRecord.amount).where(
            PaymentRecord.business_id == business_id,
            PaymentRecord.status == "confirmed",
            PaymentRecord.confirmed_at.isnot(None),
        )
    ).all()
    from decimal import Decimal

    totals: dict[str, Decimal] = defaultdict(Decimal)
    for confirmed_at, amount in rows:
        key = confirmed_at.strftime("%Y-%m")
        totals[key] += Decimal(str(amount))
    monthly = {key: money_str(value) for key, value in sorted(totals.items())[-6:]}

    return {
        "counts": counts,
        "invoices_by_status": by_status,
        "total_paid": money_str(confirmed),
        "monthly_volume": monthly,
        "recent_transactions": [
            {
                "hash": row.hash,
                "status": row.status,
                "successful": row.successful,
                "asset_code": row.asset_code,
                "amount": money_str(row.amount) if row.amount is not None else None,
                "confirmed_at": row.confirmed_at,
            }
            for row in recent
        ],
        "has_data": counts["invoices"] > 0 or counts["payments_confirmed"] > 0,
    }


@router.get("/analytics")
def analytics(membership=Depends(require_roles("finance_manager")), db: Session = Depends(get_db)):
    """Business analytics derived only from stored, verified records."""
    from collections import OrderedDict
    from datetime import timedelta

    from app.utils import money_str, naive, utcnow

    bid = membership.business_id
    confirmed_rows = db.execute(
        select(PaymentRecord.confirmed_at, PaymentRecord.amount, PaymentRecord.status).where(
            PaymentRecord.business_id == bid
        )
    ).all()
    monthly: dict[str, Decimal] = defaultdict(Decimal)
    completed = failed = 0
    for confirmed_at, amount, status in confirmed_rows:
        if status == "confirmed" and confirmed_at:
            monthly[naive(confirmed_at).strftime("%Y-%m")] += Decimal(str(amount))
            completed += 1
        elif status == "failed":
            failed += 1
    trend = OrderedDict()
    previous: Decimal | None = None
    for month in sorted(monthly)[-12:]:
        value = monthly[month]
        trend[month] = {
            "volume": money_str(value),
            "change_pct": (
                money_str(((value - previous) / previous * 100).quantize(Decimal("0.01")))
                if previous and previous != 0
                else None
            ),
        }
        previous = value

    supplier_totals = db.execute(
        select(Supplier.business_name, func.coalesce(func.sum(PaymentRecord.amount), 0))
        .join(Invoice, Invoice.supplier_id == Supplier.id)
        .join(PaymentRecord, PaymentRecord.invoice_id == Invoice.id)
        .where(
            Supplier.business_id == bid,
            PaymentRecord.status == "confirmed",
        )
        .group_by(Supplier.business_name)
        .order_by(func.sum(PaymentRecord.amount).desc())
    ).all()

    outstanding = Decimal("0")
    aging: dict[str, dict[str, str]] = {
        "0_30": {"count": "0", "amount": "0"},
        "31_60": {"count": "0", "amount": "0"},
        "61_90": {"count": "0", "amount": "0"},
        "90_plus": {"count": "0", "amount": "0"},
    }
    now = utcnow()
    for invoice, paid in db.execute(
        select(Invoice, func.coalesce(func.sum(PaymentRecord.amount), 0))
        .outerjoin(
            PaymentRecord,
            (PaymentRecord.invoice_id == Invoice.id) & (PaymentRecord.status == "confirmed"),
        )
        .where(Invoice.business_id == bid, Invoice.status != "cancelled")
        .group_by(Invoice.id)
    ).all():
        remainder = Decimal(str(invoice.amount)) - Decimal(str(paid or 0))
        if remainder <= 0:
            continue
        outstanding += remainder
        days = (now - naive(invoice.due_date)).days if invoice.due_date else 0
        bucket = "90_plus" if days > 90 else "61_90" if days > 60 else "31_60" if days > 30 else "0_30"
        aging[bucket]["count"] = str(int(aging[bucket]["count"]) + 1)
        aging[bucket]["amount"] = money_str(
            Decimal(aging[bucket]["amount"]) + remainder
        )

    return {
        "monthly_payment_volume": trend,
        "supplier_breakdown": [
            {"supplier": name, "total": money_str(total)} for name, total in supplier_totals
        ],
        "outstanding_liabilities": money_str(outstanding),
        "completed_payments": completed,
        "failed_payments": failed,
        "invoice_aging": aging,
        "agreements_by_status": dict(
            db.execute(
                select(PaymentAgreement.status, func.count())
                .where(PaymentAgreement.business_id == bid)
                .group_by(PaymentAgreement.status)
            ).all()
        ),
    }


@router.get("/reconciliation")
def reconciliation(membership=Depends(require_roles("finance_manager")), db: Session = Depends(get_db)):
    """Identify unmatched, partial, overpaid and inconsistent payment records."""
    from app.utils import money_str

    bid = membership.business_id
    unmatched = db.scalars(
        select(BlockchainTransaction).where(
            BlockchainTransaction.business_id == bid,
            BlockchainTransaction.payment_record_id.is_(None),
        )
    ).all()
    unmatched_out = [
        {
            "hash": row.hash,
            "source_account": row.source_account,
            "destination_account": row.destination_account,
            "amount": money_str(row.amount) if row.amount is not None else None,
            "asset_code": row.asset_code,
            "memo": row.memo,
            "confirmed_at": row.confirmed_at,
        }
        for row in unmatched
    ]

    partial: list[dict] = []
    overpaid: list[dict] = []
    rows = db.execute(
        select(Invoice, func.coalesce(func.sum(PaymentRecord.amount), 0))
        .outerjoin(
            PaymentRecord,
            (PaymentRecord.invoice_id == Invoice.id) & (PaymentRecord.status == "confirmed"),
        )
        .where(Invoice.business_id == bid)
        .group_by(Invoice.id)
    ).all()
    for invoice, paid in rows:
        total = Decimal(str(invoice.amount))
        settled = Decimal(str(paid or 0))
        if 0 < settled < total:
            partial.append(
                {"invoice_number": invoice.invoice_number, "paid": money_str(settled), "amount": money_str(total)}
            )
        elif settled > total:
            overpaid.append(
                {"invoice_number": invoice.invoice_number, "paid": money_str(settled), "amount": money_str(total)}
            )

    duplicate_hashes = [
        {"hash": row[0], "count": row[1]}
        for row in db.execute(
            select(BlockchainTransaction.hash, func.count())
            .where(BlockchainTransaction.business_id == bid)
            .group_by(BlockchainTransaction.hash)
            .having(func.count() > 1)
        ).all()
    ]
    inconsistent = db.execute(
        select(func.count())
        .select_from(PaymentRecord)
        .where(
            PaymentRecord.business_id == bid,
            PaymentRecord.status == "confirmed",
            PaymentRecord.hash.is_(None),
        )
    ).scalar_one()
    return {
        "unmatched_transactions": unmatched_out,
        "partial_payments": partial,
        "overpayments": overpaid,
        "duplicate_transaction_hashes": duplicate_hashes,
        "confirmed_payments_without_hash": inconsistent,
    }


@router.get("/analytics.pdf")
def analytics_pdf(
    membership=Depends(require_roles("finance_manager")), db: Session = Depends(get_db)
):
    """PDF export of the same DB-derived analytics used by the dashboard."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    data = analytics(membership=membership, db=db)
    styles = getSampleStyleSheet()
    buffer = BytesIO()
    document = SimpleDocTemplate(buffer, pagesize=A4)
    story = [Paragraph("BizFlow financial analytics", styles["Title"])]
    story.append(
        Paragraph(
            "All figures are derived from stored, verified records. Pending and failed "
            "payments are excluded from completed totals.",
            styles["Normal"],
        )
    )
    story.append(Spacer(1, 12))

    def _table(title: str, rows: list[list[str]]) -> None:
        story.append(Paragraph(title, styles["Heading2"]))
        table = Table(rows, colWidths=[260, 220])
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1E3A5F")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                    ("FONTSIZE", (0, 0), (-1, -1), 8),
                ]
            )
        )
        story.append(table)
        story.append(Spacer(1, 12))

    _table(
        "Summary",
        [
            ["Metric", "Value"],
            ["Outstanding liabilities", data["outstanding_liabilities"]],
            ["Completed payments", str(data["completed_payments"])],
            ["Failed payments", str(data["failed_payments"])],
        ],
    )
    _table(
        "Invoice aging",
        [["Bucket", "Count", "Amount"]]
        + [[bucket, values["count"], values["amount"]] for bucket, values in data["invoice_aging"].items()],
    )
    _table(
        "Supplier breakdown",
        [["Supplier", "Confirmed total"]]
        + [[entry["supplier"], entry["total"]] for entry in data["supplier_breakdown"]],
    )
    document.build(story)
    return Response(
        content=buffer.getvalue(),
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="bizflow-analytics.pdf"'},
    )


@router.get("/payments.csv")
def payments_csv(
    membership=Depends(require_roles("finance_manager")), db: Session = Depends(get_db)
):
    rows = db.scalars(
        select(PaymentRecord)
        .where(PaymentRecord.business_id == membership.business_id)
        .order_by(PaymentRecord.created_at.desc())
    ).all()
    output = StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "id", "kind", "amount", "asset_code", "asset_issuer", "source_account",
            "destination_account", "memo", "hash", "status", "created_at", "confirmed_at",
        ]
    )
    for row in rows:
        writer.writerow(
            [
                row.id, row.kind, money_str(row.amount), row.asset_code, row.asset_issuer or "",
                row.source_account or "", row.destination_account or "", row.memo or "",
                row.hash or "", row.status, row.created_at.isoformat(),
                row.confirmed_at.isoformat() if row.confirmed_at else "",
            ]
        )
    return Response(
        content=output.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="bizflow-payments.csv"'},
    )
