import enum
from datetime import datetime

from sqlalchemy import Column, Integer, String, DateTime, Enum, Numeric, Text, BigInteger, LargeBinary
from .database import Base


class AgreementStatus(str, enum.Enum):
    created = "created"
    funded = "funded"
    delivered = "delivered"
    released = "released"
    disputed = "disputed"
    resolved = "resolved"
    cancelled = "cancelled"


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    wallet_address = Column(String(42), unique=True, index=True, nullable=False)
    display_name = Column(String(64), nullable=True)
    avatar = Column(Text, nullable=True)  # small image as a data: URL
    reputation_score = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


class Job(Base):
    """A job/agreement between a buyer (sender) and a worker (receiver). Every milestone of a job is
    funded by its own on-chain Tetscrow escrow (one Escrow row per milestone)."""

    __tablename__ = "jobs"
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(140), nullable=False)
    description = Column(Text, nullable=True)
    terms_uri = Column(String(512), nullable=True)
    sender_address = Column(String(42), index=True, nullable=False)
    receiver_address = Column(String(42), index=True, nullable=False)
    secondary_address = Column(String(42), nullable=True)  # buyer's optional backup wallet (off-chain note)
    created_at = Column(DateTime, default=datetime.utcnow)


class Escrow(Base):
    """Off-chain mirror of ONE on-chain Tetscrow escrow = ONE milestone of a Job, plus UI metadata."""

    __tablename__ = "escrows"
    id = Column(Integer, primary_key=True, index=True)
    onchain_id = Column(BigInteger, unique=True, index=True, nullable=True)  # null until confirmed on-chain
    tx_hash = Column(String(66), nullable=True)

    title = Column(String(140), nullable=False)
    description = Column(Text, nullable=True)
    terms_uri = Column(String(512), nullable=True)

    sender_address = Column(String(42), index=True, nullable=False)
    receiver_address = Column(String(42), index=True, nullable=False)
    arbiter_address = Column(String(42), nullable=True)

    token_address = Column(String(42), nullable=True)  # USDC on Arc
    amount = Column(Numeric(38, 6), nullable=False)  # USDC has 6 decimals

    status = Column(Enum(AgreementStatus), default=AgreementStatus.created, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # --- job / milestone fields ---
    job_id = Column(Integer, index=True, nullable=True)
    milestone_no = Column(Integer, nullable=True)
    milestone_description = Column(Text, nullable=True)
    deadline_at = Column(DateTime, nullable=True)               # per-milestone deadline (off-chain)
    extension_requested_at = Column(DateTime, nullable=True)    # worker's requested new deadline
    accepted_at = Column(DateTime, nullable=True)               # worker accepted this milestone
    accepted_sig = Column(String(200), nullable=True)


class Dispute(Base):
    __tablename__ = "disputes"
    id = Column(Integer, primary_key=True, index=True)
    escrow_id = Column(Integer, index=True, nullable=False)
    raised_by = Column(String(42), nullable=False)
    reason = Column(Text, nullable=False)
    resolution = Column(Text, nullable=True)
    winner_address = Column(String(42), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    resolved_at = Column(DateTime, nullable=True)

    # --- dispute flow ---
    category = Column(String(40), nullable=True)       # unresponsiveness | work_quality | deadline_passed
    status = Column(String(20), default="raised")      # raised | challenged | settled | arbitrage | resolved
    claimant_role = Column(String(8), nullable=True)   # payer | payee (who raised it)
    claim_amount = Column(Numeric(38, 6), nullable=True)  # what the raiser asks for (refund if payer, payment if payee)
    challenged_at = Column(DateTime, nullable=True)
    settled_at = Column(DateTime, nullable=True)
    arbitrage_at = Column(DateTime, nullable=True)
    payer_share = Column(Numeric(38, 6), nullable=True)   # final split (set by settle / arbitrator)
    payee_share = Column(Numeric(38, 6), nullable=True)


class Message(Base):
    """Job chat. A message is text, a file, or both."""

    __tablename__ = "messages"
    id = Column(Integer, primary_key=True, index=True)
    job_id = Column(Integer, index=True, nullable=False)
    sender_address = Column(String(42), nullable=False)
    body = Column(Text, nullable=True)
    file_name = Column(String(255), nullable=True)
    file_size = Column(Integer, nullable=True)
    file_data = Column(LargeBinary, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    read_at = Column(DateTime, nullable=True)
