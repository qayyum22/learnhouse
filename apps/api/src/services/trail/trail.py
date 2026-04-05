from datetime import datetime, date, timedelta
from typing import List, Optional
from uuid import uuid4
from pydantic import BaseModel
from sqlmodel import Session, select, func
from src.db.courses.chapter_activities import ChapterActivity
from fastapi import HTTPException, Request, status
from src.db.courses.activities import Activity
from src.db.courses.assignments import Assignment, AssignmentUserSubmission
from src.db.courses.courses import Course
from src.db.trail_runs import TrailRun, TrailRunRead
from src.db.trail_steps import TrailStep
from src.db.trails import Trail, TrailCreate, TrailRead
from src.db.users import AnonymousUser, PublicUser
from src.services.courses.certifications import check_course_completion_and_create_certificate
from src.services.analytics.analytics import track
from src.services.analytics import events as analytics_events


def _build_trail_read(
    trail: Trail,
    trail_runs_raw: List[TrailRun],
    db_session: Session,
    user_id: Optional[int] = None,
    with_course_info: bool = True,
) -> TrailRead:
    """Build a TrailRead with all nested data using batch queries instead of N+1 loops."""
    if not trail_runs_raw:
        return TrailRead(**trail.model_dump(), runs=[])

    trail_run_ids = [tr.id for tr in trail_runs_raw]
    course_ids = list({tr.course_id for tr in trail_runs_raw})

    # Batch fetch all courses needed
    course_map: dict[int, Course] = {}
    if course_ids:
        courses = db_session.exec(
            select(Course).where(Course.id.in_(course_ids))  # type: ignore
        ).all()
        course_map = {c.id: c for c in courses}

    # Batch fetch chapter activity counts per course (for total_steps)
    course_total_steps_map: dict[int, int] = {}
    if with_course_info and course_ids:
        step_counts = db_session.exec(
            select(ChapterActivity.course_id, func.count(ChapterActivity.id))  # type: ignore
            .where(ChapterActivity.course_id.in_(course_ids))  # type: ignore
            .group_by(ChapterActivity.course_id)
        ).all()
        course_total_steps_map = {row[0]: row[1] for row in step_counts}

    # Batch fetch all trail steps for these trail runs
    steps_statement = select(TrailStep).where(
        TrailStep.trailrun_id.in_(trail_run_ids)  # type: ignore
    )
    if user_id is not None:
        steps_statement = steps_statement.where(TrailStep.user_id == user_id)
    all_steps = db_session.exec(steps_statement).all()

    # Group steps by trailrun_id
    steps_by_run: dict[int, list[TrailStep]] = {}
    for step in all_steps:
        steps_by_run.setdefault(step.trailrun_id, []).append(step)

    # Also fetch courses referenced by trail steps (may overlap with trail_run courses)
    step_course_ids = list({s.course_id for s in all_steps} - set(course_map.keys()))
    if step_course_ids:
        extra_courses = db_session.exec(
            select(Course).where(Course.id.in_(step_course_ids))  # type: ignore
        ).all()
        for c in extra_courses:
            course_map[c.id] = c

    # Build trail runs
    trail_runs = []
    for tr in trail_runs_raw:
        course = course_map.get(tr.course_id)
        run = TrailRunRead(
            **tr.model_dump(),
            course=course.model_dump() if course else {},
            steps=[],
            course_total_steps=course_total_steps_map.get(tr.course_id, 0) if with_course_info else 0,
        )

        # Attach steps with course data (expunge to avoid dirty-tracking the data override)
        for step in steps_by_run.get(tr.id, []):
            db_session.expunge(step)
            step_course = course_map.get(step.course_id)
            step.data = dict(course=step_course)
            run.steps.append(step)

        trail_runs.append(run)

    return TrailRead(**trail.model_dump(), runs=trail_runs)


async def create_user_trail(
    request: Request,
    user: PublicUser,
    trail_object: TrailCreate,
    db_session: Session,
) -> Trail:
    statement = select(Trail).where(
        Trail.org_id == trail_object.org_id, Trail.user_id == user.id
    )
    trail = db_session.exec(statement).first()

    if trail:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Trail already exists",
        )

    trail = Trail.model_validate(trail_object)

    trail.creation_date = str(datetime.now())
    trail.update_date = str(datetime.now())
    trail.org_id = trail_object.org_id
    trail.trail_uuid = str(f"trail_{uuid4()}")

    # create trail
    db_session.add(trail)
    db_session.commit()
    db_session.refresh(trail)

    return trail


async def get_user_trails(
    request: Request,
    user: PublicUser,
    db_session: Session,
) -> TrailRead:
    statement = select(Trail).where(Trail.user_id == user.id)
    trail = db_session.exec(statement).first()

    if not trail:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Trail not found"
        )

    statement = select(TrailRun).where(TrailRun.trail_id == trail.id)
    trail_runs_raw = db_session.exec(statement).all()

    return _build_trail_read(trail, list(trail_runs_raw), db_session)


async def check_trail_presence(
    org_id: int,
    user_id: int,
    request: Request,
    user: PublicUser,
    db_session: Session,
):
    statement = select(Trail).where(Trail.org_id == org_id, Trail.user_id == user_id)
    trail = db_session.exec(statement).first()

    if not trail:
        trail = await create_user_trail(
            request,
            user,
            TrailCreate(
                org_id=org_id,
                user_id=user.id,
            ),
            db_session,
        )
        return trail

    return trail


async def get_user_trail_with_orgid(
    request: Request, user: PublicUser | AnonymousUser, org_id: int, db_session: Session
) -> TrailRead:

    if isinstance(user, AnonymousUser):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Anonymous users cannot access this endpoint",
        )

    trail = await check_trail_presence(
        org_id=org_id,
        user_id=user.id,
        request=request,
        user=user,
        db_session=db_session,
    )

    statement = select(TrailRun).where(TrailRun.trail_id == trail.id)
    trail_runs_raw = db_session.exec(statement).all()

    return _build_trail_read(trail, list(trail_runs_raw), db_session)


async def add_activity_to_trail(
    request: Request,
    user: PublicUser,
    activity_uuid: str,
    db_session: Session,
) -> TrailRead:
    # Look for the activity
    statement = select(Activity).where(Activity.activity_uuid == activity_uuid)
    activity = db_session.exec(statement).first()

    if not activity:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Activity not found"
        )

    statement = select(Course).where(Course.id == activity.course_id)
    course = db_session.exec(statement).first()

    if not course:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Course not found"
        )

    trail = await check_trail_presence(
        org_id=course.org_id,
        user_id=user.id,
        request=request,
        user=user,
        db_session=db_session,
    )

    statement = select(TrailRun).where(
        TrailRun.trail_id == trail.id, TrailRun.course_id == course.id, TrailRun.user_id == user.id
    )
    trailrun = db_session.exec(statement).first()

    if not trailrun:
        trailrun = TrailRun(
            trail_id=trail.id if trail.id is not None else 0,
            course_id=course.id if course.id is not None else 0,
            org_id=course.org_id,
            user_id=user.id,
            creation_date=str(datetime.now()),
            update_date=str(datetime.now()),
        )
        db_session.add(trailrun)
        db_session.commit()
        db_session.refresh(trailrun)

    statement = select(TrailStep).where(
        TrailStep.trailrun_id == trailrun.id, TrailStep.activity_id == activity.id, TrailStep.user_id == user.id
    )
    trailstep = db_session.exec(statement).first()

    is_new_completion = trailstep is None
    if is_new_completion:
        trailstep = TrailStep(
            trailrun_id=trailrun.id if trailrun.id is not None else 0,
            activity_id=activity.id if activity.id is not None else 0,
            course_id=course.id if course.id is not None else 0,
            trail_id=trail.id if trail.id is not None else 0,
            org_id=course.org_id,
            complete=True,
            teacher_verified=False,
            grade="",
            user_id=user.id,
            creation_date=str(datetime.now()),
            update_date=str(datetime.now()),
        )
        db_session.add(trailstep)
        db_session.commit()
        db_session.refresh(trailstep)

    # Only track on first completion — avoid duplicates on re-visits
    if is_new_completion:
        await track(
            event_name=analytics_events.ACTIVITY_COMPLETED,
            org_id=course.org_id,
            user_id=user.id,
            properties={
                "activity_uuid": activity_uuid,
                "course_uuid": course.course_uuid,
                "activity_type": activity.activity_type if activity.activity_type else "",
            },
        )

    # Check if all activities in the course are completed and create certificate if so
    course_was_completed = False
    if course and course.id:
        course_was_completed = await check_course_completion_and_create_certificate(
            request, user.id, course.id, db_session
        )

    if course_was_completed:
        await track(
            event_name=analytics_events.COURSE_COMPLETED,
            org_id=course.org_id,
            user_id=user.id,
            properties={"course_uuid": course.course_uuid},
        )

    statement = select(TrailRun).where(TrailRun.trail_id == trail.id, TrailRun.user_id == user.id)
    trail_runs_raw = db_session.exec(statement).all()

    return _build_trail_read(trail, list(trail_runs_raw), db_session, user_id=user.id)

async def remove_activity_from_trail(
    request: Request,
    user: PublicUser,
    activity_uuid: str,
    db_session: Session,
) -> TrailRead:
    # Look for the activity
    statement = select(Activity).where(Activity.activity_uuid == activity_uuid)
    activity = db_session.exec(statement).first()

    if not activity:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Activity not found"
        )

    statement = select(Course).where(Course.id == activity.course_id)
    course = db_session.exec(statement).first()

    if not course:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Course not found"
        )

    statement = select(Trail).where(
        Trail.org_id == course.org_id, Trail.user_id == user.id
    )
    trail = db_session.exec(statement).first()

    if not trail:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Trail not found"
        )

    # Delete the trail step for this activity
    statement = select(TrailStep).where(
        TrailStep.activity_id == activity.id, 
        TrailStep.user_id == user.id,
        TrailStep.trail_id == trail.id
    )
    trail_step = db_session.exec(statement).first()

    if trail_step:
        db_session.delete(trail_step)
        db_session.commit()

    # Get updated trail data
    statement = select(TrailRun).where(TrailRun.trail_id == trail.id, TrailRun.user_id == user.id)
    trail_runs_raw = db_session.exec(statement).all()

    return _build_trail_read(trail, list(trail_runs_raw), db_session, user_id=user.id)


async def add_course_to_trail(
    request: Request,
    user: PublicUser,
    course_uuid: str,
    db_session: Session,
) -> TrailRead:
    statement = select(Course).where(Course.course_uuid == course_uuid)
    course = db_session.exec(statement).first()

    if not course:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Course not found"
        )

    # check if run already exists
    statement = select(TrailRun).where(
        TrailRun.course_id == course.id, TrailRun.user_id == user.id
    )
    trailrun = db_session.exec(statement).first()

    if trailrun:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="TrailRun already exists"
        )

    statement = select(Trail).where(
        Trail.org_id == course.org_id, Trail.user_id == user.id
    )
    trail = db_session.exec(statement).first()

    if not trail:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Trail not found"
        )

    statement = select(TrailRun).where(
        TrailRun.trail_id == trail.id, TrailRun.course_id == course.id, TrailRun.user_id == user.id
    )
    trail_run = db_session.exec(statement).first()

    if not trail_run:
        trail_run = TrailRun(
            trail_id=trail.id if trail.id is not None else 0,
            course_id=course.id if course.id is not None else 0,
            org_id=course.org_id,
            user_id=user.id,
            creation_date=str(datetime.now()),
            update_date=str(datetime.now()),
        )
        db_session.add(trail_run)
        db_session.commit()
        db_session.refresh(trail_run)

    # Track course enrollment
    await track(
        event_name=analytics_events.COURSE_ENROLLED,
        org_id=course.org_id,
        user_id=user.id,
        properties={"course_uuid": course.course_uuid},
    )

    statement = select(TrailRun).where(TrailRun.trail_id == trail.id, TrailRun.user_id == user.id)
    trail_runs_raw = db_session.exec(statement).all()

    return _build_trail_read(trail, list(trail_runs_raw), db_session, user_id=user.id)


# -------------------------------------------------------------------
# Learner dashboard
# -------------------------------------------------------------------
class DashboardDeadline(BaseModel):
    assignment_uuid: str
    title: str
    due_date: str
    course_name: str
    course_uuid: str
    activity_uuid: str


class DashboardActivityDay(BaseModel):
    date: str  # YYYY-MM-DD
    count: int


class LearnerDashboard(BaseModel):
    # overall completion across all enrolled courses
    overall_completion_percent: int
    total_activities: int
    completed_activities: int
    # course-level counts
    courses_in_progress: int
    courses_completed: int
    # streak (consecutive days ending today with at least one completed step)
    current_streak_days: int
    last_activity_date: Optional[str] = None
    # estimated time spent (minutes) — derived from step timestamps
    time_spent_minutes: int
    # activity heatmap — last 30 days
    recent_activity: List[DashboardActivityDay]
    # upcoming assignment deadlines (unsubmitted, due in future, in enrolled courses)
    upcoming_deadlines: List[DashboardDeadline]


def _parse_step_date(raw: str) -> Optional[date]:
    """Extract just the date from a TrailStep timestamp string."""
    dt = _parse_step_datetime(raw)
    return dt.date() if dt else None


def _parse_step_datetime(raw: str) -> Optional[datetime]:
    """Parse a TrailStep timestamp string into a full datetime.

    TrailStep.creation_date is stored as str(datetime.now()),
    e.g. "2025-01-03 10:42:11.123456".
    """
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        try:
            return datetime.fromisoformat(raw[:19])
        except ValueError:
            return None


# Max gap (minutes) between two consecutive steps that still counts as
# "active time". Anything larger is treated as a break / new session.
_SESSION_GAP_MINUTES = 30
# Cap per individual inter-step interval so a single long gap can't
# inflate the metric even within the session-gap window.
_PER_INTERVAL_CAP_MINUTES = 15


def _estimate_time_spent_minutes(step_datetimes: list[datetime]) -> int:
    """Estimate total study time from ordered step completion timestamps.

    Heuristic: for consecutive steps on the same calendar day, the gap
    between them counts as active time — capped at _PER_INTERVAL_CAP_MINUTES
    per interval and only when the gap is < _SESSION_GAP_MINUTES.
    Each unique activity day gets a baseline of 5 min even with only one step.
    """
    if not step_datetimes:
        return 0

    sorted_dts = sorted(step_datetimes)
    total_minutes = 0.0
    days_seen: set[date] = set()

    prev = sorted_dts[0]
    days_seen.add(prev.date())

    for curr in sorted_dts[1:]:
        days_seen.add(curr.date())
        gap = (curr - prev).total_seconds() / 60.0
        if gap < _SESSION_GAP_MINUTES:
            total_minutes += min(gap, _PER_INTERVAL_CAP_MINUTES)
        prev = curr

    # Baseline: 5 min per active day (accounts for reading time before
    # the first step and single-step days).
    baseline = len(days_seen) * 5
    return round(max(total_minutes, baseline))


async def get_learner_dashboard(
    request: Request,
    user: PublicUser | AnonymousUser,
    org_id: int,
    db_session: Session,
) -> LearnerDashboard:
    if isinstance(user, AnonymousUser):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Anonymous users cannot access this endpoint",
        )

    trail = await check_trail_presence(
        org_id=org_id,
        user_id=user.id,
        request=request,
        user=user,
        db_session=db_session,
    )

    # --- Enrolled courses (trail runs) ---
    runs = db_session.exec(
        select(TrailRun).where(TrailRun.trail_id == trail.id, TrailRun.user_id == user.id)
    ).all()
    course_ids = [r.course_id for r in runs]

    # --- Total activities per enrolled course ---
    totals_by_course: dict[int, int] = {}
    if course_ids:
        rows = db_session.exec(
            select(ChapterActivity.course_id, func.count(ChapterActivity.id))  # type: ignore
            .where(ChapterActivity.course_id.in_(course_ids))  # type: ignore
            .group_by(ChapterActivity.course_id)
        ).all()
        totals_by_course = {row[0]: row[1] for row in rows}

    # --- All completed trail steps for this user+trail ---
    steps = db_session.exec(
        select(TrailStep).where(
            TrailStep.trail_id == trail.id,
            TrailStep.user_id == user.id,
        )
    ).all()

    # Deduplicate: count unique activity_ids per course so duplicate
    # TrailStep rows for the same activity cannot inflate percentages.
    unique_activities_by_course: dict[int, set[int]] = {}
    step_dates: list[date] = []
    step_datetimes: list[datetime] = []
    for s in steps:
        unique_activities_by_course.setdefault(s.course_id, set()).add(s.activity_id)
        dt = _parse_step_datetime(s.creation_date)
        if dt:
            step_datetimes.append(dt)
            step_dates.append(dt.date())

    completed_by_course: dict[int, int] = {
        cid: len(aids) for cid, aids in unique_activities_by_course.items()
    }

    # --- Overall completion ---
    total_activities = sum(totals_by_course.get(cid, 0) for cid in course_ids)
    completed_activities = sum(
        min(completed_by_course.get(cid, 0), totals_by_course.get(cid, 0))
        for cid in course_ids
    )
    overall_pct = (
        round((completed_activities / total_activities) * 100)
        if total_activities > 0
        else 0
    )

    # --- Per-course status ---
    courses_completed = 0
    courses_in_progress = 0
    for cid in course_ids:
        total = totals_by_course.get(cid, 0)
        done = completed_by_course.get(cid, 0)
        if total > 0 and done >= total:
            courses_completed += 1
        elif done > 0:
            # Only count as "in progress" if the learner has actually
            # completed at least one activity (not just enrolled).
            courses_in_progress += 1

    # --- Time spent ---
    time_spent_minutes = _estimate_time_spent_minutes(step_datetimes)

    # --- Streak & recent activity (last 30 days) ---
    today = date.today()
    unique_days = set(step_dates)

    # Streak: consecutive days with activity ending today (or yesterday, so a user
    # logging in early morning doesn't lose their streak before completing something)
    streak = 0
    cursor = today
    if today not in unique_days and (today - timedelta(days=1)) in unique_days:
        cursor = today - timedelta(days=1)
    while cursor in unique_days:
        streak += 1
        cursor -= timedelta(days=1)

    recent_activity: list[DashboardActivityDay] = []
    day_counts: dict[date, int] = {}
    for d in step_dates:
        day_counts[d] = day_counts.get(d, 0) + 1
    for i in range(29, -1, -1):
        d = today - timedelta(days=i)
        recent_activity.append(
            DashboardActivityDay(date=d.isoformat(), count=day_counts.get(d, 0))
        )

    last_activity_date = max(step_dates).isoformat() if step_dates else None

    # --- Upcoming deadlines ---
    # Assignments in enrolled courses that are published, due in the future,
    # and the user has NOT submitted.
    deadlines: list[DashboardDeadline] = []
    if course_ids:
        submitted_ids = set(
            db_session.exec(
                select(AssignmentUserSubmission.assignment_id).where(
                    AssignmentUserSubmission.user_id == user.id
                )
            ).all()
        )

        assignment_rows = db_session.exec(
            select(Assignment, Course, Activity)
            .join(Course, Assignment.course_id == Course.id)  # type: ignore
            .join(Activity, Assignment.activity_id == Activity.id)  # type: ignore
            .where(
                Assignment.course_id.in_(course_ids),  # type: ignore
                Assignment.published == True,  # noqa: E712
            )
        ).all()

        now_iso = datetime.now().isoformat()
        for assignment, course, activity in assignment_rows:
            if assignment.id in submitted_ids:
                continue
            if not assignment.due_date or assignment.due_date < now_iso:
                continue
            deadlines.append(
                DashboardDeadline(
                    assignment_uuid=assignment.assignment_uuid,
                    title=assignment.title,
                    due_date=assignment.due_date,
                    course_name=course.name,
                    course_uuid=course.course_uuid,
                    activity_uuid=activity.activity_uuid,
                )
            )
        deadlines.sort(key=lambda d: d.due_date)
        deadlines = deadlines[:5]

    return LearnerDashboard(
        overall_completion_percent=overall_pct,
        total_activities=total_activities,
        completed_activities=completed_activities,
        courses_in_progress=courses_in_progress,
        courses_completed=courses_completed,
        current_streak_days=streak,
        last_activity_date=last_activity_date,
        time_spent_minutes=time_spent_minutes,
        recent_activity=recent_activity,
        upcoming_deadlines=deadlines,
    )


async def remove_course_from_trail(
    request: Request,
    user: PublicUser,
    course_uuid: str,
    db_session: Session,
) -> TrailRead:
    statement = select(Course).where(Course.course_uuid == course_uuid)
    course = db_session.exec(statement).first()

    if not course:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Course not found"
        )

    statement = select(Trail).where(
        Trail.org_id == course.org_id, Trail.user_id == user.id
    )
    trail = db_session.exec(statement).first()

    if not trail:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Trail not found"
        )

    statement = select(TrailRun).where(
        TrailRun.trail_id == trail.id, TrailRun.course_id == course.id, TrailRun.user_id == user.id
    )
    trail_run = db_session.exec(statement).first()

    if trail_run:
        db_session.delete(trail_run)
        db_session.commit()

    # Delete all trail steps for this course
    statement = select(TrailStep).where(TrailStep.course_id == course.id, TrailStep.user_id == user.id)
    trail_steps = db_session.exec(statement).all()

    for trail_step in trail_steps:
        db_session.delete(trail_step)
        db_session.commit()

    statement = select(TrailRun).where(TrailRun.trail_id == trail.id, TrailRun.user_id == user.id)
    trail_runs_raw = db_session.exec(statement).all()

    return _build_trail_read(trail, list(trail_runs_raw), db_session, user_id=user.id)
