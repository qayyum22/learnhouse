import { RequestBodyWithAuthHeader } from "@services/utils/ts/requests"
import { getAPIUrl } from "@services/config/config"
import { getResponseMetadata } from "@services/utils/ts/requests"

export type SearchEntityType =
  | 'course'
  | 'collection'
  | 'user'
  | 'chapter'
  | 'activity'

export interface SearchFilters {
  types?: SearchEntityType[]
  public_only?: boolean
  published_only?: boolean
  course_id?: number
  activity_type?: string
  tag?: string
}

export interface SearchHit {
  type: SearchEntityType
  id: number
  uuid: string
  title: string
  snippet?: string | null
  score: number
  metadata: Record<string, any>
  data: Record<string, any>
}

export interface SearchFacetBucket {
  value: string
  count: number
}

export interface SearchResponse {
  courses: any[]
  collections: any[]
  users: any[]
  chapters: any[]
  activities: any[]
  results: SearchHit[]
  total: number
  page: number
  limit: number
  facets: Record<string, SearchFacetBucket[]>
}

export interface SearchGroupedEntityMap {
  course: { id: number; course_uuid: string; name?: string }
  collection: { id: number; collection_uuid: string; name?: string }
  user: { id: number; user_uuid: string; username: string; first_name?: string; last_name?: string }
  chapter: { id: number; chapter_uuid: string; course_uuid: string; course_name?: string; name?: string }
  activity: { id: number; activity_uuid: string; course_uuid: string; course_name?: string; activity_type?: string; name?: string }
}

export function buildSearchQueryString(
  query: string,
  page: number,
  limit: number,
  filters?: SearchFilters
): string {
  const params = new URLSearchParams()
  params.set('query', query)
  params.set('page', String(page))
  params.set('limit', String(limit))
  if (filters?.types) {
    for (const t of filters.types) params.append('types', t)
  }
  if (filters?.public_only) params.set('public_only', 'true')
  if (filters?.published_only) params.set('published_only', 'true')
  if (filters?.course_id != null) params.set('course_id', String(filters.course_id))
  if (filters?.activity_type) params.set('activity_type', filters.activity_type)
  if (filters?.tag) params.set('tag', filters.tag)
  return params.toString()
}

/**
 * Shared org-wide search client.
 *
 * Signature is backward compatible: existing callers that pass
 * (org_slug, query, page, limit, next, access_token) continue to work.
 * New callers can pass `filters` as the 7th argument.
 */
export async function searchOrgContent(
  org_slug: string,
  query: string,
  page: number = 1,
  limit: number = 10,
  next: any = null,
  access_token?: any,
  filters?: SearchFilters
) {
  const qs = buildSearchQueryString(query, page, limit, filters)
  const result: any = await fetch(
    `${getAPIUrl()}search/org_slug/${org_slug}?${qs}`,
    RequestBodyWithAuthHeader('GET', null, next, access_token)
  )
  const res = await getResponseMetadata(result)
  return res
}

// ---------------------------------------------------------------------------
// Centralized navigation helpers.  Every URL for a search-result entity flows
// through these so stripping logic lives in exactly one place.
// ---------------------------------------------------------------------------

const strip = (uuid: string, prefix: string) =>
  uuid.startsWith(prefix) ? uuid.slice(prefix.length) : uuid

export function courseHref(courseUuid: string): string {
  return `/course/${strip(courseUuid, 'course_')}`
}

export function collectionHref(collectionUuid: string): string {
  return `/collection/${strip(collectionUuid, 'collection_')}`
}

export function userHref(username: string): string {
  return `/user/${username}`
}

export function chapterHref(courseUuid: string, chapterUuid: string): string {
  return `/course/${strip(courseUuid, 'course_')}?chapter=${strip(chapterUuid, 'chapter_')}`
}

export function activityHref(courseUuid: string, activityUuid: string): string {
  return `/course/${strip(courseUuid, 'course_')}/activity/${strip(activityUuid, 'activity_')}`
}

/** Resolve the org-relative path for any SearchHit. */
export function getSearchHitHref(hit: SearchHit): string {
  switch (hit.type) {
    case 'course':
      return courseHref(hit.uuid)
    case 'collection':
      return collectionHref(hit.uuid)
    case 'user':
      return userHref(hit.metadata?.username ?? hit.data?.username ?? '')
    case 'chapter':
      return chapterHref(hit.metadata?.course_uuid ?? '', hit.uuid)
    case 'activity':
      return activityHref(hit.metadata?.course_uuid ?? '', hit.uuid)
    default:
      return `/search?q=${encodeURIComponent(hit.title)}`
  }
}

/** Map entity type to a display label key and lucide icon name. */
export const ENTITY_TYPE_META: Record<SearchEntityType, { labelKey: string; iconName: string }> = {
  course:     { labelKey: 'courses.courses',         iconName: 'BookCopy' },
  collection: { labelKey: 'collections.collections', iconName: 'SquareLibrary' },
  user:       { labelKey: 'common.users',            iconName: 'Users' },
  chapter:    { labelKey: 'search.chapters',         iconName: 'BookOpen' },
  activity:   { labelKey: 'search.activities',       iconName: 'FileText' },
}

export function activityTypeLabel(value?: string | null): string {
  return value ? value.replace(/^TYPE_/, '') : 'Activity'
}

export function toSearchHit<T extends SearchEntityType>(
  type: T,
  row: SearchGroupedEntityMap[T]
): SearchHit {
  let uuid = ''

  switch (type) {
    case 'course':
      uuid = (row as SearchGroupedEntityMap['course']).course_uuid
      break
    case 'collection':
      uuid = (row as SearchGroupedEntityMap['collection']).collection_uuid
      break
    case 'user':
      uuid = (row as SearchGroupedEntityMap['user']).user_uuid
      break
    case 'chapter':
      uuid = (row as SearchGroupedEntityMap['chapter']).chapter_uuid
      break
    case 'activity':
      uuid = (row as SearchGroupedEntityMap['activity']).activity_uuid
      break
  }

  return {
    type,
    id: row.id,
    uuid,
    title:
      ('name' in row && row.name) ||
      ('username' in row && row.username) ||
      '',
    score: 0,
    snippet: null,
    metadata: {
      username: 'username' in row ? row.username : undefined,
      course_uuid: 'course_uuid' in row ? row.course_uuid : undefined,
      course_name: 'course_name' in row ? row.course_name : undefined,
      activity_type: 'activity_type' in row ? row.activity_type : undefined,
    },
    data: row as Record<string, any>,
  }
}
