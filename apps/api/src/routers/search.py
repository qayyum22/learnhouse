from typing import List, Optional, Union
from fastapi import APIRouter, Depends, Request, Query
from sqlmodel import Session
from src.core.events.database import get_db_session
from src.db.users import PublicUser, APITokenUser
from src.db.courses.activities import ActivityTypeEnum
from src.security.auth import get_current_user
from src.services.search.search import (
    search_across_org,
    SearchResult,
    SearchFilters,
    SearchEntityType,
)

router = APIRouter()


@router.get("/org_slug/{org_slug}", response_model=SearchResult)
async def api_search_across_org(
    request: Request,
    org_slug: str,
    query: str = Query(..., min_length=1, max_length=200, description="Search query"),
    page: int = Query(default=1, ge=1, description="Page number"),
    limit: int = Query(default=10, ge=1, le=50, description="Items per page (max 50)"),
    types: Optional[List[SearchEntityType]] = Query(
        default=None,
        description="Restrict to specific content types (course, collection, user, chapter, activity)",
    ),
    public_only: bool = Query(default=False, description="Only return public content"),
    published_only: bool = Query(default=False, description="Only return published course content"),
    course_id: Optional[int] = Query(default=None, description="Restrict chapters/activities/courses to a single course"),
    activity_type: Optional[ActivityTypeEnum] = Query(default=None, description="Filter activities by type"),
    tag: Optional[str] = Query(default=None, max_length=100, description="Filter courses by tag substring"),
    db_session: Session = Depends(get_db_session),
    current_user: Union[PublicUser, APITokenUser] = Depends(get_current_user),
) -> SearchResult:
    """
    Organization-wide search across courses, collections, users, chapters and
    activities. Returns a unified, relevance-ranked `results` list plus
    per-type groupings and `facets` for building filter UI.

    SECURITY:
    - Maximum limit is 50 to prevent data dumping attacks
    - Query length is limited to 200 characters
    - Anonymous users cannot search users, chapters or activities
    """
    filters = SearchFilters(
        types=types,
        public_only=public_only,
        published_only=published_only,
        course_id=course_id,
        activity_type=activity_type,
        tag=tag,
    )
    return await search_across_org(
        request=request,
        current_user=current_user,
        org_slug=org_slug,
        search_query=query,
        db_session=db_session,
        page=page,
        limit=limit,
        filters=filters,
    )
