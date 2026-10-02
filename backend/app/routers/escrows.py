import os
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Escrow, AgreementStatus
from ..schemas import EscrowCreate, EscrowOut, EscrowConfirm
from .auth import get_current_wallet
from ..web3_client import summarize_onchain, read_arbitrator

router = APIRouter(prefix="/escrows", tags=["escrows"])

SKIP_VERIFY = os.getenv("SKIP_ONCHAIN_VERIFY", "0") == "1"


def _verify_onchain(onchain_id: int, sender: str, receiver: str) -> dict | None:
    """Make sure the on-chain escrow really belongs to this sender/receiver.
    Returns the on-chain summary (or None when verification is disabled for dev)."""
    if SKIP_VERIFY:
        return None
    try:
        summary = summarize_onchain(onchain_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc))
    except Exception as exc:
        raise HTTPException(502, f"Could not read the escrow from the chain yet: {exc}")
    if summary["escrow"]["payer"] != sender:
        raise HTTPException(403, "You are not the payer of this on-chain escrow")
    if summary["escrow"]["payee"] != receiver:
        raise HTTPException(400, "Receiver does not match the on-chain escrow")
    return summary


def _arbiter_or_none() -> str | None:
    try:
        return read_arbitrator()
    except Exception:
        return None


def _apply_onchain(escrow: Escrow, tx_hash: str | None, onchain_id: int, summary: dict | None) -> None:
    escrow.onchain_id = onchain_id
    if tx_hash:
        escrow.tx_hash = tx_hash
    if summary:
        escrow.status = AgreementStatus(summary["status"])
        escrow.amount = Decimal(summary["total_usdc"])
        escrow.arbiter_address = escrow.arbiter_address or _arbiter_or_none()
    else:
        escrow.status = AgreementStatus.funded


@router.post("", response_model=EscrowOut)
def create_escrow(
    payload: EscrowCreate,
    wallet: str = Depends(get_current_wallet),
    db: Session = Depends(get_db),
):
    """Store the off-chain metadata for an escrow.

    Recommended flow: the user's wallet first sends the on-chain createEscrow() tx (this
    backend never holds funds or keys), then the frontend calls this endpoint with
    onchain_id + tx_hash so a record can never exist without funds behind it.
    Without onchain_id a 'created' (unfunded) record is stored and /confirm links it later."""
    receiver = payload.receiver_address.lower()
    if receiver == wallet:
        raise HTTPException(400, "Sender and receiver must be different wallets")

    escrow = Escrow(
        title=payload.title,
        description=payload.description,
        terms_uri=payload.terms_uri,
        sender_address=wallet,
        receiver_address=receiver,
        token_address=(payload.token_address or "").lower() or None,
        amount=payload.amount,
        status=AgreementStatus.created,
    )

    if payload.onchain_id is not None:
        existing = db.query(Escrow).filter(Escrow.onchain_id == payload.onchain_id).first()
        if existing:
            # Idempotent retry by the same sender; otherwise a conflict.
            if existing.sender_address == wallet:
                return existing
            raise HTTPException(409, "This on-chain escrow is already registered")
        summary = _verify_onchain(payload.onchain_id, wallet, receiver)
        _apply_onchain(escrow, payload.tx_hash, payload.onchain_id, summary)

    db.add(escrow)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "This on-chain escrow is already registered")
    db.refresh(escrow)
    return escrow


@router.post("/{escrow_id}/confirm", response_model=EscrowOut)
def confirm_escrow(
    escrow_id: int,
    payload: EscrowConfirm,
    wallet: str = Depends(get_current_wallet),
    db: Session = Depends(get_db),
):
    escrow = db.get(Escrow, escrow_id)
    if not escrow:
        raise HTTPException(404, "Escrow not found")
    if escrow.sender_address != wallet:
        raise HTTPException(403, "Only the sender can confirm this escrow")
    clash = db.query(Escrow).filter(Escrow.onchain_id == payload.onchain_id, Escrow.id != escrow.id).first()
    if clash:
        raise HTTPException(409, "This on-chain escrow is already registered")

    summary = _verify_onchain(payload.onchain_id, wallet, escrow.receiver_address)
    _apply_onchain(escrow, payload.tx_hash, payload.onchain_id, summary)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "This on-chain escrow is already registered")
    db.refresh(escrow)
    return escrow


@router.get("/mine", response_model=list[EscrowOut])
def my_escrows(
    wallet: str = Depends(get_current_wallet),
    db: Session = Depends(get_db),
):
    return (
        db.query(Escrow)
        .filter((Escrow.sender_address == wallet) | (Escrow.receiver_address == wallet))
        .order_by(Escrow.created_at.desc())
        .all()
    )


@router.get("/{escrow_id}", response_model=EscrowOut)
def get_escrow(escrow_id: int, sync: bool = False, db: Session = Depends(get_db)):
    escrow = db.get(Escrow, escrow_id)
    if not escrow:
        raise HTTPException(404, "Escrow not found")

    if sync and escrow.onchain_id is not None:
        # Re-sync status from the live contract so the UI always shows the truth.
        try:
            summary = summarize_onchain(escrow.onchain_id)
            escrow.status = AgreementStatus(summary["status"])
            db.commit()
            db.refresh(escrow)
        except Exception as exc:
            db.rollback()
            print(f"[sync] on-chain read failed for escrow {escrow_id}: {exc}")

    return escrow
