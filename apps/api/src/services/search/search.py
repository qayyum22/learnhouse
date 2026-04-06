import re
from enum import Enum
from typing import Any, Dict, List, Optional, Sequence, Tuple
from fastapi import Request
from sqlmodel import Session, select, or_, text, and_
from sqlalchemy import true as sa_true
from pydantic import BaseModel, ConfigDict
from src.db.users import PublicUser, AnonymousUser, UserRead, User, APITokenUser
from src.db.courses.courses import Course, CourseRead, AuthorWithRole
from src.db.courses.chapters import Chapter
from src.db.resource_authors import ResourceAuthor
from src.db.courses.activities import Activity, ActivityTypeEnum
from src.db.collections import Collection, CollectionRead
from src.db.collections_courses import CollectionCourse
from src.db.organizations import Organization
from src.db.user_organizations import UserOrganization
from src.security.org_auth import is_org_member


# ---------------------------------------------------------------------------
# Public schemas
# ---------------------------------------------------------------------------

class SearchEntityType(str, Enum):
    course = "course"
    collection = "collection"
    user = "user"
    chapter = "chapter"
    activity = "activity"


class SearchHit(BaseModel):
    """A single ranked search result, normalized across entity types."""
    type: SearchEntityType
    id: int
    uuid: str
    title: str
    snippet: Optional[str] = None
    score: float
    # Lightweight metadata useful for filtering / navigation on the client
    metadata: Dict[str, Any] = {}
    # Full serialized entity (CourseRead, CollectionRead, UserRead, etc.)
    data: Dict[str, Any]


class SearchFacetBucket(BaseModel):
    value: str
    count: int


class SearchResult(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    # Grouped results (backward compatible with the previous API shape)
    courses: List[CourseRead] = []
    collections: List[CollectionRead] = []
    users: List[UserRead] = []
    chapters: List[Dict[str, Any]] = []
    activities: List[Dict[str, Any]] = []

    # Unified, relevance-ranked list across all entity types
    results: List[SearchHit] = []
    total: int = 0
    page: int = 1
    limit: int = 10
    facets: Dict[str, List[SearchFacetBucket]] = {}


class SearchFilters(BaseModel):
    """Filters that can be applied to narrow search results."""
    types: Optional[List[SearchEntityType]] = None
    public_only: bool = False
    published_only: bool = False
    course_id: Optional[int] = None
    activity_type: Optional[ActivityTypeEnum] = None
    tag: Optional[str] = None


# ---------------------------------------------------------------------------
# Relevance engine
# ---------------------------------------------------------------------------

# Per-entity field weights. Higher weight => stronger contribution to score.
_FIELD_WEIGHTS: Dict[SearchEntityType, Dict[str, float]] = {
    SearchEntityType.course: {
        "name": 6.0,
        "tags": 4.0,
        "description": 2.5,
        "learnings": 2.0,
        "about": 1.5,
    },
    SearchEntityType.collection: {
        "name": 6.0,
        "description": 2.5,
    },
    SearchEntityType.user: {
        "username": 6.0,
        "first_name": 4.0,
        "last_name": 4.0,
        "bio": 1.5,
    },
    SearchEntityType.chapter: {
        "name": 5.0,
        "description": 2.0,
    },
    SearchEntityType.activity: {
        "name": 5.0,
        "content_text": 1.5,
    },
}

# Intrinsic boost per entity type so top-level content (courses) ranks above
# deeply-nested content (activities) when scores are otherwise comparable.
_TYPE_BOOST: Dict[SearchEntityType, float] = {
    SearchEntityType.course: 1.30,
    SearchEntityType.collection: 1.20,
    SearchEntityType.user: 1.10,
    SearchEntityType.chapter: 1.00,
    SearchEntityType.activity: 0.95,
}

_TOKEN_RE = re.compile(r"[^\w]+", re.UNICODE)
_MAX_TERMS = 8
_SNIPPET_RADIUS = 60


def _escape_like_wildcards(query: str) -> str:
    """Escape SQL LIKE wildcards to prevent user enumeration via pattern matching."""
    return query.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def _tokenize(query: str) -> List[str]:
    terms = [t for t in _TOKEN_RE.split(query.strip()) if t]
    # Keep single-char tokens only if the whole query is that token
    if len(terms) > 1:
        terms = [t for t in terms if len(t) > 1]
    return terms[:_MAX_TERMS] or ([query.strip()] if query.strip() else [])


def _match_quality(term: str, value: str) -> float:
    """Return a multiplier in [0, 1] describing how well `term` matches `value`."""
    if not value:
        return 0.0
    v = value.lower()
    t = term.lower()
    if v == t:
        return 1.0
    if v.startswith(t):
        return 0.85
    # word-boundary match
    if re.search(rf"(?<![\w]){re.escape(t)}", v):
        return 0.7
    if t in v:
        return 0.45
    return 0.0


def _score_fields(
    entity_type: SearchEntityType,
    terms: Sequence[str],
    fields: Dict[str, Optional[str]],
) -> float:
    weights = _FIELD_WEIGHTS[entity_type]
    total = 0.0
    matched_terms = 0
    for term in terms:
        best = 0.0
        for field_name, weight in weights.items():
            q = _match_quality(term, fields.get(field_name) or "")
            if q > 0:
                best = max(best, q * weight)
        if best > 0:
            matched_terms += 1
            total += best
    if matched_terms == 0:
        return 0.0
    # Reward matching more of the query terms (AND-ish bias without requiring it)
    coverage = matched_terms / max(len(terms), 1)
    return total * (0.5 + 0.5 * coverage) * _TYPE_BOOST[entity_type]


def _snippet(terms: Sequence[str], *candidates: Optional[str]) -> Optional[str]:
    for c in candidates:
        if not c:
            continue
        lc = c.lower()
        for t in terms:
            idx = lc.find(t.lower())
            if idx != -1:
                start = max(0, idx - _SNIPPET_RADIUS)
                end = min(len(c), idx + len(t) + _SNIPPET_RADIUS)
                prefix = "…" if start > 0 else ""
                suffix = "…" if end < len(c) else ""
                return f"{prefix}{c[start:end].strip()}{suffix}"
    for c in candidates:
        if c:
            return c[: _SNIPPET_RADIUS * 2] + ("…" if len(c) > _SNIPPET_RADIUS * 2 else "")
    return None


def _term_clause(column_sql: str, n_terms: int):
    """Build an OR of parameterized LOWER(col) LIKE LOWER(:tN) fragments."""
    parts = [f"LOWER({column_sql}) LIKE LOWER(:t{i})" for i in range(n_terms)]
    return text(" OR ".join(parts))


def _term_params(terms: Sequence[str]) -> Dict[str, str]:
    return {f"t{i}": f"%{_escape_like_wildcards(t)}%" for i, t in enumerate(terms)}


# Keys inside activity `content` / `details` JSON whose values are human-readable
# text worth indexing. This lets activity search go beyond title matching without
# pulling in opaque blobs (ids, urls, base64, etc.).
_ACTIVITY_TEXT_KEYS = {
    "text", "title", "caption", "description", "content", "question",
    "answer", "label", "name", "alt", "body", "paragraph", "markdown",
}
_ACTIVITY_TEXT_CAP = 4000


def _extract_activity_text(*payloads: Optional[dict]) -> str:
    """Recursively pull human-readable strings out of activity JSON content.

    Works for TipTap/ProseMirror-style docs ({type, content:[{type:'text', text:'...'}]})
    as well as simple key/value detail dicts. Capped to avoid scoring on megabytes.
    """
    parts: List[str] = []
    budget = _ACTIVITY_TEXT_CAP

    def walk(node: Any, key: Optional[str] = None) -> None:
        nonlocal budget
        if budget <= 0:
            return
        if isinstance(node, str):
            s = node.strip()
            if s and (key is None or key.lower() in _ACTIVITY_TEXT_KEYS):
                parts.append(s)
                budget -= len(s)
            return
        if isinstance(node, dict):
            for k, v in node.items():
                walk(v, k)
            return
        if isinstance(node, (list, tuple)):
            for item in node:
                walk(item, key)

    for p in payloads:
        if p:
            walk(p)
    return " ".join(parts)[:_ACTIVITY_TEXT_CAP]


def _hydrate_course_authors(
    db: Session, courses: Sequence[Course]
) -> Dict[str, List[AuthorWithRole]]:
    if not courses:
        return {}
    uuids = [c.course_uuid for c in courses]
    rows = db.exec(
        select(ResourceAuthor, User)
        .join(User, ResourceAuthor.user_id == User.id)  # type: ignore
        .where(ResourceAuthor.resource_uuid.in_(uuids))  # type: ignore
        .order_by(ResourceAuthor.id.asc())  # type: ignore
    ).all()
    by_course: Dict[str, List[AuthorWithRole]] = {}
    for ra, user in rows:
        by_course.setdefault(ra.resource_uuid, []).append(
            AuthorWithRole(
                user=UserRead.model_validate(user),
                authorship=ra.authorship,
                authorship_status=ra.authorship_status,
                creation_date=ra.creation_date,
                update_date=ra.update_date,
            )
        )
    return by_course


# ---------------------------------------------------------------------------
# Candidate fetchers (DB-level coarse filtering; fine ranking happens in Python)
# ---------------------------------------------------------------------------

# Over-fetch factor: pull more candidates than `limit` so that after cross-type
# ranking and pagination we still have enough high-quality results.
_CANDIDATE_MULTIPLIER = 5
_MAX_CANDIDATES_PER_TYPE = 200


def _candidate_cap(limit: int) -> int:
    return min(max(limit * _CANDIDATE_MULTIPLIER, 30), _MAX_CANDIDATES_PER_TYPE)


def _fetch_course_candidates(
    db: Session, org_id: int, terms: Sequence[str], filters: SearchFilters,
    visible_course_ids: Optional[set[int]], cap: int,
) -> List[Course]:
    n = len(terms)
    q = (
        select(Course)
        .where(Course.org_id == org_id)
        .where(
            or_(
                _term_clause("course.name", n),
                _term_clause("course.description", n),
                _term_clause("course.about", n),
                _term_clause("course.learnings", n),
                _term_clause("course.tags", n),
            )
        )
        .params(**_term_params(terms))
    )
    if filters.public_only:
        q = q.where(Course.public == sa_true())
    if filters.published_only:
        q = q.where(Course.published == sa_true())
    if filters.tag:
        q = q.where(text("LOWER(course.tags) LIKE LOWER(:tagp)")).params(
            tagp=f"%{_escape_like_wildcards(filters.tag)}%"
        )
    if filters.course_id is not None:
        q = q.where(Course.id == filters.course_id)
    if visible_course_ids is not None:
        if not visible_course_ids:
            return []
        q = q.where(Course.id.in_(visible_course_ids))  # type: ignore
    return list(db.exec(q.limit(cap)).all())


def _fetch_collection_candidates(
    db: Session, org_id: int, terms: Sequence[str], filters: SearchFilters,
    anonymous: bool, cap: int,
) -> List[Collection]:
    n = len(terms)
    q = (
        select(Collection)
        .where(Collection.org_id == org_id)
        .where(
            or_(
                _term_clause('"collection".name', n),
                _term_clause('"collection".description', n),
            )
        )
        .params(**_term_params(terms))
    )
    if anonymous or filters.public_only:
        q = q.where(Collection.public == sa_true())
    return list(db.exec(q.limit(cap)).all())


def _fetch_user_candidates(
    db: Session, org_id: int, terms: Sequence[str], cap: int,
) -> List[User]:
    n = len(terms)
    q = (
        select(User)
        .join(
            UserOrganization,
            and_(UserOrganization.user_id == User.id, UserOrganization.org_id == org_id),
        )
        .where(
            or_(
                _term_clause('"user".username', n),
                _term_clause('"user".first_name', n),
                _term_clause('"user".last_name', n),
                _term_clause('"user".bio', n),
            )
        )
        .params(**_term_params(terms))
    )
    return list(db.exec(q.limit(cap)).all())


def _fetch_chapter_candidates(
    db: Session, org_id: int, terms: Sequence[str], filters: SearchFilters,
    visible_course_ids: Optional[set[int]], cap: int,
) -> List[Tuple[Chapter, Course]]:
    n = len(terms)
    q = (
        select(Chapter, Course)
        .join(Course, Course.id == Chapter.course_id)  # type: ignore
        .where(Chapter.org_id == org_id)
        .where(
            or_(
                _term_clause("chapter.name", n),
                _term_clause("chapter.description", n),
            )
        )
        .params(**_term_params(terms))
    )
    if filters.course_id is not None:
        q = q.where(Chapter.course_id == filters.course_id)
    if filters.public_only:
        q = q.where(Course.public == sa_true())
    if filters.published_only:
        q = q.where(Course.published == sa_true())
    if visible_course_ids is not None:
        if not visible_course_ids:
            return []
        q = q.where(Chapter.course_id.in_(visible_course_ids))  # type: ignore
    return list(db.exec(q.limit(cap)).all())


def _fetch_activity_candidates(
    db: Session, org_id: int, terms: Sequence[str], filters: SearchFilters,
    visible_course_ids: Optional[set[int]], cap: int,
) -> List[Tuple[Activity, Course]]:
    n = len(terms)
    # Match on the activity name OR anywhere inside the serialized JSON content.
    # JSON is cast to text so this works on both Postgres (JSON/JSONB) and SQLite.
    q = (
        select(Activity, Course)
        .join(Course, Course.id == Activity.course_id)  # type: ignore
        .where(Activity.org_id == org_id)
        .where(
            or_(
                _term_clause("activity.name", n),
                _term_clause("CAST(activity.content AS TEXT)", n),
                _term_clause("CAST(activity.details AS TEXT)", n),
            )
        )
        .params(**_term_params(terms))
    )
    if filters.course_id is not None:
        q = q.where(Activity.course_id == filters.course_id)
    if filters.activity_type is not None:
        q = q.where(Activity.activity_type == filters.activity_type)
    if filters.public_only:
        q = q.where(Course.public == sa_true())
    if filters.published_only:
        q = q.where(Course.published == sa_true())
    if visible_course_ids is not None:
        if not visible_course_ids:
            return []
        q = q.where(Activity.course_id.in_(visible_course_ids))  # type: ignore
    return list(db.exec(q.limit(cap)).all())


def _visible_course_ids_for_anonymous(db: Session, org_id: int) -> set[int]:
    rows = db.exec(
        select(Course.id).where(
            Course.org_id == org_id,
            Course.public == sa_true(),
            Course.published == sa_true(),
        )
    ).all()
    return set(rows)


def _hydrate_collections(db: Session, collections: Sequence[Collection]) -> List[CollectionRead]:
    if not collections:
        return []
    collection_ids = [c.id for c in collections]
    rows = db.exec(
        select(CollectionCourse, Course)
        .join(Course, CollectionCourse.course_id == Course.id)  # type: ignore
        .where(CollectionCourse.collection_id.in_(collection_ids))  # type: ignore
        .distinct()
    ).all()
    by_collection: Dict[int, List[Course]] = {}
    seen: set[Tuple[int, int]] = set()
    for cc, course in rows:
        key = (cc.collection_id, course.id)
        if key in seen:
            continue
        seen.add(key)
        by_collection.setdefault(cc.collection_id, []).append(course)
    return [
        CollectionRead(**c.model_dump(), courses=by_collection.get(c.id, []))
        for c in collections
    ]


# ---------------------------------------------------------------------------
# Main entrypoint
# ---------------------------------------------------------------------------

async def search_across_org(
    request: Request,
    current_user: PublicUser | AnonymousUser | APITokenUser,
    org_slug: str,
    search_query: str,
    db_session: Session,
    page: int = 1,
    limit: int = 10,
    filters: Optional[SearchFilters] = None,
) -> SearchResult:
    """
    Organization-wide search across courses, collections, users, chapters and
    activities with relevance ranking and filtering.

    Ranking: the query is tokenized; each candidate is scored by weighted
    per-field match quality (exact > prefix > word-boundary > substring),
    term coverage, and an entity-type boost. Results from all types are merged
    into a single ranked list (`results`) and also returned grouped by type
    for backward compatibility.

    SECURITY:
    - Anonymous users can only see public+published course content and public
      collections; they CANNOT search users, chapters or activities.
    - Authenticated non-members cannot enumerate org users.
    - Maximum limit enforced at service level; parameterized queries; LIKE
      wildcards escaped.
    """
    from fastapi import HTTPException, status

    filters = filters or SearchFilters()
    requested_types = set(filters.types) if filters.types else set(SearchEntityType)

    # SECURITY: Enforce maximum limit to prevent data dumping
    limit = min(limit, 50)
    page = max(page, 1)
    offset = (page - 1) * limit
    cap = _candidate_cap(limit)

    terms = _tokenize(search_query)

    org = db_session.exec(select(Organization).where(Organization.slug == org_slug)).first()
    if not org or not terms:
        return SearchResult(page=page, limit=limit)

    # API Token validation: verify token belongs to this organization
    if isinstance(current_user, APITokenUser):
        if org.id != current_user.org_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="API token cannot search in organizations outside its scope",
            )
        # Check if token has read permission for search
        if current_user.rights:
            rights = current_user.rights
            if isinstance(rights, dict):
                search_rights = rights.get("search", {})
                has_permission = search_rights.get("action_read", False)
            else:
                search_rights = getattr(rights, "search", None)
                has_permission = getattr(search_rights, "action_read", False) if search_rights else False

            if not has_permission:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="API token does not have search permission",
                )

    is_anonymous = isinstance(current_user, AnonymousUser)
    is_member = (not is_anonymous) and is_org_member(current_user.id, org.id, db_session)

    # Course-content visibility: anonymous users only see public+published
    # courses (and chapters/activities within them).
    visible_course_ids: Optional[set[int]] = None
    if is_anonymous:
        visible_course_ids = _visible_course_ids_for_anonymous(db_session, org.id)
        # SECURITY: anonymous users cannot enumerate users or drill into
        # chapter/activity content.
        requested_types -= {SearchEntityType.user, SearchEntityType.chapter, SearchEntityType.activity}
    elif not is_member:
        # Authenticated but not a member of this org: no user enumeration.
        requested_types -= {SearchEntityType.user}

    # ---- Fetch candidates ------------------------------------------------
    hits: List[SearchHit] = []

    course_reads: List[CourseRead] = []
    if SearchEntityType.course in requested_types:
        courses = _fetch_course_candidates(
            db_session, org.id, terms, filters, visible_course_ids, cap
        )
        authors_by_course = _hydrate_course_authors(db_session, courses)
        for c in courses:
            score = _score_fields(
                SearchEntityType.course,
                terms,
                {
                    "name": c.name,
                    "tags": c.tags,
                    "description": c.description,
                    "learnings": c.learnings,
                    "about": c.about,
                },
            )
            if score <= 0:
                continue
            if c.public and c.published:
                score *= 1.05
            read = CourseRead(
                **c.model_dump(), authors=authors_by_course.get(c.course_uuid, [])
            )
            course_reads.append(read)
            hits.append(
                SearchHit(
                    type=SearchEntityType.course,
                    id=c.id,
                    uuid=c.course_uuid,
                    title=c.name,
                    snippet=_snippet(terms, c.description, c.about, c.learnings),
                    score=round(score, 4),
                    metadata={
                        "public": c.public,
                        "published": c.published,
                        "tags": c.tags,
                        "org_id": c.org_id,
                    },
                    data=read.model_dump(),
                )
            )

    collection_reads: List[CollectionRead] = []
    if SearchEntityType.collection in requested_types:
        collections = _fetch_collection_candidates(
            db_session, org.id, terms, filters, is_anonymous, cap
        )
        hydrated = {c.id: c for c in _hydrate_collections(db_session, collections)}
        for c in collections:
            score = _score_fields(
                SearchEntityType.collection,
                terms,
                {"name": c.name, "description": c.description},
            )
            if score <= 0:
                continue
            read = hydrated.get(c.id) or CollectionRead(**c.model_dump(), courses=[])
            collection_reads.append(read)
            hits.append(
                SearchHit(
                    type=SearchEntityType.collection,
                    id=c.id,
                    uuid=c.collection_uuid,
                    title=c.name,
                    snippet=_snippet(terms, c.description),
                    score=round(score, 4),
                    metadata={"public": c.public, "course_count": len(read.courses)},
                    data=read.model_dump(),
                )
            )

    user_reads: List[UserRead] = []
    if SearchEntityType.user in requested_types:
        users = _fetch_user_candidates(db_session, org.id, terms, cap)
        for u in users:
            score = _score_fields(
                SearchEntityType.user,
                terms,
                {
                    "username": u.username,
                    "first_name": u.first_name,
                    "last_name": u.last_name,
                    "bio": u.bio,
                },
            )
            if score <= 0:
                continue
            read = UserRead.model_validate(u)
            user_reads.append(read)
            display = " ".join(p for p in [u.first_name, u.last_name] if p) or u.username
            hits.append(
                SearchHit(
                    type=SearchEntityType.user,
                    id=u.id,
                    uuid=u.user_uuid,
                    title=display,
                    snippet=_snippet(terms, u.bio),
                    score=round(score, 4),
                    metadata={"username": u.username},
                    data=read.model_dump(),
                )
            )

    chapter_payloads: List[Dict[str, Any]] = []
    if SearchEntityType.chapter in requested_types:
        for ch, course in _fetch_chapter_candidates(
            db_session, org.id, terms, filters, visible_course_ids, cap
        ):
            score = _score_fields(
                SearchEntityType.chapter,
                terms,
                {"name": ch.name, "description": ch.description},
            )
            if score <= 0:
                continue
            payload = {
                **ch.model_dump(),
                "course_uuid": course.course_uuid,
                "course_name": course.name,
            }
            chapter_payloads.append(payload)
            hits.append(
                SearchHit(
                    type=SearchEntityType.chapter,
                    id=ch.id,
                    uuid=ch.chapter_uuid,
                    title=ch.name,
                    snippet=_snippet(terms, ch.description),
                    score=round(score, 4),
                    metadata={
                        "course_id": ch.course_id,
                        "course_uuid": course.course_uuid,
                        "course_name": course.name,
                    },
                    data=payload,
                )
            )

    activity_payloads: List[Dict[str, Any]] = []
    if SearchEntityType.activity in requested_types:
        for act, course in _fetch_activity_candidates(
            db_session, org.id, terms, filters, visible_course_ids, cap
        ):
            content_text = _extract_activity_text(act.content, act.details)
            score = _score_fields(
                SearchEntityType.activity,
                terms,
                {"name": act.name, "content_text": content_text},
            )
            if score <= 0:
                continue
            if act.published:
                score *= 1.05
            payload = {
                "id": act.id,
                "activity_uuid": act.activity_uuid,
                "name": act.name,
                "activity_type": act.activity_type,
                "activity_sub_type": act.activity_sub_type,
                "published": act.published,
                "course_id": act.course_id,
                "org_id": act.org_id,
                "course_uuid": course.course_uuid,
                "course_name": course.name,
            }
            activity_payloads.append(payload)
            hits.append(
                SearchHit(
                    type=SearchEntityType.activity,
                    id=act.id,
                    uuid=act.activity_uuid,
                    title=act.name,
                    snippet=_snippet(terms, content_text),
                    score=round(score, 4),
                    metadata={
                        "activity_type": act.activity_type,
                        "published": act.published,
                        "course_id": act.course_id,
                        "course_uuid": course.course_uuid,
                        "course_name": course.name,
                    },
                    data=payload,
                )
            )

    # ---- Rank, facet, paginate ------------------------------------------
    hits.sort(key=lambda h: (-h.score, h.type.value, h.id))

    facet_type: Dict[str, int] = {}
    facet_activity_type: Dict[str, int] = {}
    for h in hits:
        facet_type[h.type.value] = facet_type.get(h.type.value, 0) + 1
        if h.type == SearchEntityType.activity:
            at = h.metadata.get("activity_type")
            if at:
                key = at.value if hasattr(at, "value") else str(at)
                facet_activity_type[key] = facet_activity_type.get(key, 0) + 1

    total = len(hits)
    paged = hits[offset : offset + limit]
    paged_ids = {(h.type, h.id) for h in paged}

    def _on_page(t: SearchEntityType, _id: int) -> bool:
        return (t, _id) in paged_ids

    facets: Dict[str, List[SearchFacetBucket]] = {
        "type": sorted(
            (SearchFacetBucket(value=k, count=v) for k, v in facet_type.items()),
            key=lambda b: -b.count,
        )
    }
    if facet_activity_type:
        facets["activity_type"] = sorted(
            (SearchFacetBucket(value=k, count=v) for k, v in facet_activity_type.items()),
            key=lambda b: -b.count,
        )

    return SearchResult(
        courses=[c for c in course_reads if _on_page(SearchEntityType.course, c.id)],
        collections=[c for c in collection_reads if _on_page(SearchEntityType.collection, c.id)],
        users=[u for u in user_reads if _on_page(SearchEntityType.user, u.id)],
        chapters=[c for c in chapter_payloads if _on_page(SearchEntityType.chapter, c["id"])],
        activities=[a for a in activity_payloads if _on_page(SearchEntityType.activity, a["id"])],
        results=paged,
        total=total,
        page=page,
        limit=limit,
        facets=facets,
    )
