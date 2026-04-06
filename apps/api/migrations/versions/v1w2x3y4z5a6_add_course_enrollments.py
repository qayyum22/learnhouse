"""Add course enrollments (instructor email invites)

Revision ID: v1w2x3y4z5a6
Revises: u0v1w2x3y4z5
Create Date: 2026-04-06 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa  # noqa: F401
import sqlmodel  # noqa: F401

# revision identifiers, used by Alembic.
revision: str = 'v1w2x3y4z5a6'
down_revision: Union[str, None] = 'u0v1w2x3y4z5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Stores per-learner invites/enrollments for exclusive (non-public) courses.
    # Status is stored as a plain string to keep the lifecycle extensible without
    # a Postgres enum migration each time a state is added.
    op.create_table(
        'courseenrollment',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('enrollment_uuid', sa.String(), nullable=False),
        sa.Column('course_id', sa.Integer(), sa.ForeignKey('course.id', ondelete='CASCADE'), nullable=False),
        sa.Column('org_id', sa.Integer(), sa.ForeignKey('organization.id', ondelete='CASCADE'), nullable=False),
        # user_id is nullable: learner may not have an account yet when invited.
        sa.Column('user_id', sa.Integer(), sa.ForeignKey('user.id', ondelete='CASCADE'), nullable=True),
        sa.Column('email', sa.String(), nullable=False),
        sa.Column('invite_code', sa.String(), nullable=False),
        sa.Column('status', sa.String(), nullable=False, server_default='pending'),
        sa.Column('invited_by', sa.Integer(), sa.ForeignKey('user.id'), nullable=True),
        sa.Column('expires_at', sa.String(), nullable=True),
        sa.Column('creation_date', sa.String(), nullable=False),
        sa.Column('update_date', sa.String(), nullable=False),
    )

    # Single-column indexes mirror Field(index=True) on the SQLModel.
    op.create_index('ix_courseenrollment_enrollment_uuid', 'courseenrollment', ['enrollment_uuid'])
    op.create_index('ix_courseenrollment_course_id', 'courseenrollment', ['course_id'])
    op.create_index('ix_courseenrollment_org_id', 'courseenrollment', ['org_id'])
    op.create_index('ix_courseenrollment_user_id', 'courseenrollment', ['user_id'])
    op.create_index('ix_courseenrollment_email', 'courseenrollment', ['email'])
    op.create_index('ix_courseenrollment_invite_code', 'courseenrollment', ['invite_code'])
    # Composite indexes for the two hot paths: duplicate-invite detection and RBAC.
    op.create_index('ix_courseenrollment_course_email', 'courseenrollment', ['course_id', 'email'])
    op.create_index('ix_courseenrollment_course_user', 'courseenrollment', ['course_id', 'user_id'])


def downgrade() -> None:
    op.drop_index('ix_courseenrollment_course_user', table_name='courseenrollment')
    op.drop_index('ix_courseenrollment_course_email', table_name='courseenrollment')
    op.drop_index('ix_courseenrollment_invite_code', table_name='courseenrollment')
    op.drop_index('ix_courseenrollment_email', table_name='courseenrollment')
    op.drop_index('ix_courseenrollment_user_id', table_name='courseenrollment')
    op.drop_index('ix_courseenrollment_org_id', table_name='courseenrollment')
    op.drop_index('ix_courseenrollment_course_id', table_name='courseenrollment')
    op.drop_index('ix_courseenrollment_enrollment_uuid', table_name='courseenrollment')
    op.drop_table('courseenrollment')
