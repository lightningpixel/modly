from fastapi import APIRouter

from services.api_guard import auth_mode

router = APIRouter(tags=["health"])


@router.get("/health")
async def health():
    """Health check — used by Electron to know the API is ready. Unauthenticated on purpose."""
    return {"status": "ok", "auth": auth_mode()}
