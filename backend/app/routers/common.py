"""Helpers shared by the job / milestone / dispute routers."""
import time
from datetime import date, datetime, time as dtime
from decimal import Decimal

from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi import HTTPException
from pydantic import BaseModel, Field

ACTION_WINDOW_MS = 10 * 60 * 1000
RESPONSE_DAYS = 7  # time the other party has to respond to a dispute; support can be invited after it


class ActionIn(BaseModel):
    """Every off-chain action carries a fresh wallet signature (gasless)."""
    ts: int = Field(..., description="client time in ms, part of the signed text")
    signature: str = Field(..., min_length=10, max_length=300)


def action_message(action: str, wallet: str, ref: str, data: str, ts: int) -> str:
    # The frontend builds the exact same text (wallet.js signAction) so the signature can be checked here.
    return f"Tetscrow action: {action}\nWallet: {wallet}\nRef: {ref}\nData: {data}\nTime: {ts}"


def verify_action(wallet: str, action: str, ref: str, data: str, body: ActionIn) -> None:
    if abs(time.time() * 1000 - body.ts) > ACTION_WINDOW_MS:
        raise HTTPException(400, "That signature expired - please try again")
    text = action_message(action, wallet.lower(), ref, data, body.ts)
    try:
        recovered = Account.recover_message(encode_defunct(text=text), signature=body.signature)
    except Exception:
        raise HTTPException(401, "Invalid wallet signature")
    if recovered.lower() != wallet.lower():
        raise HTTPException(401, "Signature does not match your wallet")


def end_of_day(d: date) -> datetime:
    return datetime.combine(d, dtime(23, 59, 59))


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def d6(v) -> Decimal:
    return Decimal(str(v if v is not None else 0)).quantize(Decimal("0.000001"))
