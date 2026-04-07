from typing import List, Literal, Optional
from pydantic import BaseModel, Field, model_validator


MAX_ATTEMPTS = 3

SocraticHintTier = Literal["conceptual", "procedural", "structural"]

# The fixed, ordered attempt journey. Prior attempts must arrive in exactly
# this tier order so the server can trust the client's stated position.
TIER_SEQUENCE: tuple[SocraticHintTier, ...] = ("conceptual", "procedural", "structural")


class SocraticPriorAttempt(BaseModel):
    """A single prior attempt the learner made on this step."""

    response: str
    tier: SocraticHintTier
    guidance: str


class SocraticEvaluateRequest(BaseModel):
    """Request to evaluate a learner's attempt at a single Socratic step."""

    assignment_task_uuid: str
    step_uuid: str
    attempt_number: int = Field(ge=1, le=MAX_ATTEMPTS)
    learner_response: str = Field(min_length=1)
    prior_attempts: List[SocraticPriorAttempt] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_attempt_sequence(self):
        for idx, prior in enumerate(self.prior_attempts):
            if idx >= len(TIER_SEQUENCE):
                raise ValueError(
                    f"prior_attempts cannot exceed {MAX_ATTEMPTS - 1} entries"
                )
            if prior.tier != TIER_SEQUENCE[idx]:
                raise ValueError(
                    f"prior_attempts[{idx}] must be tier '{TIER_SEQUENCE[idx]}', "
                    f"got '{prior.tier}'"
                )
        return self


class SocraticEvaluateResponse(BaseModel):
    """Structured verdict for a single attempt.

    The tutor state machine is strict:
      - attempt 1 wrong  -> tier = conceptual
      - attempt 2 wrong  -> tier = procedural
      - attempt 3 wrong  -> tier = structural, worked_solution is revealed, outcome = failed
      - any attempt right -> outcome = success, no further guidance
    """

    step_uuid: str
    attempt_number: int
    is_correct: bool
    outcome: Literal["success", "failed", "in_progress"]
    tier: Optional[SocraticHintTier] = None
    guidance: Optional[str] = None
    worked_solution: Optional[str] = None
    attempts_remaining: int
    assignment_task_submission_uuid: Optional[str] = None
