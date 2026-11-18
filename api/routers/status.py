from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health")
async def health():
    """Health check — used by Electron to know the API is ready."""
    # "service" lets Electron tell an old Modly backend from another program on the port.
    return {"status": "ok", "service": "modly"}
