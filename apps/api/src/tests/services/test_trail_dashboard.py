import asyncio
from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import JSON, event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, Session, create_engine
from starlette.requests import Request

from src.db.courses.activities import Activity, ActivitySubTypeEnum, ActivityTypeEnum
from src.db.courses.assignments import (
    Assignment,
    AssignmentUserSubmission,
    AssignmentUserSubmissionStatus,
    GradingTypeEnum,
)
from src.db.courses.chapter_activities import ChapterActivity
from src.db.courses.chapters import Chapter
from src.db.courses.courses import Course
from src.db.organizations import Organization
from src.db.trail_runs import TrailRun
from src.db.trail_steps import TrailStep
from src.db.trails import Trail
from src.db.users import AnonymousUser, PublicUser, User
from src.services.trail.trail import (
    _estimate_time_spent_minutes,
    get_learner_dashboard,
)


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
def http_request():
    return Request({"type": "http", "headers": [], "method": "GET", "path": "/"})


@pytest.fixture
def seeded_dashboard_data(db: Session):
    now = datetime(2025, 1, 10, 10, 0, 0)

    org = Organization(
        id=1,
        name="Test Org",
        slug="test-org",
        email="test@org.com",
        org_uuid="org_test123",
        creation_date=str(now),
        update_date=str(now),
    )
    user = User(
        id=1,
        username="testuser",
        first_name="Test",
        last_name="User",
        email="test@example.com",
        password="hashed",
        user_uuid="user_test123",
        creation_date=str(now),
        update_date=str(now),
    )
    trail = Trail(
        id=1,
        org_id=org.id,
        user_id=user.id,
        trail_uuid="trail_test123",
        creation_date=str(now),
        update_date=str(now),
    )

    course_started = Course(
        id=1,
        org_id=org.id,
        name="Started Course",
        description="",
        about="",
        learnings="",
        tags="",
        public=False,
        published=True,
        open_to_contributors=False,
        course_uuid="course_started",
        creation_date=str(now),
        update_date=str(now),
    )
    course_untouched = Course(
        id=2,
        org_id=org.id,
        name="Untouched Course",
        description="",
        about="",
        learnings="",
        tags="",
        public=False,
        published=True,
        open_to_contributors=False,
        course_uuid="course_untouched",
        creation_date=str(now),
        update_date=str(now),
    )

    chapter_started = Chapter(
        id=1,
        name="Chapter 1",
        description="",
        thumbnail_image="",
        org_id=org.id,
        course_id=course_started.id,
        chapter_uuid="chapter_started",
        creation_date=str(now),
        update_date=str(now),
    )
    chapter_untouched = Chapter(
        id=2,
        name="Chapter 2",
        description="",
        thumbnail_image="",
        org_id=org.id,
        course_id=course_untouched.id,
        chapter_uuid="chapter_untouched",
        creation_date=str(now),
        update_date=str(now),
    )

    activity_started_a = Activity(
        id=1,
        org_id=org.id,
        course_id=course_started.id,
        name="Activity A",
        activity_type=ActivityTypeEnum.TYPE_CUSTOM,
        activity_sub_type=ActivitySubTypeEnum.SUBTYPE_CUSTOM,
        published=True,
        activity_uuid="activity_started_a",
        creation_date=str(now),
        update_date=str(now),
    )
    activity_started_b = Activity(
        id=2,
        org_id=org.id,
        course_id=course_started.id,
        name="Activity B",
        activity_type=ActivityTypeEnum.TYPE_CUSTOM,
        activity_sub_type=ActivitySubTypeEnum.SUBTYPE_CUSTOM,
        published=True,
        activity_uuid="activity_started_b",
        creation_date=str(now),
        update_date=str(now),
    )
    activity_untouched = Activity(
        id=3,
        org_id=org.id,
        course_id=course_untouched.id,
        name="Activity C",
        activity_type=ActivityTypeEnum.TYPE_ASSIGNMENT,
        activity_sub_type=ActivitySubTypeEnum.SUBTYPE_ASSIGNMENT_ANY,
        published=True,
        activity_uuid="activity_untouched",
        creation_date=str(now),
        update_date=str(now),
    )

    chapter_activities = [
        ChapterActivity(
            id=1,
            order=1,
            chapter_id=chapter_started.id,
            activity_id=activity_started_a.id,
            course_id=course_started.id,
            org_id=org.id,
            creation_date=str(now),
            update_date=str(now),
        ),
        ChapterActivity(
            id=2,
            order=2,
            chapter_id=chapter_started.id,
            activity_id=activity_started_b.id,
            course_id=course_started.id,
            org_id=org.id,
            creation_date=str(now),
            update_date=str(now),
        ),
        ChapterActivity(
            id=3,
            order=1,
            chapter_id=chapter_untouched.id,
            activity_id=activity_untouched.id,
            course_id=course_untouched.id,
            org_id=org.id,
            creation_date=str(now),
            update_date=str(now),
        ),
    ]

    trail_runs = [
        TrailRun(
            id=1,
            trail_id=trail.id,
            course_id=course_started.id,
            org_id=org.id,
            user_id=user.id,
            creation_date=str(now),
            update_date=str(now),
        ),
        TrailRun(
            id=2,
            trail_id=trail.id,
            course_id=course_untouched.id,
            org_id=org.id,
            user_id=user.id,
            creation_date=str(now),
            update_date=str(now),
        ),
    ]

    trail_steps = [
        TrailStep(
            id=1,
            complete=True,
            teacher_verified=False,
            grade="",
            trailrun_id=trail_runs[0].id,
            trail_id=trail.id,
            activity_id=activity_started_a.id,
            course_id=course_started.id,
            org_id=org.id,
            user_id=user.id,
            creation_date="2025-01-10 10:00:00",
            update_date="2025-01-10 10:00:00",
        ),
        TrailStep(
            id=2,
            complete=True,
            teacher_verified=False,
            grade="",
            trailrun_id=trail_runs[0].id,
            trail_id=trail.id,
            activity_id=activity_started_a.id,
            course_id=course_started.id,
            org_id=org.id,
            user_id=user.id,
            creation_date="2025-01-10 10:10:00",
            update_date="2025-01-10 10:10:00",
        ),
        TrailStep(
            id=3,
            complete=True,
            teacher_verified=False,
            grade="",
            trailrun_id=trail_runs[0].id,
            trail_id=trail.id,
            activity_id=activity_started_b.id,
            course_id=course_started.id,
            org_id=org.id,
            user_id=user.id,
            creation_date="2025-01-10 10:40:00",
            update_date="2025-01-10 10:40:00",
        ),
    ]

    assignment_due = Assignment(
        id=1,
        assignment_uuid="assignment_due",
        title="Upcoming Assignment",
        description="",
        due_date="2099-01-12T10:00:00",
        published=True,
        grading_type=GradingTypeEnum.PERCENTAGE,
        org_id=org.id,
        course_id=course_untouched.id,
        chapter_id=chapter_untouched.id,
        activity_id=activity_untouched.id,
        creation_date=str(now),
        update_date=str(now),
    )
    assignment_submitted = Assignment(
        id=2,
        assignment_uuid="assignment_submitted",
        title="Submitted Assignment",
        description="",
        due_date="2099-01-13T10:00:00",
        published=True,
        grading_type=GradingTypeEnum.PERCENTAGE,
        org_id=org.id,
        course_id=course_untouched.id,
        chapter_id=chapter_untouched.id,
        activity_id=activity_untouched.id,
        creation_date=str(now),
        update_date=str(now),
    )
    assignment_past = Assignment(
        id=3,
        assignment_uuid="assignment_past",
        title="Past Assignment",
        description="",
        due_date="2020-01-01T10:00:00",
        published=True,
        grading_type=GradingTypeEnum.PERCENTAGE,
        org_id=org.id,
        course_id=course_untouched.id,
        chapter_id=chapter_untouched.id,
        activity_id=activity_untouched.id,
        creation_date=str(now),
        update_date=str(now),
    )
    submission = AssignmentUserSubmission(
        id=1,
        assignmentusersubmission_uuid="submission_1",
        submission_status=AssignmentUserSubmissionStatus.SUBMITTED,
        grade=100,
        user_id=user.id,
        assignment_id=assignment_submitted.id,
        creation_date=str(now),
        update_date=str(now),
    )

    db.add(org)
    db.add(user)
    db.add(trail)
    db.add(course_started)
    db.add(course_untouched)
    db.add(chapter_started)
    db.add(chapter_untouched)
    db.add(activity_started_a)
    db.add(activity_started_b)
    db.add(activity_untouched)
    for row in chapter_activities + trail_runs + trail_steps:
        db.add(row)
    db.add(assignment_due)
    db.add(assignment_submitted)
    db.add(assignment_past)
    db.add(submission)
    db.commit()

    public_user = PublicUser(
        id=user.id,
        username=user.username,
        first_name=user.first_name,
        last_name=user.last_name,
        email=user.email,
        user_uuid=user.user_uuid,
    )
    return {
        "org": org,
        "user": public_user,
    }


def test_estimate_time_spent_minutes_uses_baseline_and_caps_intervals():
    step_datetimes = [
        datetime(2025, 1, 10, 10, 0, 0),
        datetime(2025, 1, 10, 10, 30, 0),
        datetime(2025, 1, 10, 11, 10, 0),
        datetime(2025, 1, 11, 9, 0, 0),
    ]

    # 10:00 -> 10:30 counts and is capped to 15, longer gaps are ignored,
    # plus 5 minutes baseline for each active day.
    assert _estimate_time_spent_minutes(step_datetimes) == 15


def test_get_learner_dashboard_bounds_completion_and_ignores_untouched_runs(
    db: Session,
    http_request: Request,
    seeded_dashboard_data,
):
    dashboard = asyncio.run(
        get_learner_dashboard(
            request=http_request,
            user=seeded_dashboard_data["user"],
            org_id=seeded_dashboard_data["org"].id,
            db_session=db,
        )
    )

    assert dashboard.total_activities == 3
    assert dashboard.completed_activities == 2
    assert dashboard.overall_completion_percent == 67
    assert dashboard.courses_completed == 1
    assert dashboard.courses_in_progress == 0
    assert dashboard.time_spent_minutes == 25
    assert dashboard.last_activity_date == "2025-01-10"
    assert len(dashboard.recent_activity) == 30


def test_get_learner_dashboard_only_returns_open_unsubmitted_deadlines(
    db: Session,
    http_request: Request,
    seeded_dashboard_data,
):
    dashboard = asyncio.run(
        get_learner_dashboard(
            request=http_request,
            user=seeded_dashboard_data["user"],
            org_id=seeded_dashboard_data["org"].id,
            db_session=db,
        )
    )

    assert [deadline.assignment_uuid for deadline in dashboard.upcoming_deadlines] == [
        "assignment_due"
    ]


def test_get_learner_dashboard_rejects_anonymous_user(
    db: Session, http_request: Request
):
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            get_learner_dashboard(
                request=http_request,
                user=AnonymousUser(),
                org_id=1,
                db_session=db,
            )
        )

    assert exc_info.value.status_code == 401
