"""Tiny, safe schema upgrade for existing SQLite/Postgres databases (no Alembic needed).

create_all() never ALTERs existing tables, so columns added in newer versions are added here,
and legacy escrows (created before jobs existed) are wrapped in a Job so they show up everywhere."""
from datetime import datetime

from sqlalchemy import inspect, text

from .models import Escrow, Job

NEW_COLUMNS = {
    "users": {"avatar": "TEXT"},
    "escrows": {
        "job_id": "INTEGER",
        "milestone_no": "INTEGER",
        "milestone_description": "TEXT",
        "deadline_at": "TIMESTAMP",
        "extension_requested_at": "TIMESTAMP",
        "accepted_at": "TIMESTAMP",
        "accepted_sig": "VARCHAR(200)",
    },
    "disputes": {
        "category": "VARCHAR(40)",
        "status": "VARCHAR(20)",
        "claimant_role": "VARCHAR(8)",
        "claim_amount": "NUMERIC(38, 6)",
        "challenged_at": "TIMESTAMP",
        "settled_at": "TIMESTAMP",
        "arbitrage_at": "TIMESTAMP",
        "payer_share": "NUMERIC(38, 6)",
        "payee_share": "NUMERIC(38, 6)",
    },
}


def ensure_columns(engine) -> None:
    insp = inspect(engine)
    with engine.begin() as conn:
        for table, cols in NEW_COLUMNS.items():
            if not insp.has_table(table):
                continue
            have = {c["name"] for c in insp.get_columns(table)}
            for name, ddl in cols.items():
                if name not in have:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
        if insp.has_table("disputes"):
            conn.execute(text("UPDATE disputes SET status = 'raised' WHERE status IS NULL"))


def backfill_jobs(SessionLocal) -> None:
    """Wrap every escrow that has no job yet in a Job (legacy data) and treat it as already accepted."""
    db = SessionLocal()
    try:
        orphans = db.query(Escrow).filter(Escrow.job_id.is_(None)).all()
        for e in orphans:
            job = Job(
                title=e.title,
                description=e.description,
                terms_uri=e.terms_uri,
                sender_address=e.sender_address,
                receiver_address=e.receiver_address,
                created_at=e.created_at or datetime.utcnow(),
            )
            db.add(job)
            db.flush()
            e.job_id = job.id
            e.milestone_no = 1
            e.milestone_description = e.description or e.title
            e.accepted_at = e.accepted_at or e.created_at or datetime.utcnow()
        if orphans:
            db.commit()
    finally:
        db.close()
