from datetime import datetime, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Dispute, Escrow, Job, AgreementStatus
from ..schemas import clean_usdc
from ..web3_client import read_arbitrator, summarize_onchain
from .auth import get_current_wallet
from .common import ActionIn, RESPONSE_DAYS, d6, iso, verify_action
from .escrows import SKIP_VERIFY
from .users import profile_of

router = APIRouter(prefix="/disputes", tags=["disputes"])

CATEGORIES = {
    "unresponsiveness": "Unresponsiveness",
    "work_quality": "Work Quality Not as Agreed",
    "deadline_passed": "Deadline Passed",
}


class DisputeOpen(BaseModel):
    escrow_id: int  # the milestone
    category: str
    reason: str = Field(..., min_length=3, max_length=5000)
    claim_amount: Decimal = Field(..., gt=0)


class ModifyIn(ActionIn):
    claim_amount: Decimal = Field(..., gt=0)


class ResolveIn(BaseModel):
    payer_share: Decimal = Field(..., ge=0)
    payee_share: Decimal = Field(..., ge=0)
    note: str | None = Field(default=None, max_length=1000)


def _arbiter() -> str | None:
    try:
        return read_arbitrator()
    except Exception:
        return None


def _parts(db: Session, d: Dispute) -> tuple[Escrow, Job]:
    e = db.get(Escrow, d.escrow_id)
    return e, db.get(Job, e.job_id)


def _party_role(job: Job, wallet: str) -> str | None:
    if wallet == job.sender_address:
        return "payer"
    if wallet == job.receiver_address:
        return "payee"
    return None


def _shares(d: Dispute, amount: Decimal) -> tuple[Decimal, Decimal]:
    """(payer_share, payee_share) from the claim: a payer claim is a refund, a payee claim is a payment."""
    if d.payer_share is not None and d.payee_share is not None:
        return d.payer_share, d.payee_share
    claim = min(d.claim_amount or Decimal(0), amount)
    return (claim, amount - claim) if d.claimant_role == "payer" else (amount - claim, claim)


def dispute_out(db: Session, d: Dispute, viewer: str) -> dict:
    e, job = _parts(db, d)
    payer_share, payee_share = _shares(d, e.amount)
    role = _party_role(job, viewer)
    raiser_role = d.claimant_role
    due = (d.created_at or datetime.utcnow()) + timedelta(days=RESPONSE_DAYS)
    return {
        "id": d.id,
        "code": f"{d.id:06d}{(e.onchain_id or 0):06d}",
        "escrow_id": e.id,
        "job_id": job.id,
        "job_title": job.title,
        "milestone_no": e.milestone_no or 1,
        "category": d.category or "unresponsiveness",
        "category_label": CATEGORIES.get(d.category or "", "Dispute"),
        "reason": d.reason,
        "status": d.status or "raised",
        "raised_by": d.raised_by,
        "claimant_role": raiser_role,
        "amount": clean_usdc(e.amount),
        "claim_amount": clean_usdc(d.claim_amount),
        "claim_kind": "refund" if raiser_role == "payer" else "payment",
        "full_claim": (d.claim_amount or 0) >= e.amount,
        "payer_share": clean_usdc(payer_share),
        "payee_share": clean_usdc(payee_share),
        "created_at": iso(d.created_at),
        "response_due": iso(due),
        "support_available_at": iso(due),
        "settled_at": iso(d.settled_at),
        "resolved_at": iso(d.resolved_at),
        "resolution": d.resolution,
        "milestone_status": e.status.value if hasattr(e.status, "value") else str(e.status),
        "onchain_id": e.onchain_id,
        "sender": profile_of(db, job.sender_address),
        "receiver": profile_of(db, job.receiver_address),
        "raiser": profile_of(db, d.raised_by),
        "my_role": role,
        "i_am_raiser": viewer == d.raised_by,
        "i_am_arbiter": viewer == _arbiter(),
    }


def _get(db: Session, dispute_id: int, wallet: str) -> tuple[Dispute, Escrow, Job]:
    d = db.get(Dispute, dispute_id)
    if not d:
        raise HTTPException(404, "Dispute not found")
    e, job = _parts(db, d)
    if _party_role(job, wallet) is None and wallet != _arbiter():
        raise HTTPException(403, "You are not part of this dispute")
    return d, e, job


def _must_be_party(job: Job, wallet: str) -> str:
    role = _party_role(job, wallet)
    if role is None:
        raise HTTPException(403, "Only the buyer and the worker can do this")
    return role


@router.post("")
def open_dispute(payload: DisputeOpen, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    """Record a dispute AFTER the milestone was frozen on-chain with raiseDispute()."""
    e = db.get(Escrow, payload.escrow_id)
    if not e or e.job_id is None:
        raise HTTPException(404, "Milestone not found")
    job = db.get(Job, e.job_id)
    role = _must_be_party(job, wallet)
    if payload.category not in CATEGORIES:
        raise HTTPException(400, "Pick a reason for the dispute")
    if db.query(Dispute).filter(Dispute.escrow_id == e.id, Dispute.status != "resolved").first():
        raise HTTPException(409, "There is already an open dispute on this milestone")
    claim = d6(payload.claim_amount)
    if claim > e.amount:
        raise HTTPException(400, "The dispute amount cannot be more than the milestone amount")
    if not SKIP_VERIFY and e.onchain_id is not None:
        try:
            if summarize_onchain(e.onchain_id)["status"] != "disputed":
                raise HTTPException(400, "The dispute is not open on-chain yet - confirm the transaction first")
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(502, f"Could not read the chain: {exc}")
    e.status = AgreementStatus.disputed
    d = Dispute(
        escrow_id=e.id, raised_by=wallet, reason=payload.reason.strip(), category=payload.category,
        status="raised", claimant_role=role, claim_amount=claim,
    )
    db.add(d)
    db.commit()
    return dispute_out(db, d, wallet)


@router.get("/mine")
def my_disputes(wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    jobs = db.query(Job).filter((Job.sender_address == wallet) | (Job.receiver_address == wallet)).all()
    ids = [e.id for e in db.query(Escrow).filter(Escrow.job_id.in_([j.id for j in jobs])).all()] if jobs else []
    rows = db.query(Dispute).filter(Dispute.escrow_id.in_(ids)).order_by(Dispute.id.desc()).all() if ids else []
    return [dispute_out(db, d, wallet) for d in rows]


@router.get("/{dispute_id}")
def get_dispute(dispute_id: int, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    d, _, _ = _get(db, dispute_id, wallet)
    return dispute_out(db, d, wallet)


@router.post("/{dispute_id}/challenge")
def challenge(dispute_id: int, body: ActionIn, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    d, e, job = _get(db, dispute_id, wallet)
    _must_be_party(job, wallet)
    if wallet == d.raised_by:
        raise HTTPException(403, "You raised this dispute - the other party can challenge it")
    if d.status != "raised":
        raise HTTPException(400, "This dispute can no longer be challenged")
    verify_action(wallet, "dispute-challenge", f"dispute:{d.id}", "", body)
    d.status = "challenged"
    d.challenged_at = datetime.utcnow()
    db.commit()
    return dispute_out(db, d, wallet)


@router.post("/{dispute_id}/modify")
def modify(dispute_id: int, body: ModifyIn, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    d, e, job = _get(db, dispute_id, wallet)
    if wallet != d.raised_by:
        raise HTTPException(403, "Only the person who raised the dispute can change the amount")
    if d.status != "challenged":
        raise HTTPException(400, "The amount can be changed after the other party challenges the dispute")
    claim = d6(body.claim_amount)
    if claim > e.amount:
        raise HTTPException(400, "The dispute amount cannot be more than the milestone amount")
    verify_action(wallet, "dispute-modify", f"dispute:{d.id}", str(claim), body)
    d.claim_amount = claim
    db.commit()
    return dispute_out(db, d, wallet)


@router.post("/{dispute_id}/settle")
def settle(dispute_id: int, body: ActionIn, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    """The challenger accepts the raiser's amount. The arbitrator then releases the funds on-chain
    (the deployed contract only lets the arbitrator split a disputed milestone)."""
    d, e, job = _get(db, dispute_id, wallet)
    _must_be_party(job, wallet)
    if wallet == d.raised_by:
        raise HTTPException(403, "The other party settles the dispute")
    if d.status != "challenged":
        raise HTTPException(400, "Challenge the dispute first")
    verify_action(wallet, "dispute-settle", f"dispute:{d.id}", str(d6(d.claim_amount)), body)
    payer, payee = _shares(d, e.amount)
    d.payer_share, d.payee_share = payer, payee
    d.status = "settled"
    d.settled_at = datetime.utcnow()
    db.commit()
    return dispute_out(db, d, wallet)


@router.post("/{dispute_id}/arbitrage")
def invite_support(dispute_id: int, body: ActionIn, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    d, e, job = _get(db, dispute_id, wallet)
    _must_be_party(job, wallet)
    if d.status not in ("raised", "challenged"):
        raise HTTPException(400, "Support can only be invited while the dispute is open")
    if datetime.utcnow() < (d.created_at or datetime.utcnow()) + timedelta(days=RESPONSE_DAYS):
        raise HTTPException(400, f"Support can be invited {RESPONSE_DAYS} days after the dispute was raised")
    verify_action(wallet, "dispute-arbitrage", f"dispute:{d.id}", "", body)
    d.status = "arbitrage"
    d.arbitrage_at = datetime.utcnow()
    db.commit()
    return dispute_out(db, d, wallet)


@router.post("/{dispute_id}/resolve")
def resolve(dispute_id: int, payload: ResolveIn, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    """Arbitrator: record the split AFTER calling resolveDispute() on-chain."""
    d, e, job = _get(db, dispute_id, wallet)
    arb = _arbiter()
    if not arb or wallet != arb:
        raise HTTPException(403, "Only the arbitrator can resolve disputes")
    if d.status == "resolved":
        return dispute_out(db, d, wallet)
    payer, payee = d6(payload.payer_share), d6(payload.payee_share)
    if payer + payee != d6(e.amount):
        raise HTTPException(400, "The two shares must add up to the milestone amount")
    if not SKIP_VERIFY and e.onchain_id is not None:
        try:
            if summarize_onchain(e.onchain_id)["status"] not in ("resolved", "released"):
                raise HTTPException(400, "The resolution is not on-chain yet - confirm the transaction first")
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(502, f"Could not read the chain: {exc}")
    d.payer_share, d.payee_share = payer, payee
    d.status = "resolved"
    d.resolved_at = datetime.utcnow()
    d.resolution = payload.note or f"Split: buyer {clean_usdc(payer)} / worker {clean_usdc(payee)} USDC"
    d.winner_address = job.sender_address if payer > payee else (job.receiver_address if payee > payer else None)
    e.status = AgreementStatus.resolved
    db.commit()
    return dispute_out(db, d, wallet)
