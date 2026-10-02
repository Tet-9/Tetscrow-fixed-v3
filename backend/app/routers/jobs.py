import base64
import os
import re
from datetime import date, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Job, Escrow, Dispute, Message, AgreementStatus
from ..schemas import clean_usdc, ADDR_RE
from ..web3_client import summarize_onchain
from .auth import get_current_wallet
from .common import ActionIn, verify_action, end_of_day, iso
from .escrows import _verify_onchain, _apply_onchain, SKIP_VERIFY
from .users import profile_of

router = APIRouter(prefix="/jobs", tags=["jobs"])
milestones = APIRouter(prefix="/milestones", tags=["milestones"])

MAX_FILE_BYTES = 5 * 1024 * 1024
PAID = (AgreementStatus.released, AgreementStatus.resolved)
LOCKED = (AgreementStatus.funded, AgreementStatus.delivered, AgreementStatus.disputed)


# ----------------------------------------------------------------------------- schemas
class MilestoneIn(BaseModel):
    description: str = Field(..., min_length=1, max_length=5000)
    amount: Decimal = Field(..., gt=0)
    deadline: date
    onchain_id: int | None = Field(default=None, ge=1)
    tx_hash: str | None = Field(default=None, max_length=66)
    token_address: str | None = None


class JobCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=140)
    description: str | None = Field(default=None, max_length=5000)
    terms_uri: str | None = Field(default=None, max_length=512)
    receiver_address: str
    secondary_address: str | None = None
    milestone: MilestoneIn

    @field_validator("receiver_address", "secondary_address")
    @classmethod
    def _addr(cls, v):
        if v in (None, ""):
            return None
        if not ADDR_RE.match(v):
            raise ValueError("Must be a valid wallet address (0x...)")
        return v.lower()


class DeadlineIn(ActionIn):
    new_deadline: date


class MessageIn(BaseModel):
    body: str | None = Field(default=None, max_length=4000)
    file_name: str | None = Field(default=None, max_length=255)
    file_data: str | None = Field(default=None, description="base64 file content")


# ----------------------------------------------------------------------------- helpers
def _check_future(d: date) -> None:
    if d <= date.today():
        raise HTTPException(400, "Deadline must be a future date")


def _job_for(db: Session, job_id: int, wallet: str, *, party_only: bool = False) -> Job:
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if wallet not in (job.sender_address, job.receiver_address):
        if party_only:
            raise HTTPException(403, "Only the buyer and the worker can do this")
        from ..web3_client import read_arbitrator
        try:
            arb = read_arbitrator()
        except Exception:
            arb = None
        if wallet != arb:
            raise HTTPException(403, "You are not part of this job")
    return job


def _milestone(db: Session, escrow_id: int) -> tuple[Escrow, Job]:
    e = db.get(Escrow, escrow_id)
    if not e or e.job_id is None:
        raise HTTPException(404, "Milestone not found")
    return e, db.get(Job, e.job_id)


def milestone_out(e: Escrow, dispute: Dispute | None = None) -> dict:
    return {
        "id": e.id,
        "job_id": e.job_id,
        "no": e.milestone_no or 1,
        "description": e.milestone_description or e.description or e.title,
        "amount": clean_usdc(e.amount),
        "status": e.status.value if hasattr(e.status, "value") else str(e.status),
        "onchain_id": e.onchain_id,
        "tx_hash": e.tx_hash,
        "deadline": iso(e.deadline_at),
        "extension_requested": iso(e.extension_requested_at),
        "accepted": e.accepted_at is not None,
        "dispute_id": dispute.id if dispute else None,
        "dispute_status": dispute.status if dispute else None,
    }


def job_out(db: Session, job: Job) -> dict:
    ms = db.query(Escrow).filter(Escrow.job_id == job.id).order_by(Escrow.milestone_no, Escrow.id).all()
    disputes = {}
    if ms:
        for d in db.query(Dispute).filter(Dispute.escrow_id.in_([m.id for m in ms])).order_by(Dispute.id).all():
            disputes[d.escrow_id] = d  # latest wins
    total = sum((m.amount for m in ms), Decimal(0))
    paid = sum((m.amount for m in ms if m.status in PAID), Decimal(0))
    locked = sum((m.amount for m in ms if m.status in LOCKED), Decimal(0))
    done = sum(1 for m in ms if m.status in PAID)
    return {
        "id": job.id,
        "title": job.title,
        "description": job.description,
        "terms_uri": job.terms_uri,
        "sender_address": job.sender_address,
        "receiver_address": job.receiver_address,
        "secondary_address": job.secondary_address,
        "created_at": iso(job.created_at),
        "sender": profile_of(db, job.sender_address),
        "receiver": profile_of(db, job.receiver_address),
        "milestones": [milestone_out(m, disputes.get(m.id)) for m in ms],
        "totals": {
            "amount": clean_usdc(total),
            "in_escrow": clean_usdc(locked),
            "paid": clean_usdc(paid),
            "completed_milestones": done,
            "milestone_count": len(ms),
        },
    }


def _sync_milestone(e: Escrow) -> None:
    """Pull the real status of one milestone from the chain (best effort)."""
    if e.onchain_id is None or SKIP_VERIFY:
        return
    try:
        summary = summarize_onchain(e.onchain_id)
        e.status = AgreementStatus(summary["status"])
    except Exception as exc:
        print(f"[sync] milestone {e.id}: {exc}")


# ----------------------------------------------------------------------------- jobs
@router.post("")
def create_job(payload: JobCreate, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    receiver = payload.receiver_address
    m = payload.milestone
    if receiver == wallet:
        raise HTTPException(400, "The worker's wallet must be different from yours")
    if m.onchain_id is None:
        raise HTTPException(400, "Fund the first milestone on-chain before creating the job")
    _check_future(m.deadline)

    existing = db.query(Escrow).filter(Escrow.onchain_id == m.onchain_id).first()
    if existing:  # idempotent retry after a network blip
        if existing.sender_address != wallet:
            raise HTTPException(409, "This on-chain escrow is already registered")
        return job_out(db, db.get(Job, existing.job_id))

    summary = _verify_onchain(m.onchain_id, wallet, receiver)
    job = Job(
        title=payload.title.strip(),
        description=(payload.description or "").strip() or None,
        terms_uri=payload.terms_uri,
        sender_address=wallet,
        receiver_address=receiver,
        secondary_address=payload.secondary_address,
    )
    db.add(job)
    db.flush()
    e = Escrow(
        title=job.title,
        description=m.description,
        terms_uri=payload.terms_uri,
        sender_address=wallet,
        receiver_address=receiver,
        token_address=m.token_address,
        amount=m.amount,
        job_id=job.id,
        milestone_no=1,
        milestone_description=m.description.strip(),
        deadline_at=end_of_day(m.deadline),
    )
    _apply_onchain(e, m.tx_hash, m.onchain_id, summary)
    db.add(e)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "This on-chain escrow is already registered")
    return job_out(db, job)


@router.get("/mine")
def my_jobs(sort: str = "newest", wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    jobs = db.query(Job).filter((Job.sender_address == wallet) | (Job.receiver_address == wallet)).all()
    out = [job_out(db, j) for j in jobs]
    if sort == "oldest":
        out.sort(key=lambda j: j["id"])
    elif sort == "amount":
        out.sort(key=lambda j: Decimal(j["totals"]["amount"]), reverse=True)
    else:
        out.sort(key=lambda j: j["id"], reverse=True)
    return out


@router.get("/{job_id}")
def get_job(job_id: int, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    return job_out(db, _job_for(db, job_id, wallet))


@router.post("/{job_id}/sync")
def sync_job(job_id: int, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    """Persist the on-chain status of every milestone (called by the app after each transaction)."""
    job = _job_for(db, job_id, wallet)
    for e in db.query(Escrow).filter(Escrow.job_id == job.id).all():
        _sync_milestone(e)
    db.commit()
    return job_out(db, job)


@router.post("/{job_id}/milestones")
def add_milestone(job_id: int, m: MilestoneIn, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    job = _job_for(db, job_id, wallet, party_only=True)
    if wallet != job.sender_address:
        raise HTTPException(403, "Only the buyer can create milestones")
    if m.onchain_id is None:
        raise HTTPException(400, "Fund the milestone on-chain first")
    _check_future(m.deadline)
    existing = db.query(Escrow).filter(Escrow.onchain_id == m.onchain_id).first()
    if existing:
        if existing.job_id != job.id:
            raise HTTPException(409, "This on-chain escrow is already registered")
        return job_out(db, job)
    summary = _verify_onchain(m.onchain_id, wallet, job.receiver_address)
    n = (db.query(Escrow).filter(Escrow.job_id == job.id).count()) + 1
    e = Escrow(
        title=job.title,
        description=m.description,
        sender_address=wallet,
        receiver_address=job.receiver_address,
        token_address=m.token_address,
        amount=m.amount,
        job_id=job.id,
        milestone_no=n,
        milestone_description=m.description.strip(),
        deadline_at=end_of_day(m.deadline),
    )
    _apply_onchain(e, m.tx_hash, m.onchain_id, summary)
    db.add(e)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "This on-chain escrow is already registered")
    return job_out(db, job)


# ----------------------------------------------------------------------------- chat
def _message_out(m: Message, me: str) -> dict:
    return {
        "id": m.id,
        "sender": m.sender_address,
        "mine": m.sender_address == me,
        "body": m.body,
        "file_name": m.file_name,
        "file_size": m.file_size,
        "created_at": iso(m.created_at),
        "read": m.read_at is not None,
    }


@router.get("/{job_id}/messages")
def list_messages(job_id: int, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    job = _job_for(db, job_id, wallet)  # the arbitrator can read the chat as evidence
    msgs = db.query(Message).filter(Message.job_id == job.id).order_by(Message.id).all()
    is_party = wallet in (job.sender_address, job.receiver_address)
    changed = False
    for m in msgs:  # a party opening the chat marks the other person's messages as read
        if is_party and m.sender_address != wallet and m.read_at is None:
            m.read_at = datetime.utcnow()
            changed = True
    if changed:
        db.commit()
    return [_message_out(m, wallet) for m in msgs]


@router.post("/{job_id}/messages")
def send_message(job_id: int, payload: MessageIn, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    job = _job_for(db, job_id, wallet, party_only=True)
    body = (payload.body or "").strip() or None
    data = None
    if payload.file_data:
        try:
            data = base64.b64decode(payload.file_data, validate=True)
        except Exception:
            raise HTTPException(400, "The file could not be read")
        if len(data) > MAX_FILE_BYTES:
            raise HTTPException(413, "Files can be at most 5 MB (zip big files first)")
        if not payload.file_name:
            raise HTTPException(400, "File name is missing")
    if not body and not data:
        raise HTTPException(400, "Write a message or attach a file")
    safe_name = re.sub(r"[\\/\r\n]", "_", payload.file_name)[:255] if data else None
    m = Message(
        job_id=job.id, sender_address=wallet, body=body,
        file_name=safe_name, file_size=len(data) if data else None, file_data=data,
    )
    db.add(m)
    db.commit()
    return _message_out(m, wallet)


@router.get("/{job_id}/messages/{message_id}/file")
def download_file(job_id: int, message_id: int, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    job = _job_for(db, job_id, wallet)
    m = db.get(Message, message_id)
    if not m or m.job_id != job.id or not m.file_data:
        raise HTTPException(404, "File not found")
    return {"file_name": m.file_name, "data": base64.b64encode(m.file_data).decode()}


# ----------------------------------------------------------------------------- milestone actions (off-chain, signed)
@milestones.post("/{escrow_id}/accept")
def accept_milestone(escrow_id: int, body: ActionIn, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    e, job = _milestone(db, escrow_id)
    if wallet != e.receiver_address:
        raise HTTPException(403, "Only the worker can accept a milestone")
    if e.accepted_at:
        return milestone_out(e)
    verify_action(wallet, "accept", f"milestone:{e.id}", "", body)
    e.accepted_at = datetime.utcnow()
    e.accepted_sig = body.signature[:200]
    db.commit()
    return milestone_out(e)


@milestones.post("/{escrow_id}/extension")
def request_extension(escrow_id: int, body: DeadlineIn, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    e, job = _milestone(db, escrow_id)
    if wallet != e.receiver_address:
        raise HTTPException(403, "Only the worker can request an extension")
    if not e.accepted_at:
        raise HTTPException(400, "Accept the milestone first")
    if e.deadline_at and end_of_day(body.new_deadline) <= e.deadline_at:
        raise HTTPException(400, "The new deadline must be after the current deadline")
    _check_future(body.new_deadline)
    verify_action(wallet, "extension-request", f"milestone:{e.id}", str(body.new_deadline), body)
    e.extension_requested_at = end_of_day(body.new_deadline)
    db.commit()
    return milestone_out(e)


@milestones.post("/{escrow_id}/extension/approve")
def approve_extension(escrow_id: int, body: ActionIn, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    e, job = _milestone(db, escrow_id)
    if wallet != e.sender_address:
        raise HTTPException(403, "Only the buyer can approve an extension")
    if not e.extension_requested_at:
        raise HTTPException(400, "There is no extension request to approve")
    verify_action(wallet, "extension-approve", f"milestone:{e.id}", str(e.extension_requested_at.date()), body)
    e.deadline_at = e.extension_requested_at
    e.extension_requested_at = None
    db.commit()
    return milestone_out(e)


@milestones.post("/{escrow_id}/deadline")
def update_deadline(escrow_id: int, body: DeadlineIn, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    e, job = _milestone(db, escrow_id)
    if wallet != e.sender_address:
        raise HTTPException(403, "Only the buyer can update the deadline")
    _check_future(body.new_deadline)
    verify_action(wallet, "deadline-update", f"milestone:{e.id}", str(body.new_deadline), body)
    e.deadline_at = end_of_day(body.new_deadline)
    e.extension_requested_at = None
    db.commit()
    return milestone_out(e)
