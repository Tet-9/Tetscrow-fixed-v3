import os
from functools import lru_cache

from web3 import Web3

RPC_URL = os.getenv("RPC_URL", "https://rpc.testnet.arc.io")
RPC_URL_FALLBACK = os.getenv("RPC_URL_FALLBACK", "")
TETSCROW_ESCROW_ADDRESS = os.getenv("TETSCROW_ESCROW_ADDRESS", "").strip()
CHAIN_ID = int(os.getenv("CHAIN_ID", "5042002"))

ESCROW_ABI = [
    {
        "inputs": [{"internalType": "uint256", "name": "escrowId", "type": "uint256"}],
        "name": "getEscrow",
        "outputs": [
            {"internalType": "address", "name": "payer", "type": "address"},
            {"internalType": "address", "name": "payee", "type": "address"},
            {"internalType": "uint40", "name": "deadline", "type": "uint40"},
            {"internalType": "uint8", "name": "status", "type": "uint8"},
            {"internalType": "bool", "name": "payerCancelIntent", "type": "bool"},
            {"internalType": "bool", "name": "payeeCancelIntent", "type": "bool"},
            {"internalType": "uint256", "name": "milestoneCount", "type": "uint256"},
        ],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"internalType": "uint256", "name": "escrowId", "type": "uint256"},
            {"internalType": "uint256", "name": "milestoneId", "type": "uint256"},
        ],
        "name": "getMilestone",
        "outputs": [
            {"internalType": "bytes32", "name": "descriptionHash", "type": "bytes32"},
            {"internalType": "uint256", "name": "amount", "type": "uint256"},
            {"internalType": "uint8", "name": "status", "type": "uint8"},
            {"internalType": "uint40", "name": "deliveredAt", "type": "uint40"},
        ],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "arbitrator",
        "outputs": [{"internalType": "address", "name": "", "type": "address"}],
        "stateMutability": "view",
        "type": "function",
    },
]

# Solidity enum orders
ESCROW_ACTIVE, ESCROW_COMPLETED, ESCROW_CANCELLED = 0, 1, 2
(M_FUNDED, M_DELIVERED, M_RELEASED, M_DISPUTED, M_REFUNDED, M_RESOLVED) = range(6)

USDC_DECIMALS = 6


def _make_w3(url: str) -> Web3:
    return Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 15}))


@lru_cache
def _providers() -> list[Web3]:
    urls = [u for u in (RPC_URL, RPC_URL_FALLBACK) if u]
    if not urls:
        raise RuntimeError("RPC_URL is not configured in backend/.env")
    return [_make_w3(u) for u in urls]


def _contract(w3: Web3):
    if not TETSCROW_ESCROW_ADDRESS:
        raise RuntimeError("TETSCROW_ESCROW_ADDRESS is not configured in backend/.env")
    return w3.eth.contract(address=Web3.to_checksum_address(TETSCROW_ESCROW_ADDRESS), abi=ESCROW_ABI)


def _call(fn):
    """Run fn(contract) against each configured RPC until one works."""
    last = None
    for w3 in _providers():
        try:
            return fn(_contract(w3))
        except Exception as exc:  # network / RPC error — try the next endpoint
            last = exc
    raise RuntimeError(f"On-chain read failed: {last}")


def read_escrow_onchain(onchain_id: int) -> dict:
    keys = ["payer", "payee", "deadline", "status", "payerCancelIntent", "payeeCancelIntent", "milestoneCount"]
    result = _call(lambda c: c.functions.getEscrow(onchain_id).call())
    data = dict(zip(keys, result))
    data["payer"] = data["payer"].lower()
    data["payee"] = data["payee"].lower()
    return data


def read_milestones_onchain(onchain_id: int, count: int) -> list[dict]:
    out = []
    for i in range(count):
        h, amount, status, delivered_at = _call(lambda c, i=i: c.functions.getMilestone(onchain_id, i).call())
        out.append({"id": i, "amount": amount, "status": status, "delivered_at": delivered_at})
    return out


def read_arbitrator() -> str:
    return _call(lambda c: c.functions.arbitrator().call()).lower()


def summarize_onchain(onchain_id: int) -> dict:
    """Live escrow state + derived off-chain status string + total amount (USDC, str)."""
    esc = read_escrow_onchain(onchain_id)
    if esc["payer"] == "0x0000000000000000000000000000000000000000":
        raise LookupError(f"Escrow {onchain_id} does not exist on-chain")
    ms = read_milestones_onchain(onchain_id, esc["milestoneCount"])
    total_raw = sum(m["amount"] for m in ms)
    statuses = {m["status"] for m in ms}

    if esc["status"] == ESCROW_CANCELLED:
        status = "cancelled"
    elif esc["status"] == ESCROW_COMPLETED:
        status = "resolved" if M_RESOLVED in statuses else "released"
    elif M_DISPUTED in statuses:
        status = "disputed"
    elif M_DELIVERED in statuses:
        status = "delivered"
    else:
        status = "funded"

    return {
        "escrow": esc,
        "milestones": ms,
        "status": status,
        "total_usdc": f"{total_raw / 10**USDC_DECIMALS:.6f}",
    }
