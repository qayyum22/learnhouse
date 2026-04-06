import asyncio
from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import JSON, event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, Session, create_engine, select
from starlette.requests import Request

from src.db.courses.courses import Course
from src.db.courses.enrollments import CourseEnrollment, CourseEnrollmentStatus
from src.db.organizations import Organization
from src.db.users import PublicUser, User
from src.services.courses import enrollments as enrollment_service


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
def seeded_enrollment_data(db: Session):
    now = datetime(2026, 4, 6, 12, 0, 0)

    org = Organization(
        id=1,
        name="Test Org",
        slug="test-org",
        email="team@test.org",
        org_uuid="org_test",
        creation_date=str(now),
        update_date=str(now),
    )
    instructor = User(
        id=1,
        username="instructor",
        first_name="Course",
        last_name="Owner",
        email="instructor@test.org",
        password="hashed",
        user_uuid="user_instructor",
        creation_date=str(now),
        update_date=str(now),
    )
    learner = User(
        id=2,
        username="learner",
        first_name="Learner",
        last_name="One",
        email="learner@test.org",
        password="hashed",
        user_uuid="user_learner",
        creation_date=str(now),
        update_date=str(now),
    )
    course_private = Course(
        id=1,
        org_id=org.id,
        name="Private Course",
        description="",
        about="",
        learnings="",
        tags="",
        public=False,
        published=True,
        open_to_contributors=False,
        course_uuid="course_private",
        creation_date=str(now),
        update_date=str(now),
    )
    course_public = Course(
        id=2,
        org_id=org.id,
        name="Public Course",
        description="",
        about="",
        learnings="",
        tags="",
        public=True,
        published=True,
        open_to_contributors=False,
        course_uuid="course_public",
        creation_date=str(now),
        update_date=str(now),
    )

    db.add(org)
    db.add(instructor)
    db.add(learner)
    db.add(course_private)
    db.add(course_public)
    db.commit()

    return {
        "org": org,
        "instructor": instructor,
        "learner": learner,
        "course_private": course_private,
        "course_public": course_public,
        "public_instructor": PublicUser(
            id=instructor.id,
            username=instructor.username,
            first_name=instructor.first_name,
            last_name=instructor.last_name,
            email=instructor.email,
            avatar_image=instructor.avatar_image,
            bio=instructor.bio,
            details=instructor.details,
            profile=instructor.profile,
            user_uuid=instructor.user_uuid,
            email_verified=instructor.email_verified,
            last_login_at=instructor.last_login_at,
            signup_method=instructor.signup_method,
            is_superadmin=instructor.is_superadmin,
        ),
        "public_learner": PublicUser(
            id=learner.id,
            username=learner.username,
            first_name=learner.first_name,
            last_name=learner.last_name,
            email=learner.email,
            avatar_image=learner.avatar_image,
            bio=learner.bio,
            details=learner.details,
            profile=learner.profile,
            user_uuid=learner.user_uuid,
            email_verified=learner.email_verified,
            last_login_at=learner.last_login_at,
            signup_method=learner.signup_method,
            is_superadmin=learner.is_superadmin,
        ),
        "now": now,
    }


@pytest.fixture(autouse=True)
def stub_access_checks(monkeypatch):
    async def _allow(*args, **kwargs):
        return True

    monkeypatch.setattr(enrollment_service, "authorization_verify_if_user_is_anon", _allow)
    monkeypatch.setattr(enrollment_service, "check_resource_access", _allow)
    monkeypatch.setattr(enrollment_service, "send_email", lambda *args, **kwargs: None)


def test_invite_requires_non_public_course(db: Session, http_request: Request, seeded_enrollment_data):
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            enrollment_service.invite_learners_by_email(
                http_request,
                seeded_enrollment_data["course_public"].course_uuid,
                ["newlearner@test.org"],
                seeded_enrollment_data["public_instructor"],
                db,
            )
        )

    assert exc_info.value.status_code == 400
    assert "non-public courses" in exc_info.value.detail


def test_reissue_terminal_invite_in_place_and_skip_duplicate_input(
    db: Session,
    http_request: Request,
    seeded_enrollment_data,
):
    existing = CourseEnrollment(
        enrollment_uuid="courseenrollment_existing",
        course_id=seeded_enrollment_data["course_private"].id,
        org_id=seeded_enrollment_data["org"].id,
        user_id=seeded_enrollment_data["learner"].id,
        email=seeded_enrollment_data["learner"].email,
        invite_code="oldcode",
        status=CourseEnrollmentStatus.REJECTED,
        invited_by=seeded_enrollment_data["instructor"].id,
        expires_at=(seeded_enrollment_data["now"] - timedelta(days=1)).isoformat(),
        creation_date=str(seeded_enrollment_data["now"]),
        update_date=str(seeded_enrollment_data["now"]),
    )
    db.add(existing)
    db.commit()
    db.refresh(existing)

    result = asyncio.run(
        enrollment_service.invite_learners_by_email(
            http_request,
            seeded_enrollment_data["course_private"].course_uuid,
            [seeded_enrollment_data["learner"].email, seeded_enrollment_data["learner"].email],
            seeded_enrollment_data["public_instructor"],
            db,
        )
    )

    assert len(result["successful"]) == 1
    assert len(result["failed"]) == 1
    assert result["failed"][0]["reason"] == "Duplicate or empty email"

    refreshed = db.exec(
        select(CourseEnrollment).where(CourseEnrollment.id == existing.id)
    ).first()
    assert refreshed is not None
    assert refreshed.status == CourseEnrollmentStatus.PENDING
    assert refreshed.invite_code != "oldcode"


def test_invite_skips_already_enrolled_learner(db: Session, http_request: Request, seeded_enrollment_data):
    accepted = CourseEnrollment(
        enrollment_uuid="courseenrollment_accepted",
        course_id=seeded_enrollment_data["course_private"].id,
        org_id=seeded_enrollment_data["org"].id,
        user_id=seeded_enrollment_data["learner"].id,
        email=seeded_enrollment_data["learner"].email,
        invite_code="acceptedcode",
        status=CourseEnrollmentStatus.ACCEPTED,
        invited_by=seeded_enrollment_data["instructor"].id,
        expires_at=None,
        creation_date=str(seeded_enrollment_data["now"]),
        update_date=str(seeded_enrollment_data["now"]),
    )
    db.add(accepted)
    db.commit()

    result = asyncio.run(
        enrollment_service.invite_learners_by_email(
            http_request,
            seeded_enrollment_data["course_private"].course_uuid,
            [seeded_enrollment_data["learner"].email],
            seeded_enrollment_data["public_instructor"],
            db,
        )
    )

    assert result["successful"] == []
    assert result["failed"][0]["reason"] == "Learner already enrolled"


def test_expired_invites_are_marked_expired_and_cannot_be_accepted(
    db: Session,
    http_request: Request,
    seeded_enrollment_data,
):
    expired_pending = CourseEnrollment(
        enrollment_uuid="courseenrollment_expiring",
        course_id=seeded_enrollment_data["course_private"].id,
        org_id=seeded_enrollment_data["org"].id,
        user_id=None,
        email=seeded_enrollment_data["learner"].email,
        invite_code="expiredcode",
        status=CourseEnrollmentStatus.PENDING,
        invited_by=seeded_enrollment_data["instructor"].id,
        expires_at=(seeded_enrollment_data["now"] - timedelta(days=2)).isoformat(),
        creation_date=str(seeded_enrollment_data["now"]),
        update_date=str(seeded_enrollment_data["now"]),
    )
    db.add(expired_pending)
    db.commit()

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            enrollment_service.accept_course_enrollment_invite(
                http_request,
                "expiredcode",
                seeded_enrollment_data["public_learner"],
                db,
            )
        )

    assert exc_info.value.status_code == 400
    assert "expired" in exc_info.value.detail

    refreshed = db.exec(
        select(CourseEnrollment).where(CourseEnrollment.invite_code == "expiredcode")
    ).first()
    assert refreshed is not None
    assert refreshed.status == CourseEnrollmentStatus.EXPIRED


def test_user_has_active_course_enrollment_only_for_accepted(db: Session, seeded_enrollment_data):
    pending = CourseEnrollment(
        enrollment_uuid="courseenrollment_pending",
        course_id=seeded_enrollment_data["course_private"].id,
        org_id=seeded_enrollment_data["org"].id,
        user_id=seeded_enrollment_data["learner"].id,
        email=seeded_enrollment_data["learner"].email,
        invite_code="pendingcode",
        status=CourseEnrollmentStatus.PENDING,
        invited_by=seeded_enrollment_data["instructor"].id,
        expires_at=None,
        creation_date=str(seeded_enrollment_data["now"]),
        update_date=str(seeded_enrollment_data["now"]),
    )
    db.add(pending)
    db.commit()

    assert (
        enrollment_service.user_has_active_course_enrollment(
            db, seeded_enrollment_data["course_private"].id, seeded_enrollment_data["learner"].id
        )
        is False
    )

    pending.status = CourseEnrollmentStatus.ACCEPTED
    db.add(pending)
    db.commit()

    assert (
        enrollment_service.user_has_active_course_enrollment(
            db, seeded_enrollment_data["course_private"].id, seeded_enrollment_data["learner"].id
        )
        is True
    )
