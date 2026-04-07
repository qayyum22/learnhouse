from fastapi import APIRouter, Depends, Request
from sqlmodel import Session

from src.core.events.database import get_db_session
from src.db.users import PublicUser
from src.security.auth import get_current_user
from src.services.ai.schemas.socratic import (
    SocraticEvaluateRequest,
    SocraticEvaluateResponse,
)
from src.services.ai.socratic_tutor import evaluate_socratic_attempt

router = APIRouter()


@router.post("/socratic/evaluate")
async def api_socratic_evaluate(
    request: Request,
    payload: SocraticEvaluateRequest,
    current_user: PublicUser = Depends(get_current_user),
    db_session: Session = Depends(get_db_session),
) -> SocraticEvaluateResponse:
    """Evaluate a single learner attempt at a Socratic step and return tiered guidance."""
    return await evaluate_socratic_attempt(request, payload, current_user, db_session)
