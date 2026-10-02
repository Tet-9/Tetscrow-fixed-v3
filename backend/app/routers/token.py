from fastapi import APIRouter

router = APIRouter(prefix="/token", tags=["token"])


@router.get("/stats")
def token_stats():
    """Token stats endpoint — reserved for future use. Tetscrow is USDC-only on Arc."""
    return {
        "token_address": None,
        "pair_address": None,
        "price_eth": None,
        "liquidity_eth": None,
        "liquidity_tetscrow": None,
    }
