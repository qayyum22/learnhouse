import json
import logging
from typing import Optional
from datetime import datetime
from uuid import uuid4

from fastapi import HTTPException, Request
from pydantic import BaseModel, ValidationError
from sqlmodel import Session, select

from src.db.courses.assignments import AssignmentTask, Assignment, AssignmentTaskSubmission
from src.db.courses.courses import Course
from src.db.users import PublicUser, AnonymousUser
from src.security.rbac import AccessAction, check_resource_access
from src.security.features_utils.usage import check_ai_credits, deduct_ai_credit
from src.services.ai.base import get_gemini_client
from src.services.ai.schemas.socratic import (
    MAX_ATTEMPTS,
    TIER_SEQUENCE,
    SocraticEvaluateRequest,
    SocraticEvaluateResponse,
    SocraticHintTier,
    SocraticPriorAttempt,
)

logger = logging.getLogger(__name__)

# Maps the 1-indexed failed-attempt number to the scaffolding tier the tutor
# must produce. The ordering is pedagogical: each tier is strictly more
# explicit than the last but never the full answer.
TIER_FOR_ATTEMPT: dict[int, SocraticHintTier] = {
    i + 1: tier for i, tier in enumerate(TIER_SEQUENCE)
}


class TutorModelVerdict(BaseModel):
    """Typed contract for the model's JSON response. Anything that fails to
    validate against this is treated as a transport error and no credit is
    deducted."""

    is_correct: bool
    guidance: Optional[str] = None


class TutorInvalidResponseError(Exception):
    """Raised when the model returns malformed or contract-violating output."""

TIER_INSTRUCTIONS: dict[SocraticHintTier, str] = {
    "conceptual": (
        "Give CONCEPTUAL guidance only. Name the underlying idea, principle, or "
        "definition the learner should reconsider. Do NOT describe what to do; "
        "do NOT reference the answer. 1-2 short sentences."
    ),
    "procedural": (
        "Give PROCEDURAL guidance. Describe the general method or sequence of "
        "operations the learner should apply, as a short ordered scaffold. "
        "Do NOT compute values or state the result. 2-3 short sentences."
    ),
    "structural": (
        "Give a STRUCTURAL hint. Show the shape of the answer — the set-up, "
        "the equation to solve, or the template to fill — with the final value "
        "or conclusion still blanked out. This is the last hint before the "
        "worked solution is revealed, so it may be very explicit, but it must "
        "still stop short of the final answer."
    ),
}


def _load_step(
    request: Request,
    db_session: Session,
    current_user: PublicUser | AnonymousUser,
    assignment_task_uuid: str,
    step_uuid: str,
) -> tuple[AssignmentTask, dict, dict, int, str]:
    """Resolve the task + step. Returns (task, problem, step, org_id, course_uuid)."""
    statement = select(AssignmentTask).where(
        AssignmentTask.assignment_task_uuid == assignment_task_uuid
    )
    task = db_session.exec(statement).first()
    if not task:
        raise HTTPException(status_code=404, detail="Assignment task not found")

    statement = select(Assignment).where(Assignment.id == task.assignment_id)
    assignment = db_session.exec(statement).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    statement = select(Course).where(Course.id == assignment.course_id)
    course = db_session.exec(statement).first()
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")

    problem = (task.contents or {}).get("problem") or {}
    steps = problem.get("steps") or []
    step = next((s for s in steps if s.get("stepUUID") == step_uuid), None)
    if not step:
        raise HTTPException(status_code=404, detail="Socratic step not found")

    # The tutor cannot grade — or safely reveal a solution on terminal failure —
    # without authored ground truth. Refuse to run rather than degrade.
    missing = [
        field
        for field in ("guidingQuestion", "expectedInsight", "workedSolution")
        if not (isinstance(step.get(field), str) and step.get(field).strip())
    ]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=(
                "Socratic step is missing required authored content: "
                f"{', '.join(missing)}. The author must supply these before the "
                "tutor can evaluate attempts."
            ),
        )

    return task, problem, step, assignment.org_id, course.course_uuid


def _empty_tutor_state() -> dict:
    return {"attempts": [], "outcome": "pending", "workedSolution": None}


def _find_submission_for_user(
    db_session: Session, assignment_task_id: int, user_id: int
) -> Optional[AssignmentTaskSubmission]:
    statement = select(AssignmentTaskSubmission).where(
        AssignmentTaskSubmission.assignment_task_id == assignment_task_id,
        AssignmentTaskSubmission.user_id == user_id,
    )
    return db_session.exec(statement).first()


def _get_or_create_step_entry(task_submission: dict, problem: dict, step_uuid: str) -> dict:
    task_submission.setdefault("problem", problem)
    responses = task_submission.setdefault("responses", [])
    entry = next((r for r in responses if r.get("stepUUID") == step_uuid), None)
    if entry is None:
        entry = {
            "stepUUID": step_uuid,
            "response": "",
            "hintUsed": False,
            "tutor": _empty_tutor_state(),
        }
        responses.append(entry)
    entry.setdefault("tutor", _empty_tutor_state())
    entry["tutor"].setdefault("attempts", [])
    entry["tutor"].setdefault("outcome", "pending")
    entry["tutor"].setdefault("workedSolution", None)
    return entry


def _build_prompt(
    problem: dict,
    step: dict,
    req: SocraticEvaluateRequest,
    tier: SocraticHintTier,
) -> str:
    prior = "\n".join(
        f"- Attempt {i + 1} ({p.tier}): learner wrote \"{p.response}\"; tutor replied \"{p.guidance}\""
        for i, p in enumerate(req.prior_attempts)
    ) or "- (none)"

    return f"""You are a strict Socratic tutor. You are evaluating ONE attempt at ONE step
of a guided problem. You must decide whether the learner's response demonstrates
the expected insight, and — only if it does not — produce exactly one piece of
guidance at the specified scaffolding tier. You never reveal the final answer in
guidance. You are pedagogical, not conversational: no praise, no chit-chat, no
questions back to the learner.

PROBLEM
Learning objective: {problem.get("learningObjective") or "(not specified)"}
Problem statement: {problem.get("problemStatement") or "(not specified)"}

CURRENT STEP
Guiding question: {step["guidingQuestion"]}
Expected insight (the model answer you are grading against — the learner cannot see this):
{step["expectedInsight"]}
Author hint (optional context): {step.get("hint") or "(none)"}

ATTEMPT JOURNEY SO FAR
{prior}

THIS ATTEMPT
Attempt number: {req.attempt_number} of {MAX_ATTEMPTS}
Learner response:
\"\"\"{req.learner_response}\"\"\"

SCAFFOLDING TIER FOR THIS ATTEMPT (use ONLY if the response is incorrect)
Tier: {tier}
Instruction: {TIER_INSTRUCTIONS[tier]}

GRADING RULE
Mark is_correct = true only if the learner's response captures the substance of the
expected insight. Partial credit that misses the core idea is incorrect.

OUTPUT
Respond with a single JSON object and nothing else:
{{
  "is_correct": <true|false>,
  "guidance": <string — required when is_correct is false, otherwise null>
}}"""


def _parse_model_verdict(text: str) -> TutorModelVerdict:
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1:
        raise TutorInvalidResponseError("No JSON object found in model output")
    try:
        raw = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError as e:
        raise TutorInvalidResponseError(f"Model output was not valid JSON: {e}")
    if "is_correct" not in raw:
        raise TutorInvalidResponseError("Model output missing required key 'is_correct'")
    try:
        verdict = TutorModelVerdict.model_validate(raw)
    except ValidationError as e:
        raise TutorInvalidResponseError(f"Model output failed schema validation: {e}")
    if not verdict.is_correct and not (verdict.guidance and verdict.guidance.strip()):
        raise TutorInvalidResponseError(
            "Model output marked incorrect but supplied no guidance"
        )
    return verdict


async def evaluate_socratic_attempt(
    request: Request,
    payload: SocraticEvaluateRequest,
    current_user: PublicUser | AnonymousUser,
    db_session: Session,
) -> SocraticEvaluateResponse:
    task, problem, step, org_id, course_uuid = _load_step(
        request, db_session, current_user, payload.assignment_task_uuid, payload.step_uuid
    )

    await check_resource_access(
        request, db_session, current_user, course_uuid, AccessAction.READ
    )

    existing_submission = _find_submission_for_user(db_session, int(task.id), current_user.id)
    task_submission = (
        dict(existing_submission.task_submission)
        if existing_submission and isinstance(existing_submission.task_submission, dict)
        else {"problem": problem, "responses": []}
    )
    step_entry = _get_or_create_step_entry(task_submission, problem, payload.step_uuid)
    tutor_state = step_entry["tutor"]
    attempts = tutor_state.get("attempts", [])
    outcome = tutor_state.get("outcome", "pending")

    if outcome in {"success", "failed"}:
        raise HTTPException(
            status_code=409,
            detail="This Socratic step is already in a terminal state. Reload to continue.",
        )

    attempt_number = len(attempts) + 1
    if payload.attempt_number != attempt_number:
        raise HTTPException(
            status_code=409,
            detail=(
                f"This step is currently on attempt {attempt_number}. "
                "Reload to continue from the latest tutor state."
            ),
        )

    prior_attempts = [
        SocraticPriorAttempt(
            response=attempt["response"],
            tier=attempt["tier"],
            guidance=attempt["guidance"],
        )
        for attempt in attempts
        if not attempt.get("correct")
        and attempt.get("tier") in TIER_SEQUENCE
        and isinstance(attempt.get("guidance"), str)
        and attempt.get("guidance", "").strip()
    ]
    normalized_payload = payload.model_copy(
        update={
            "attempt_number": attempt_number,
            "prior_attempts": prior_attempts,
        }
    )

    # Verify credits are available before calling the model, but only deduct
    # after a valid verdict has been parsed so transport / parsing failures
    # never cost the org anything.
    check_ai_credits(org_id, db_session)

    tier = TIER_FOR_ATTEMPT[attempt_number]
    is_final_attempt = attempt_number == MAX_ATTEMPTS

    prompt = _build_prompt(problem, step, normalized_payload, tier)

    try:
        client = get_gemini_client()
        from google.genai.types import GenerateContentConfig

        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[{"role": "user", "parts": [{"text": prompt}]}],
            config=GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0.2,
            ),
        )
        verdict = _parse_model_verdict(response.text or "")
    except TutorInvalidResponseError as e:
        logger.error("Socratic tutor produced an invalid verdict: %s", e)
        raise HTTPException(
            status_code=502,
            detail=(
                "The tutor returned an invalid response and the attempt was not "
                "recorded. No credit was charged. Please retry."
            ),
        )
    except HTTPException:
        raise
    except Exception:
        logger.exception("Socratic tutor model call failed")
        raise HTTPException(
            status_code=502,
            detail=(
                "The tutor could not be reached and the attempt was not recorded. "
                "No credit was charged. Please retry."
            ),
        )

    deduct_ai_credit(org_id, db_session)

    recorded_attempt = {
        "response": payload.learner_response,
        "correct": verdict.is_correct,
        "tier": verdict.tier,
        "guidance": verdict.guidance,
    }
    attempts.append(recorded_attempt)
    step_entry["response"] = payload.learner_response

    if verdict.is_correct:
        tutor_state["outcome"] = "success"
        tutor_state["workedSolution"] = None
    elif is_final_attempt:
        tutor_state["outcome"] = "failed"
        tutor_state["workedSolution"] = step["workedSolution"]
    else:
        tutor_state["outcome"] = "pending"
        tutor_state["workedSolution"] = None

    if existing_submission:
        existing_submission.task_submission = task_submission
        existing_submission.update_date = str(datetime.now())
        db_session.add(existing_submission)
        db_session.commit()
        db_session.refresh(existing_submission)
        assignment_task_submission_uuid = existing_submission.assignment_task_submission_uuid
    else:
        current_time = str(datetime.now())
        created_submission = AssignmentTaskSubmission(
            assignment_task_submission_uuid=f"assignmenttasksubmission_{uuid4()}",
            task_submission=task_submission,
            grade=0,
            task_submission_grade_feedback="",
            assignment_task_id=int(task.id),
            assignment_type=task.assignment_type,
            activity_id=task.activity_id,
            course_id=task.course_id,
            chapter_id=task.chapter_id,
            user_id=current_user.id,
            creation_date=current_time,
            update_date=current_time,
        )
        db_session.add(created_submission)
        db_session.commit()
        db_session.refresh(created_submission)
        assignment_task_submission_uuid = created_submission.assignment_task_submission_uuid

    if verdict.is_correct:
        return SocraticEvaluateResponse(
            step_uuid=payload.step_uuid,
            attempt_number=attempt_number,
            is_correct=True,
            outcome="success",
            tier=None,
            guidance=None,
            worked_solution=None,
            attempts_remaining=MAX_ATTEMPTS - attempt_number,
            assignment_task_submission_uuid=assignment_task_submission_uuid,
        )

    worked_solution: Optional[str] = None
    outcome = "in_progress"
    if is_final_attempt:
        outcome = "failed"
        # Always the author's worked solution — never model-generated, never
        # the grading rubric (expectedInsight). Presence was enforced in
        # _load_step, so this cannot silently degrade.
        worked_solution = step["workedSolution"]

    return SocraticEvaluateResponse(
        step_uuid=payload.step_uuid,
        attempt_number=attempt_number,
        is_correct=False,
        outcome=outcome,
        tier=tier,
        guidance=verdict.guidance,
        worked_solution=worked_solution,
        attempts_remaining=MAX_ATTEMPTS - attempt_number,
        assignment_task_submission_uuid=assignment_task_submission_uuid,
    )
