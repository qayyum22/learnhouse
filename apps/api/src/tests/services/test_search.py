import asyncio

import pytest
from sqlalchemy import JSON
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, Session, create_engine
from starlette.requests import Request

from src.db.organizations import Organization
from src.db.users import AnonymousUser, PublicUser, User
from src.db.user_organizations import UserOrganization
from src.db.collections import Collection
from src.db.courses.courses import Course
from src.db.courses.chapters import Chapter
from src.db.courses.activities import Activity, ActivityTypeEnum, ActivitySubTypeEnum
from src.db.resource_authors import (
    ResourceAuthor,
    ResourceAuthorshipEnum,
    ResourceAuthorshipStatusEnum,
)
from src.services.search.search import (
    SearchEntityType,
    SearchFilters,
    SearchResult,
    _extract_activity_text,
    _score_fields,
    _tokenize,
    search_across_org,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
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


NOW = "2026-04-06T00:00:00"


def _mk_user(db, uid, username, first="", last="", bio=""):
    u = User(
        id=uid,
        username=username,
        first_name=first,
        last_name=last,
        email=f"{username}@example.org",
        bio=bio,
        password="x",
        user_uuid=f"user_{username}",
        creation_date=NOW,
        update_date=NOW,
    )
    db.add(u)
    return u


def _mk_course(db, cid, org_id, name, **kw):
    c = Course(
        id=cid,
        org_id=org_id,
        name=name,
        description=kw.get("description", ""),
        about=kw.get("about", ""),
        learnings=kw.get("learnings", ""),
        tags=kw.get("tags", ""),
        public=kw.get("public", True),
        published=kw.get("published", True),
        open_to_contributors=False,
        course_uuid=f"course_{cid}",
        creation_date=NOW,
        update_date=NOW,
    )
    db.add(c)
    return c


@pytest.fixture
def seeded(db: Session):
    org = Organization(
        id=1, name="Org", slug="org", email="o@o.o", org_uuid="org_1",
        creation_date=NOW, update_date=NOW,
    )
    other_org = Organization(
        id=2, name="Other", slug="other", email="x@x.x", org_uuid="org_2",
        creation_date=NOW, update_date=NOW,
    )
    db.add(org)
    db.add(other_org)

    member = _mk_user(db, 1, "alice", "Alice", "Python", bio="Loves kubernetes")
    outsider = _mk_user(db, 2, "bob", "Bob", "Outsider")
    _mk_user(db, 3, "pythonista", "Py", "Thon", bio="python enthusiast")

    db.add(UserOrganization(id=1, user_id=1, org_id=1, role_id=1))
    db.add(UserOrganization(id=2, user_id=3, org_id=1, role_id=1))
    # bob is NOT a member of org 1
    db.add(UserOrganization(id=3, user_id=2, org_id=2, role_id=1))

    # Courses
    c1 = _mk_course(db, 1, 1, "Python Basics", description="Learn python from scratch",
                    tags="python,beginner")
    c2 = _mk_course(db, 2, 1, "Advanced Kubernetes",
                    description="python scripting for k8s",
                    public=False, published=False)
    c3 = _mk_course(db, 3, 1, "History of Art", description="no match here")
    # Course in another org — must never leak
    _mk_course(db, 4, 2, "Python Elsewhere")

    db.add(ResourceAuthor(
        id=1, resource_uuid=c1.course_uuid, user_id=1,
        authorship=ResourceAuthorshipEnum.CREATOR,
        authorship_status=ResourceAuthorshipStatusEnum.ACTIVE,
        creation_date=NOW, update_date=NOW,
    ))

    # Collection
    db.add(Collection(
        id=1, name="Python Path", description="curated python track",
        public=True, org_id=1, collection_uuid="collection_1",
        creation_date=NOW, update_date=NOW,
    ))
    db.add(Collection(
        id=2, name="Secret Stuff", description="internal",
        public=False, org_id=1, collection_uuid="collection_2",
        creation_date=NOW, update_date=NOW,
    ))

    # Chapter
    db.add(Chapter(
        id=1, name="Python Syntax", description="variables and types",
        org_id=1, course_id=1, chapter_uuid="chapter_1",
        creation_date=NOW, update_date=NOW,
    ))

    # Activities
    db.add(Activity(
        id=1, name="Quiz 1",
        activity_type=ActivityTypeEnum.TYPE_ASSIGNMENT,
        activity_sub_type=ActivitySubTypeEnum.SUBTYPE_ASSIGNMENT_ANY,
        content={
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [
                    {"type": "text", "text": "Explain python decorators in depth."}
                ]}
            ],
        },
        published=True, org_id=1, course_id=1,
        activity_uuid="activity_1", creation_date=NOW, update_date=NOW,
    ))
    db.add(Activity(
        id=2, name="Python Intro Video",
        activity_type=ActivityTypeEnum.TYPE_VIDEO,
        activity_sub_type=ActivitySubTypeEnum.SUBTYPE_VIDEO_YOUTUBE,
        content={}, published=True, org_id=1, course_id=1,
        activity_uuid="activity_2", creation_date=NOW, update_date=NOW,
    ))
    db.add(Activity(
        id=3, name="Unrelated",
        activity_type=ActivityTypeEnum.TYPE_DOCUMENT,
        activity_sub_type=ActivitySubTypeEnum.SUBTYPE_DOCUMENT_PDF,
        content={}, published=True, org_id=1, course_id=2,
        activity_uuid="activity_3", creation_date=NOW, update_date=NOW,
    ))

    db.commit()

    return {
        "org": org,
        "member": PublicUser.model_validate(member),
        "outsider": PublicUser.model_validate(outsider),
    }


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ---------------------------------------------------------------------------
# Unit-level relevance tests
# ---------------------------------------------------------------------------

def test_tokenize_drops_short_tokens_when_multiple():
    assert _tokenize("Intro to Python 3") == ["Intro", "to", "Python"]
    assert _tokenize("a") == ["a"]
    assert _tokenize("  ") == []


def test_score_fields_prefers_name_over_description():
    name_hit = _score_fields(
        SearchEntityType.course, ["python"],
        {"name": "Python Basics", "tags": "", "description": "", "learnings": "", "about": ""},
    )
    desc_hit = _score_fields(
        SearchEntityType.course, ["python"],
        {"name": "Basics", "tags": "", "description": "all about python", "learnings": "", "about": ""},
    )
    assert name_hit > desc_hit > 0


def test_score_fields_rewards_term_coverage():
    both = _score_fields(
        SearchEntityType.course, ["python", "basics"],
        {"name": "Python Basics", "tags": "", "description": "", "learnings": "", "about": ""},
    )
    one = _score_fields(
        SearchEntityType.course, ["python", "basics"],
        {"name": "Python", "tags": "", "description": "", "learnings": "", "about": ""},
    )
    assert both > one


def test_extract_activity_text_handles_tiptap_and_caps():
    doc = {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "hello world"}]},
            {"type": "image", "attrs": {"src": "https://x/y.png", "alt": "diagram"}},
        ],
    }
    out = _extract_activity_text(doc, {"description": "extra"})
    assert "hello world" in out
    assert "diagram" in out
    assert "extra" in out
    assert "https://" not in out  # non-text keys ignored


# ---------------------------------------------------------------------------
# Integration-level tests
# ---------------------------------------------------------------------------

def test_member_search_ranks_course_first_and_returns_all_types(db, http_request, seeded):
    res: SearchResult = _run(search_across_org(
        http_request, seeded["member"], "org", "python", db, page=1, limit=20,
    ))

    types = {h.type for h in res.results}
    assert types == {
        SearchEntityType.course,
        SearchEntityType.collection,
        SearchEntityType.user,
        SearchEntityType.chapter,
        SearchEntityType.activity,
    }

    # Top hit should be the course with "Python" in the name (highest weight + type boost)
    assert res.results[0].type == SearchEntityType.course
    assert res.results[0].title == "Python Basics"

    # Scores are non-increasing
    scores = [h.score for h in res.results]
    assert scores == sorted(scores, reverse=True)

    # Facets include all matched types
    facet_types = {b.value for b in res.facets["type"]}
    assert "course" in facet_types and "activity" in facet_types

    # Org isolation — course from org 2 must not appear
    assert all("Elsewhere" not in h.title for h in res.results)


def test_activity_content_match_without_title_match(db, http_request, seeded):
    """'decorators' only appears inside activity JSON content, not any title."""
    res = _run(search_across_org(
        http_request, seeded["member"], "org", "decorators", db, page=1, limit=20,
    ))
    activity_hits = [h for h in res.results if h.type == SearchEntityType.activity]
    assert len(activity_hits) == 1
    assert activity_hits[0].uuid == "activity_1"
    assert activity_hits[0].snippet and "decorators" in activity_hits[0].snippet.lower()


def test_type_filter_restricts_results(db, http_request, seeded):
    res = _run(search_across_org(
        http_request, seeded["member"], "org", "python", db, page=1, limit=20,
        filters=SearchFilters(types=[SearchEntityType.collection]),
    ))
    assert res.results
    assert all(h.type == SearchEntityType.collection for h in res.results)
    assert res.courses == [] and res.users == []


def test_activity_type_filter(db, http_request, seeded):
    res = _run(search_across_org(
        http_request, seeded["member"], "org", "python", db, page=1, limit=20,
        filters=SearchFilters(
            types=[SearchEntityType.activity],
            activity_type=ActivityTypeEnum.TYPE_VIDEO,
        ),
    ))
    assert [h.uuid for h in res.results] == ["activity_2"]
    assert res.facets.get("activity_type")
    assert res.facets["activity_type"][0].value == ActivityTypeEnum.TYPE_VIDEO.value


def test_published_only_filter_excludes_draft_course(db, http_request, seeded):
    res = _run(search_across_org(
        http_request, seeded["member"], "org", "kubernetes", db, page=1, limit=20,
    ))
    course_ids = {h.id for h in res.results if h.type == SearchEntityType.course}
    assert 2 in course_ids  # draft visible to members by default

    res2 = _run(search_across_org(
        http_request, seeded["member"], "org", "kubernetes", db, page=1, limit=20,
        filters=SearchFilters(published_only=True),
    ))
    course_ids2 = {h.id for h in res2.results if h.type == SearchEntityType.course}
    assert 2 not in course_ids2


def test_anonymous_access_control(db, http_request, seeded):
    res = _run(search_across_org(
        http_request, AnonymousUser(), "org", "python", db, page=1, limit=20,
    ))
    types = {h.type for h in res.results}
    # Anonymous: no users, chapters, or activities
    assert SearchEntityType.user not in types
    assert SearchEntityType.chapter not in types
    assert SearchEntityType.activity not in types
    # Only public collections
    assert all(c.public for c in res.collections)
    # Only public+published courses (course 2 is private/draft)
    assert all(h.id != 2 for h in res.results if h.type == SearchEntityType.course)


def test_non_member_cannot_enumerate_users(db, http_request, seeded):
    res = _run(search_across_org(
        http_request, seeded["outsider"], "org", "python", db, page=1, limit=20,
    ))
    assert all(h.type != SearchEntityType.user for h in res.results)
    assert res.users == []


def test_pagination_slices_unified_results(db, http_request, seeded):
    full = _run(search_across_org(
        http_request, seeded["member"], "org", "python", db, page=1, limit=50,
    ))
    assert full.total == len(full.results)
    assert full.total >= 4

    p1 = _run(search_across_org(
        http_request, seeded["member"], "org", "python", db, page=1, limit=2,
    ))
    p2 = _run(search_across_org(
        http_request, seeded["member"], "org", "python", db, page=2, limit=2,
    ))
    assert len(p1.results) == 2 and len(p2.results) == 2
    ids1 = {(h.type, h.id) for h in p1.results}
    ids2 = {(h.type, h.id) for h in p2.results}
    assert ids1.isdisjoint(ids2)
    assert p1.total == p2.total == full.total

    # Grouped arrays only contain items from the current page
    for read in p1.courses:
        assert (SearchEntityType.course, read.id) in ids1


# ---------------------------------------------------------------------------
# Response-shape / UI data-flow contract
# ---------------------------------------------------------------------------

def test_response_shape_contract_for_ui(db, http_request, seeded):
    """Asserts the exact fields consumed by SearchBar.tsx and search/page.tsx.

    The search page now iterates response.results[] (unified ranked list) and
    renders each hit via SearchResultCard which reads hit.data for type-specific
    fields.  The SearchBar still reads the grouped arrays.  Both use
    getSearchHitHref which reads hit.metadata.course_uuid for deep links.
    """
    res = _run(search_across_org(
        http_request, seeded["member"], "org", "python", db, page=1, limit=20,
    ))
    dumped = res.model_dump()

    # Top-level keys consumed by the UI
    for key in ("courses", "collections", "users", "chapters", "activities",
                "results", "total", "page", "limit", "facets"):
        assert key in dumped

    # -- Unified results (search page renders these) --

    # Every hit must have the fields SearchResultCard reads
    for hit in dumped["results"]:
        assert "type" in hit and "id" in hit and "uuid" in hit
        assert "title" in hit and "score" in hit
        assert "metadata" in hit and "data" in hit

    # Course hit — data must carry author + thumbnail for CourseCard
    course_hit = next(h for h in dumped["results"]
                      if h["type"] == "course" and h["id"] == 1)
    assert course_hit["data"]["authors"], "course authors must be hydrated for CourseCard"
    assert course_hit["data"]["authors"][0]["user"]["username"] == "alice"
    assert "thumbnail_image" in course_hit["data"]
    assert "course_uuid" in course_hit["data"]

    # Chapter hit — metadata must carry course_uuid + course_name for
    # getSearchHitHref() and ChapterCard
    ch_hit = next(h for h in dumped["results"]
                  if h["type"] == "chapter" and h["id"] == 1)
    assert ch_hit["metadata"]["course_uuid"] == "course_1"
    assert ch_hit["metadata"]["course_name"] == "Python Basics"

    # Activity hit — same navigation metadata
    act_hit = next(h for h in dumped["results"]
                   if h["type"] == "activity" and h["id"] == 2)
    assert act_hit["metadata"]["course_uuid"] == "course_1"
    assert act_hit["metadata"]["activity_type"] == ActivityTypeEnum.TYPE_VIDEO.value

    # User hit — metadata must carry username for userHref()
    user_hit = next(h for h in dumped["results"] if h["type"] == "user")
    assert "username" in user_hit["metadata"]

    # -- Grouped arrays (SearchBar still reads these) --

    # Course author data preserved for SearchBar's course section
    course = next(c for c in dumped["courses"] if c["id"] == 1)
    assert course["authors"], "grouped courses must keep authors for SearchBar"
    assert "course_uuid" in course

    # Chapter/activity grouped payloads carry navigation fields
    chapter = next(c for c in dumped["chapters"] if c["id"] == 1)
    assert chapter["course_uuid"] == "course_1"
    assert chapter["course_name"] == "Python Basics"
    assert chapter["chapter_uuid"] == "chapter_1"

    activity = next(a for a in dumped["activities"] if a["id"] == 2)
    assert activity["course_uuid"] == "course_1"
    assert activity["activity_uuid"] == "activity_2"

    # Facets drive filter-chip counts in the UI
    type_facet = {b["value"]: b["count"] for b in dumped["facets"]["type"]}
    assert type_facet.get("course", 0) >= 1
    assert type_facet.get("activity", 0) >= 1


def test_tag_filter_restricts_courses(db, http_request, seeded):
    res = _run(search_across_org(
        http_request, seeded["member"], "org", "python", db, page=1, limit=20,
        filters=SearchFilters(tag="beginner"),
    ))
    course_hits = [h for h in res.results if h.type == SearchEntityType.course]
    assert len(course_hits) == 1
    assert course_hits[0].id == 1  # "Python Basics" has tag "beginner"


def test_course_id_filter_scopes_chapters_and_activities(db, http_request, seeded):
    res = _run(search_across_org(
        http_request, seeded["member"], "org", "python", db, page=1, limit=20,
        filters=SearchFilters(course_id=1),
    ))
    # Only course 1, chapter 1, and activities from course 1 should appear
    for h in res.results:
        if h.type in (SearchEntityType.chapter, SearchEntityType.activity):
            assert h.metadata["course_id"] == 1 or h.data.get("course_id") == 1
        if h.type == SearchEntityType.course:
            assert h.id == 1
