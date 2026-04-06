import logging
import secrets
import string
import uuid
from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import HTTPException, Request
from pydantic import EmailStr
from sqlmodel import Session, select, and_, or_

from src.db.courses.courses import Course
from src.db.courses.enrollments import (
    CourseEnrollment,
    CourseEnrollmentRead,
    CourseEnrollmentStatus,
    TERMINAL_ENROLLMENT_STATUSES,
)
from src.db.organizations import Organization
from src.db.resource_authors import ResourceAuthor
from src.db.users import AnonymousUser, PublicUser, User, UserRead
from src.security.rbac import (
    authorization_verify_if_user_is_anon,
    check_resource_access,
    AccessAction,
)
from src.services.email.utils import send_email


# Default TTL for a pending invite before it auto-expires.
DEFAULT_INVITE_TTL_DAYS = 14
logger = logging.getLogger(__name__)


def _generate_invite_code(length: int = 32) -> str:
    """Cryptographically-secure alphanumeric token used in accept links."""
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _get_course_or_404(db_session: Session, course_uuid: str) -> Course:
    course = db_session.exec(
        select(Course).where(Course.course_uuid == course_uuid)
    ).first()
    if not course or course.id is None:
        raise HTTPException(status_code=404, detail="Course not found")
    return course


def _require_exclusive_course(course: Course) -> None:
    """Direct invite enrollments only make sense for non-public courses."""
    if course.public:
        raise HTTPException(
            status_code=400,
            detail="Direct enrollment invites are only available for non-public courses",
        )


def _status_enum(status: CourseEnrollmentStatus | str) -> CourseEnrollmentStatus:
    """Normalize DB-loaded string values back to the application enum."""
    return status if isinstance(status, CourseEnrollmentStatus) else CourseEnrollmentStatus(status)


def _is_expired(enrollment: CourseEnrollment) -> bool:
    """Treat any PENDING invite past its expires_at as expired."""
    if enrollment.status != CourseEnrollmentStatus.PENDING:
        return False
    if not enrollment.expires_at:
        return False
    try:
        return datetime.fromisoformat(enrollment.expires_at) < datetime.now()
    except ValueError:
        # Malformed timestamp — fail closed (do not grant access).
        return True


def _lazy_expire(db_session: Session, enrollment: CourseEnrollment) -> CourseEnrollment:
    """
    Lazily transition a PENDING invite to EXPIRED on read.
    Avoids needing a background scheduler while keeping state accurate.
    """
    if _is_expired(enrollment):
        enrollment.status = CourseEnrollmentStatus.EXPIRED
        enrollment.update_date = str(datetime.now())
        db_session.add(enrollment)
        db_session.commit()
        db_session.refresh(enrollment)
    return enrollment


def _send_invite_email(
    org: Optional[Organization],
    course: Course,
    inviter: PublicUser,
    enrollment: CourseEnrollment,
):
    """Best-effort email delivery; failures never break invite creation."""
    if not org:
        return
    try:
        send_email(
            to=enrollment.email,
            subject=f"You have been invited to the course {course.name}",
            body=f"""
<html>
    <body>
        <p>Hello {enrollment.email},</p>
        <p>You have been invited by @{inviter.username} to join the course
        <strong>{course.name}</strong> on {org.name}.</p>
        <p>Sign in and open <em>Account &rarr; Invitations</em>, or use the code
        <strong>{enrollment.invite_code}</strong> to accept.</p>
        <p>This invitation expires on {enrollment.expires_at or 'never'}.</p>
    </body>
</html>
""",
        )
    except Exception:
        logger.exception(
            "Failed to send course enrollment invite email",
            extra={
                "course_uuid": course.course_uuid,
                "org_id": course.org_id,
                "invitee_email": enrollment.email,
            },
        )


async def invite_learners_by_email(
    request: Request,
    course_uuid: str,
    emails: List[EmailStr],
    current_user: PublicUser | AnonymousUser,
    db_session: Session,
    send_invites: bool = True,
    ttl_days: Optional[int] = DEFAULT_INVITE_TTL_DAYS,
):
    """
    Invite one or more learners to an exclusive course by email.

    Edge cases handled:
    - Duplicate PENDING / ACCEPTED invite for the same email -> skipped with reason.
    - Terminal-state (revoked/expired/rejected) prior invite -> reissued in place.
    - Email belongs to a course author -> skipped (authors don't need enrollment).
    - Email matches an existing user -> invite is pre-linked to that user_id.

    SECURITY: only course owners (CREATOR/MAINTAINER/CONTRIBUTOR) or org admins
    may invite learners (enforced via check_resource_access UPDATE).
    """
    await authorization_verify_if_user_is_anon(current_user.id)
    course = _get_course_or_404(db_session, course_uuid)
    _require_exclusive_course(course)
    await check_resource_access(request, db_session, current_user, course_uuid, AccessAction.UPDATE)

    org = db_session.exec(select(Organization).where(Organization.id == course.org_id)).first()

    now = datetime.now()
    expires_at = (now + timedelta(days=ttl_days)).isoformat() if ttl_days else None
    results = {"successful": [], "failed": []}

    # De-dupe the input list itself so a paste of "a@x.com, a@x.com" only counts once.
    seen: set[str] = set()

    for raw_email in emails:
        email = str(raw_email).strip().lower()
        if not email or email in seen:
            results["failed"].append({"email": raw_email, "reason": "Duplicate or empty email"})
            continue
        seen.add(email)

        # Skip course authors — they already have full access.
        user = db_session.exec(select(User).where(User.email == email)).first()
        if user and user.id is not None:
            authorship = db_session.exec(
                select(ResourceAuthor).where(
                    and_(
                        ResourceAuthor.resource_uuid == course_uuid,
                        ResourceAuthor.user_id == user.id,
                    )
                )
            ).first()
            if authorship:
                results["failed"].append({"email": email, "reason": "User is already a course author"})
                continue

        # Reuse any prior row for this (course, email) to preserve history and avoid
        # an ever-growing pile of terminal invites when instructors re-invite.
        existing = db_session.exec(
            select(CourseEnrollment).where(
                and_(
                    CourseEnrollment.course_id == course.id,
                    CourseEnrollment.email == email,
                )
            )
        ).first()

        if existing:
            existing = _lazy_expire(db_session, existing)
            if existing.status == CourseEnrollmentStatus.ACCEPTED:
                results["failed"].append({"email": email, "reason": "Learner already enrolled"})
                continue
            if existing.status == CourseEnrollmentStatus.PENDING:
                results["failed"].append({"email": email, "reason": "Invite already pending"})
                continue
            # Terminal state -> reissue in place with a fresh code + expiry.
            existing.invite_code = _generate_invite_code()
            existing.status = CourseEnrollmentStatus.PENDING
            existing.expires_at = expires_at
            existing.invited_by = current_user.id
            existing.user_id = user.id if user and user.id is not None else existing.user_id
            existing.update_date = str(now)
            db_session.add(existing)
            db_session.commit()
            db_session.refresh(existing)
            if send_invites:
                _send_invite_email(org, course, current_user, existing)
            results["successful"].append(CourseEnrollmentRead.model_validate(existing).model_dump())
            continue

        enrollment = CourseEnrollment(
            enrollment_uuid=f"courseenrollment_{uuid.uuid4()}",
            course_id=course.id,
            org_id=course.org_id,
            user_id=user.id if user and user.id is not None else None,
            email=email,
            invite_code=_generate_invite_code(),
            status=CourseEnrollmentStatus.PENDING,
            invited_by=current_user.id,
            expires_at=expires_at,
            creation_date=str(now),
            update_date=str(now),
        )
        db_session.add(enrollment)
        db_session.commit()
        db_session.refresh(enrollment)

        if send_invites:
            _send_invite_email(org, course, current_user, enrollment)

        results["successful"].append(CourseEnrollmentRead.model_validate(enrollment).model_dump())

    return results


async def get_course_enrollments(
    request: Request,
    course_uuid: str,
    current_user: PublicUser | AnonymousUser,
    db_session: Session,
) -> List[dict]:
    """
    List all learner enrollments / invitations for a course.

    SECURITY: restricted to course owners/admins (UPDATE) because the list
    contains learner emails.
    """
    await authorization_verify_if_user_is_anon(current_user.id)
    course = _get_course_or_404(db_session, course_uuid)
    await check_resource_access(request, db_session, current_user, course_uuid, AccessAction.UPDATE)

    enrollments = db_session.exec(
        select(CourseEnrollment)
        .where(CourseEnrollment.course_id == course.id)
        .order_by(CourseEnrollment.creation_date.desc())  # type: ignore
    ).all()

    output: List[dict] = []
    for enrollment in enrollments:
        # Surface expiry to instructors without requiring them to re-invite.
        enrollment = _lazy_expire(db_session, enrollment)
        item = CourseEnrollmentRead.model_validate(enrollment).model_dump()
        if enrollment.user_id:
            user = db_session.exec(select(User).where(User.id == enrollment.user_id)).first()
            item["user"] = UserRead.model_validate(user).model_dump() if user else None
        else:
            item["user"] = None
        output.append(item)

    return output


async def resend_course_enrollment_invite(
    request: Request,
    course_uuid: str,
    enrollment_uuid: str,
    current_user: PublicUser | AnonymousUser,
    db_session: Session,
    ttl_days: Optional[int] = DEFAULT_INVITE_TTL_DAYS,
):
    """
    Regenerate the invite code, reset expiry, set status back to PENDING,
    and re-send the email. Only allowed on PENDING or terminal invites
    (never on an ACCEPTED enrollment — use revoke for that).
    """
    await authorization_verify_if_user_is_anon(current_user.id)
    course = _get_course_or_404(db_session, course_uuid)
    await check_resource_access(request, db_session, current_user, course_uuid, AccessAction.UPDATE)

    enrollment = db_session.exec(
        select(CourseEnrollment).where(
            and_(
                CourseEnrollment.enrollment_uuid == enrollment_uuid,
                CourseEnrollment.course_id == course.id,
            )
        )
    ).first()
    if not enrollment:
        raise HTTPException(status_code=404, detail="Enrollment not found")

    if enrollment.status == CourseEnrollmentStatus.ACCEPTED:
        raise HTTPException(status_code=400, detail="Learner has already accepted this invitation")

    now = datetime.now()
    enrollment.invite_code = _generate_invite_code()
    enrollment.status = CourseEnrollmentStatus.PENDING
    enrollment.expires_at = (now + timedelta(days=ttl_days)).isoformat() if ttl_days else None
    enrollment.invited_by = current_user.id
    enrollment.update_date = str(now)
    db_session.add(enrollment)
    db_session.commit()
    db_session.refresh(enrollment)

    org = db_session.exec(select(Organization).where(Organization.id == course.org_id)).first()
    _send_invite_email(org, course, current_user, enrollment)

    return {"detail": "Invitation resent", "enrollment": CourseEnrollmentRead.model_validate(enrollment).model_dump()}


async def revoke_course_enrollment(
    request: Request,
    course_uuid: str,
    enrollment_uuid: str,
    current_user: PublicUser | AnonymousUser,
    db_session: Session,
):
    """
    Instructor-initiated removal. Moves the row to REVOKED (kept for audit)
    rather than hard-deleting, so the learner's history remains visible and
    a later re-invite reuses the same record.
    """
    await authorization_verify_if_user_is_anon(current_user.id)
    course = _get_course_or_404(db_session, course_uuid)
    await check_resource_access(request, db_session, current_user, course_uuid, AccessAction.UPDATE)

    enrollment = db_session.exec(
        select(CourseEnrollment).where(
            and_(
                CourseEnrollment.enrollment_uuid == enrollment_uuid,
                CourseEnrollment.course_id == course.id,
            )
        )
    ).first()
    if not enrollment:
        raise HTTPException(status_code=404, detail="Enrollment not found")

    if enrollment.status == CourseEnrollmentStatus.REVOKED:
        return {"detail": "Enrollment already revoked"}

    enrollment.status = CourseEnrollmentStatus.REVOKED
    # Invalidate the token so an old email link can't be redeemed after revoke.
    enrollment.invite_code = _generate_invite_code()
    enrollment.update_date = str(datetime.now())
    db_session.add(enrollment)
    db_session.commit()

    return {"detail": "Enrollment revoked"}


def _find_invite_for_user(
    db_session: Session,
    invite_code: str,
    current_user: PublicUser,
) -> CourseEnrollment:
    """
    Resolve an invite by its code and verify it was issued to the caller.
    Raises 404 for unknown/not-owned codes to avoid leaking existence.
    """
    # SECURITY: codes are alphanumeric; reject anything else early.
    if not invite_code or not invite_code.isalnum():
        raise HTTPException(status_code=404, detail="Invitation not found")

    enrollment = db_session.exec(
        select(CourseEnrollment).where(CourseEnrollment.invite_code == invite_code)
    ).first()
    if not enrollment:
        raise HTTPException(status_code=404, detail="Invitation not found")

    user_email = str(getattr(current_user, "email", "") or "").strip().lower()
    # Invite must target this user_id OR this email.
    if enrollment.user_id not in (None, current_user.id) and enrollment.email != user_email:
        raise HTTPException(status_code=403, detail="This invitation was not issued to your account")
    if enrollment.user_id is None and enrollment.email != user_email:
        raise HTTPException(status_code=403, detail="This invitation was not issued to your account")

    return enrollment


async def accept_course_enrollment_invite(
    request: Request,
    invite_code: str,
    current_user: PublicUser | AnonymousUser,
    db_session: Session,
):
    """
    Learner accepts a pending invitation.

    Edge cases:
    - Already ACCEPTED -> idempotent success (no error toast on double-click).
    - EXPIRED / REVOKED / REJECTED -> 400 with a clear reason.
    """
    await authorization_verify_if_user_is_anon(current_user.id)
    enrollment = _find_invite_for_user(db_session, invite_code, current_user)  # type: ignore[arg-type]
    enrollment = _lazy_expire(db_session, enrollment)
    status = _status_enum(enrollment.status)

    if status == CourseEnrollmentStatus.ACCEPTED:
        # Idempotent: re-accepting is harmless.
        course = db_session.exec(select(Course).where(Course.id == enrollment.course_id)).first()
        return {
            "detail": "Already enrolled",
            "enrollment": CourseEnrollmentRead.model_validate(enrollment).model_dump(),
            "course_uuid": course.course_uuid if course else None,
        }

    if status in TERMINAL_ENROLLMENT_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"This invitation is {status.value} and can no longer be accepted",
        )

    # PENDING -> ACCEPTED
    enrollment.user_id = current_user.id
    enrollment.status = CourseEnrollmentStatus.ACCEPTED
    enrollment.update_date = str(datetime.now())
    db_session.add(enrollment)
    db_session.commit()
    db_session.refresh(enrollment)

    course = db_session.exec(select(Course).where(Course.id == enrollment.course_id)).first()
    return {
        "detail": "Enrollment accepted",
        "enrollment": CourseEnrollmentRead.model_validate(enrollment).model_dump(),
        "course_uuid": course.course_uuid if course else None,
    }


async def reject_course_enrollment_invite(
    request: Request,
    invite_code: str,
    current_user: PublicUser | AnonymousUser,
    db_session: Session,
):
    """Learner declines a pending invitation. Only PENDING invites can be rejected."""
    await authorization_verify_if_user_is_anon(current_user.id)
    enrollment = _find_invite_for_user(db_session, invite_code, current_user)  # type: ignore[arg-type]
    enrollment = _lazy_expire(db_session, enrollment)
    status = _status_enum(enrollment.status)

    if status != CourseEnrollmentStatus.PENDING:
        raise HTTPException(
            status_code=400,
            detail=f"Only pending invitations can be rejected (current: {status.value})",
        )

    enrollment.status = CourseEnrollmentStatus.REJECTED
    enrollment.user_id = enrollment.user_id or current_user.id
    enrollment.update_date = str(datetime.now())
    db_session.add(enrollment)
    db_session.commit()

    return {"detail": "Invitation rejected"}


async def get_my_course_invites(
    request: Request,
    current_user: PublicUser | AnonymousUser,
    db_session: Session,
) -> List[dict]:
    """
    All invitations addressed to the current user (by user_id or email),
    across statuses, so the learner UI can show pending/accepted/expired side by side.
    """
    await authorization_verify_if_user_is_anon(current_user.id)

    user_email = str(getattr(current_user, "email", "") or "").strip().lower()

    results = db_session.exec(
        select(CourseEnrollment, Course)
        .join(Course, Course.id == CourseEnrollment.course_id)  # type: ignore
        .where(
            or_(
                CourseEnrollment.user_id == current_user.id,
                CourseEnrollment.email == user_email,
            )
        )
        .order_by(CourseEnrollment.creation_date.desc())  # type: ignore
    ).all()

    output: List[dict] = []
    for enrollment, course in results:
        enrollment = _lazy_expire(db_session, enrollment)
        item = CourseEnrollmentRead.model_validate(enrollment).model_dump()
        # Only expose the code for PENDING invites; never leak tokens for terminal rows.
        item["invite_code"] = enrollment.invite_code if enrollment.status == CourseEnrollmentStatus.PENDING else None
        item["course_uuid"] = course.course_uuid
        item["course_name"] = course.name
        output.append(item)

    return output


def user_has_active_course_enrollment(
    db_session: Session,
    course_id: int,
    user_id: int,
) -> bool:
    """
    RBAC helper: true iff the user has an ACCEPTED direct enrollment for the course.
    PENDING / terminal states never grant read access.
    """
    if not user_id:
        return False

    enrollment = db_session.exec(
        select(CourseEnrollment).where(
            and_(
                CourseEnrollment.course_id == course_id,
                CourseEnrollment.user_id == user_id,
                CourseEnrollment.status == CourseEnrollmentStatus.ACCEPTED,
            )
        )
    ).first()
    return enrollment is not None
