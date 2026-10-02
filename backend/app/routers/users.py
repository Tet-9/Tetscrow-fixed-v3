import hashlib
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User, Job, Escrow, Dispute, AgreementStatus
from ..schemas import clean_usdc
from .auth import get_current_wallet

router = APIRouter(prefix="/users", tags=["users"])

ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
MAX_NAME = 15
MAX_AVATAR_CHARS = 400_000  # ~300 KB image as a data URL


def default_name(address: str) -> str:
    """Stable default username like 'userFRfbnM' derived from the wallet address."""
    digest = hashlib.sha256(address.lower().encode()).digest()
    return "user" + "".join(ALPHABET[b % len(ALPHABET)] for b in digest[:6])


def profile_of(db: Session, address: str) -> dict:
    address = address.lower()
    u = db.query(User).filter(User.wallet_address == address).first()
    return {
        "address": address,
        "display_name": (u.display_name if u and u.display_name else default_name(address)),
        "avatar": u.avatar if u and u.avatar else None,  # null -> the app draws its default avatar
    }


class ProfileUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=MAX_NAME)
    avatar: str | None = Field(default=None, description="data:image/... URL, or '' to remove")


@router.get("/me")
def get_me(wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    return profile_of(db, wallet)


@router.put("/me")
def update_me(payload: ProfileUpdate, wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    u = db.query(User).filter(User.wallet_address == wallet).first()
    if not u:
        u = User(wallet_address=wallet)
        db.add(u)
    if payload.display_name is not None:
        name = payload.display_name.strip()
        if not name:
            u.display_name = None
        elif len(name) > MAX_NAME:
            raise HTTPException(400, f"Name can be at most {MAX_NAME} characters")
        elif not re.match(r"^[\w .\-]+$", name):
            raise HTTPException(400, "Name can only contain letters, numbers, spaces, dots, dashes and underscores")
        else:
            u.display_name = name
    if payload.avatar is not None:
        if payload.avatar == "":
            u.avatar = None
        elif not payload.avatar.startswith("data:image/") or len(payload.avatar) > MAX_AVATAR_CHARS:
            raise HTTPException(400, "Profile picture must be an image under ~300 KB")
        else:
            u.avatar = payload.avatar
    db.commit()
    return profile_of(db, wallet)


@router.get("/me/stats")
def my_stats(wallet: str = Depends(get_current_wallet), db: Session = Depends(get_db)):
    jobs = db.query(Job).filter((Job.sender_address == wallet) | (Job.receiver_address == wallet)).all()
    job_ids = [j.id for j in jobs]
    escrows = db.query(Escrow).filter(Escrow.job_id.in_(job_ids)).all() if job_ids else []
    paid = sum((e.amount for e in escrows if e.status in (AgreementStatus.released, AgreementStatus.resolved)), 0)
    locked = sum((e.amount for e in escrows if e.status in (AgreementStatus.funded, AgreementStatus.delivered, AgreementStatus.disputed)), 0)
    esc_ids = [e.id for e in escrows]
    disputes = db.query(Dispute).filter(Dispute.escrow_id.in_(esc_ids)).count() if esc_ids else 0
    return {
        "total_paid": clean_usdc(paid),
        "assets_in_escrows": clean_usdc(locked),
        "total_jobs": len(jobs),
        "total_disputes": disputes,
    }


@router.get("/{address}")
def public_profile(address: str, db: Session = Depends(get_db)):
    if not re.match(r"^0x[0-9a-fA-F]{40}$", address):
        raise HTTPException(400, "Invalid address")
    return profile_of(db, address)
