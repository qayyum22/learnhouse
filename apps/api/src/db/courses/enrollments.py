from enum import Enum
from typing import Optional
from sqlalchemy import Column, ForeignKey, Index, Integer, String
from sqlmodel import Field, SQLModel


class CourseEnrollmentStatus(str, Enum):
    """
    Lifecycle of a course enrollment invitation.

    PENDING  -> invite sent, waiting for learner to accept/reject (or expire)
    ACCEPTED -> learner accepted; grants read access to the course
    REJECTED -> learner explicitly declined; no access, kept for audit
    REVOKED  -> instructor withdrew the invite / removed the learner
    EXPIRED  -> invite passed its expires_at without being accepted
    """

    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    REVOKED = "revoked"
    EXPIRED = "expired"


# Terminal states cannot transition further without a fresh invite.
TERMINAL_ENROLLMENT_STATUSES = {
    CourseEnrollmentStatus.REJECTED,
    CourseEnrollmentStatus.REVOKED,
    CourseEnrollmentStatus.EXPIRED,
}


class CourseEnrollment(SQLModel, table=True):
    """
    Direct learner enrollment / invitation for a course.

    Instructors invite specific learners (by email) to exclusive (non-public)
    courses without having to manage UserGroups. A learner gains read access
    to the course only once the invite is ACCEPTED.
    """

    __table_args__ = (
        # Fast "is this email already invited to this course?" lookups.
        Index("ix_courseenrollment_course_email", "course_id", "email"),
        # Fast RBAC "does this user have an accepted enrollment?" lookups.
        Index("ix_courseenrollment_course_user", "course_id", "user_id"),
        {"extend_existing": True},
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    enrollment_uuid: str = Field(default="", index=True)
    course_id: int = Field(
        sa_column=Column(Integer, ForeignKey("course.id", ondelete="CASCADE"), index=True)
    )
    org_id: int = Field(
        sa_column=Column(Integer, ForeignKey("organization.id", ondelete="CASCADE"), index=True)
    )
    # Nullable: the invited email may not have an account yet.
    user_id: Optional[int] = Field(
        default=None,
        sa_column=Column(Integer, ForeignKey("user.id", ondelete="CASCADE"), nullable=True, index=True),
    )
    # Stored lowercased for case-insensitive matching.
    email: str = Field(index=True)
    # Single-use, cryptographically random token for the accept link.
    invite_code: str = Field(index=True)
    # Keep the database column string-backed to match the migration while the
    # application layer continues to validate values through the enum.
    status: CourseEnrollmentStatus = Field(
        default=CourseEnrollmentStatus.PENDING,
        sa_column=Column(String, nullable=False, default=CourseEnrollmentStatus.PENDING.value),
    )
    invited_by: Optional[int] = Field(default=None, foreign_key="user.id")
    # ISO-8601 timestamp; None means the invite never expires.
    expires_at: Optional[str] = Field(default=None)
    creation_date: str = ""
    update_date: str = ""


class CourseEnrollmentRead(SQLModel):
    id: int
    enrollment_uuid: str
    course_id: int
    org_id: int
    user_id: Optional[int] = None
    email: str
    status: CourseEnrollmentStatus
    invited_by: Optional[int] = None
    expires_at: Optional[str] = None
    creation_date: str
    update_date: str
