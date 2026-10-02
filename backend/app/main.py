import os
from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import Base, engine, SessionLocal
from .migrate import ensure_columns, backfill_jobs
from .routers import auth, escrows, disputes, token, stats, users, jobs

Base.metadata.create_all(bind=engine)
ensure_columns(engine)
backfill_jobs(SessionLocal)

app = FastAPI(
    title="Tetscrow API",
    description="Backend for the Tetscrow decentralized escrow platform.",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        o.strip()
        for o in os.getenv("FRONTEND_ORIGIN", "http://localhost:5173,http://127.0.0.1:5173").split(",")
        if o.strip()
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(jobs.router)
app.include_router(jobs.milestones)
app.include_router(escrows.router)
app.include_router(disputes.router)
app.include_router(token.router)
app.include_router(stats.router)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "tetscrow-api",
        "escrow_contract": os.getenv("TETSCROW_ESCROW_ADDRESS", "") or None,
        "chain_id": int(os.getenv("CHAIN_ID", "5042002")),
    }
