import json
from datetime import datetime
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy import JSON, event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, Session, create_engine, select
from starlette.requests import Request

from src.db.courses.activities import Activity, ActivitySubTypeEnum, ActivityTypeEnum
from src.db.courses.assignments import (
    Assignment,
    AssignmentTask,
    AssignmentTaskSubmission,
    AssignmentTaskTypeEnum,
    GradingTypeEnum,
)
from src.db.courses.courses import Course
from src.db.organizations import Organization
from src.db.users import PublicUser
from src.services.ai.schemas.socratic import SocraticEvaluateRequest
from src.services.ai.socratic_tutor import evaluate_socratic_attempt


class _FakeResponse:
    def __init__(self, text: str):
        self.text = text


class _FakeModels:
    def __init__(self, outputs: list[str]):
        self._outputs = outputs

    def generate_content(self, *args, **kwargs):
        if not self._outputs:
            raise AssertionError("No fake tutor outputs remaining")
        return _FakeResponse(self._outputs.pop(0))


class _FakeClient:
    def __init__(self, outputs: list[str]):
        self.models = _FakeModels(outputs)


@pytest.fixture
def engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, connection_record):
        pass

    for table in SQLModel.metadata.tables.values():
        for col in table.columns:
            if isinstance(col.type, JSONB):
                col.type = JSON()

    SQLModel.metadata.create_all(engine)
    return engine


@pytest.fixture
def db(engine):
    with Session(engine) as session:
        yield session


@pytest.fixture
def request():
    return Request({"type": "http", "method": "POST", "path": "/api/v1/ai/socratic/evaluate", "headers": []})


@pytest.fixture
def learner():
    return PublicUser(
        id=7,
        user_uuid="user_test_7",
        username="learner",
        first_name="Test",
        last_name="Learner",
        email="learner@example.com",
        avatar_image="",
        bio="",
        details={},
        profile={},
        email_verified=True,
        is_superadmin=False,
        signup_method="password",
    )


@pytest.fixture
def assignment_task(db: Session):
    now = str(datetime.now())

    org = Organization(
        id=1,
        name="Tutor Org",
        slug="tutor-org",
        email="org@example.com",
        org_uuid="org_tutor",
        creation_date=now,
        update_date=now,
    )
    db.add(org)

    course = Course(
        id=1,
        name="Tutor Course",
        description="",
        public=True,
        published=True,
        open_to_contributors=False,
        org_id=org.id,
        course_uuid="course_tutor",
        creation_date=now,
        update_date=now,
    )
    db.add(course)

    activity = Activity(
        id=1,
        org_id=org.id,
        course_id=course.id,
        name="Assignment Activity",
        activity_type=ActivityTypeEnum.TYPE_ASSIGNMENT,
        activity_sub_type=ActivitySubTypeEnum.SUBTYPE_ASSIGNMENT_ANY,
        content={},
        details={},
        published=True,
        activity_uuid="activity_tutor",
        creation_date=now,
        update_date=now,
    )
    db.add(activity)

    assignment = Assignment(
        id=1,
        title="Tutor Assignment",
        description="",
        due_date=now,
        published=True,
        grading_type=GradingTypeEnum.NUMERIC,
        org_id=org.id,
        course_id=course.id,
        chapter_id=1,
        activity_id=activity.id,
        assignment_uuid="assignment_tutor",
        creation_date=now,
        update_date=now,
    )
    db.add(assignment)

    task = AssignmentTask(
        id=1,
        title="Tutor Step",
        description="",
        hint="",
        assignment_type=AssignmentTaskTypeEnum.SOCRATIC_PROBLEM,
        contents={
            "problem": {
                "problemStatement": "Solve the equation.",
                "learningObjective": "Understand balancing equations.",
                "tutorEnabled": True,
                "steps": [
                    {
                        "stepUUID": "step_1",
                        "guidingQuestion": "What operation isolates x?",
                        "expectedInsight": "Subtract 3 from both sides before dividing.",
                        "workedSolution": "Subtract 3 from both sides, then divide by 2 to get x = 4.",
                        "hint": "",
                    }
                ],
            }
        },
        max_grade_value=100,
        assignment_task_uuid="task_tutor",
        creation_date=now,
        update_date=now,
        assignment_id=assignment.id,
        org_id=org.id,
        course_id=course.id,
        chapter_id=1,
        activity_id=activity.id,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def _submission_for(db: Session, task_id: int, user_id: int) -> AssignmentTaskSubmission:
    statement = select(AssignmentTaskSubmission).where(
        AssignmentTaskSubmission.assignment_task_id == task_id,
        AssignmentTaskSubmission.user_id == user_id,
    )
    return db.exec(statement).one()


@pytest.mark.asyncio
async def test_socratic_tutor_persists_progression_and_final_reveal(db: Session, request: Request, learner: PublicUser, assignment_task: AssignmentTask):
    outputs = [
        json.dumps({"is_correct": False, "guidance": "Revisit the core balancing idea."}),
        json.dumps({"is_correct": False, "guidance": "First undo the constant term, then undo the coefficient."}),
        json.dumps({"is_correct": False, "guidance": "Set it up as x = (11 - 3) / 2, then simplify."}),
    ]

    with patch("src.services.ai.socratic_tutor.check_resource_access", new=AsyncMock()), \
         patch("src.services.ai.socratic_tutor.check_ai_credits"), \
         patch("src.services.ai.socratic_tutor.deduct_ai_credit"), \
         patch("src.services.ai.socratic_tutor.get_gemini_client", return_value=_FakeClient(outputs)):
        first = await evaluate_socratic_attempt(
            request,
            SocraticEvaluateRequest(
                assignment_task_uuid=assignment_task.assignment_task_uuid,
                step_uuid="step_1",
                attempt_number=1,
                learner_response="Maybe divide first?",
                prior_attempts=[],
            ),
            learner,
            db,
        )
        second = await evaluate_socratic_attempt(
            request,
            SocraticEvaluateRequest(
                assignment_task_uuid=assignment_task.assignment_task_uuid,
                step_uuid="step_1",
                attempt_number=2,
                learner_response="I should divide by 2 before changing anything else.",
                prior_attempts=[],
            ),
            learner,
            db,
        )
        third = await evaluate_socratic_attempt(
            request,
            SocraticEvaluateRequest(
                assignment_task_uuid=assignment_task.assignment_task_uuid,
                step_uuid="step_1",
                attempt_number=3,
                learner_response="x = 11 / 2 - 3",
                prior_attempts=[],
            ),
            learner,
            db,
        )

    assert first.outcome == "in_progress"
    assert first.tier == "conceptual"
    assert first.worked_solution is None

    assert second.outcome == "in_progress"
    assert second.tier == "procedural"
    assert second.worked_solution is None

    assert third.outcome == "failed"
    assert third.tier == "structural"
    assert third.worked_solution == "Subtract 3 from both sides, then divide by 2 to get x = 4."

    submission = _submission_for(db, assignment_task.id, learner.id)
    step_entry = submission.task_submission["responses"][0]
    assert step_entry["tutor"]["outcome"] == "failed"
    assert len(step_entry["tutor"]["attempts"]) == 3
    assert step_entry["tutor"]["attempts"][0]["tier"] == "conceptual"
    assert step_entry["tutor"]["attempts"][1]["tier"] == "procedural"
    assert step_entry["tutor"]["attempts"][2]["tier"] == "structural"
    assert step_entry["tutor"]["workedSolution"] == third.worked_solution


@pytest.mark.asyncio
async def test_socratic_tutor_blocks_attempts_after_success(db: Session, request: Request, learner: PublicUser, assignment_task: AssignmentTask):
    outputs = [json.dumps({"is_correct": True, "guidance": None})]

    with patch("src.services.ai.socratic_tutor.check_resource_access", new=AsyncMock()), \
         patch("src.services.ai.socratic_tutor.check_ai_credits"), \
         patch("src.services.ai.socratic_tutor.deduct_ai_credit"), \
         patch("src.services.ai.socratic_tutor.get_gemini_client", return_value=_FakeClient(outputs)):
        result = await evaluate_socratic_attempt(
            request,
            SocraticEvaluateRequest(
                assignment_task_uuid=assignment_task.assignment_task_uuid,
                step_uuid="step_1",
                attempt_number=1,
                learner_response="Subtract 3 from both sides first.",
                prior_attempts=[],
            ),
            learner,
            db,
        )

        assert result.outcome == "success"
        assert result.worked_solution is None

        with pytest.raises(HTTPException) as exc_info:
            await evaluate_socratic_attempt(
                request,
                SocraticEvaluateRequest(
                    assignment_task_uuid=assignment_task.assignment_task_uuid,
                    step_uuid="step_1",
                    attempt_number=2,
                    learner_response="Trying again anyway",
                    prior_attempts=[],
                ),
                learner,
                db,
            )

    assert exc_info.value.status_code == 409


@pytest.mark.asyncio
async def test_socratic_tutor_rejects_stale_client_attempt_numbers(db: Session, request: Request, learner: PublicUser, assignment_task: AssignmentTask):
    outputs = [json.dumps({"is_correct": False, "guidance": "Think about undoing addition before multiplication."})]

    with patch("src.services.ai.socratic_tutor.check_resource_access", new=AsyncMock()), \
         patch("src.services.ai.socratic_tutor.check_ai_credits"), \
         patch("src.services.ai.socratic_tutor.deduct_ai_credit"), \
         patch("src.services.ai.socratic_tutor.get_gemini_client", return_value=_FakeClient(outputs)):
        await evaluate_socratic_attempt(
            request,
            SocraticEvaluateRequest(
                assignment_task_uuid=assignment_task.assignment_task_uuid,
                step_uuid="step_1",
                attempt_number=1,
                learner_response="Wrong first try",
                prior_attempts=[],
            ),
            learner,
            db,
        )

        with pytest.raises(HTTPException) as exc_info:
            await evaluate_socratic_attempt(
                request,
                SocraticEvaluateRequest(
                    assignment_task_uuid=assignment_task.assignment_task_uuid,
                    step_uuid="step_1",
                    attempt_number=1,
                    learner_response="Still pretending this is attempt one",
                    prior_attempts=[],
                ),
                learner,
                db,
            )

    assert exc_info.value.status_code == 409
