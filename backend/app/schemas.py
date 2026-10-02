from datetime import datetime
from decimal import Decimal
from typing import Optional
import re
from pydantic import BaseModel, Field, field_validator, field_serializer

ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def clean_usdc(value) -> str:
    """USDC has 6 decimals. Never leak the raw 18-decimal column value: quantize to 6 and trim
    trailing zeros ("0.100000000000000000" -> "0.1", "25.000000" -> "25")."""
    d = Decimal(str(value if value is not None else 0)).quantize(Decimal("0.000001"))
    text = format(d, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


class NonceResponse(BaseModel):
    nonce: str


class VerifySignatureRequest(BaseModel):
    wallet_address: str
    signature: str
    message: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class EscrowCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=140)
    description: Optional[str] = Field(default=None, max_length=5000)
    terms_uri: Optional[str] = Field(default=None, max_length=512)
    receiver_address: str
    arbiter_address: Optional[str] = None  # ignored: the on-chain arbitrator is used
    token_address: Optional[str] = None    # USDC on Arc
    amount: Decimal = Field(..., gt=0)
    # Filled in when the on-chain createEscrow tx has already been mined (recommended flow)
    onchain_id: Optional[int] = Field(default=None, ge=1)
    tx_hash: Optional[str] = None

    @field_validator("receiver_address")
    @classmethod
    def _valid_receiver(cls, v: str) -> str:
        if not ADDR_RE.match(v or ""):
            raise ValueError("receiver_address must be a 0x... wallet address")
        return v

    @field_validator("tx_hash")
    @classmethod
    def _valid_tx(cls, v):
        if v is not None and not re.match(r"^0x[0-9a-fA-F]{64}$", v):
            raise ValueError("tx_hash must be a 0x... transaction hash")
        return v


class EscrowOut(BaseModel):
    id: int
    onchain_id: Optional[int]
    tx_hash: Optional[str]
    title: str
    description: Optional[str]
    sender_address: str
    receiver_address: str
    arbiter_address: Optional[str]
    token_address: Optional[str]
    amount: Decimal
    status: str
    created_at: datetime

    class Config:
        from_attributes = True

    @field_serializer("amount")
    def _amount_clean(self, v: Decimal) -> str:
        return clean_usdc(v)


class EscrowConfirm(BaseModel):
    """Called by the frontend once the on-chain tx confirms, to link onchain_id + tx_hash."""
    onchain_id: int = Field(..., ge=1)
    tx_hash: str = Field(..., pattern=r"^0x[0-9a-fA-F]{64}$")


class DisputeCreate(BaseModel):
    escrow_id: int
    reason: str = Field(..., min_length=1, max_length=5000)


class DisputeResolve(BaseModel):
    winner_address: str
    resolution: str = Field(..., min_length=1, max_length=5000)

    @field_validator("winner_address")
    @classmethod
    def _valid_winner(cls, v: str) -> str:
        if not ADDR_RE.match(v or ""):
            raise ValueError("winner_address must be a 0x... wallet address")
        return v


class DisputeOut(BaseModel):
    id: int
    escrow_id: int
    raised_by: str
    reason: str
    resolution: Optional[str]
    winner_address: Optional[str]
    created_at: datetime
    resolved_at: Optional[datetime]

    class Config:
        from_attributes = True


class TokenStats(BaseModel):  # reserved; Tetscrow is USDC-only
    token_address: str
    pair_address: Optional[str]
    price_eth: Optional[str]
    liquidity_eth: Optional[str]
    liquidity_tetscrow: Optional[str]
    note: str = "Live figures read directly from the chain — no numbers here are simulated."
