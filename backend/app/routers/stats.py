from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Escrow, Job, User, AgreementStatus
from ..schemas import clean_usdc

router = APIRouter(prefix="/stats", tags=["stats"])


@router.get("")
def platform_stats(db: Session = Depends(get_db)):
    """Live platform stats — counts straight from the database."""
    agreements = db.query(func.count(Job.id)).scalar() or 0
    users = db.query(func.count(User.id)).scalar() or 0
    funds_released = (
        db.query(func.coalesce(func.sum(Escrow.amount), 0))
        .filter(Escrow.status.in_([AgreementStatus.released, AgreementStatus.resolved]))
        .scalar()
    )
    return {
        "agreements_created": agreements,
        "users_registered": users,
        "funds_released_usdc": clean_usdc(funds_released or 0),
    }
