'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  searchOrgContent,
  getSearchHitHref,
  activityTypeLabel,
  SearchEntityType,
  SearchFilters,
  SearchResponse,
  SearchHit,
} from '@services/search/search';
import { useLHSession } from '@components/Contexts/LHSessionContext';
import { useOrg } from '@components/Contexts/OrgContext';
import {
  BookCopy,
  SquareLibrary,
  Users,
  Search,
  BookOpen,
  FileText,
  Tag,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { getCourseThumbnailMediaDirectory, getUserAvatarMediaDirectory } from '@services/media/media';
import { getUriWithOrg } from '@services/config/config';
import UserAvatar from '@components/Objects/UserAvatar';
import { useTranslation } from 'react-i18next';

// ---------------------------------------------------------------------------
// Icon map — resolves entity type to a lucide icon component
// ---------------------------------------------------------------------------

const TYPE_ICONS: Record<SearchEntityType | 'all', React.ComponentType<{ size?: number; className?: string }>> = {
  all: Search,
  course: BookCopy,
  collection: SquareLibrary,
  user: Users,
  chapter: BookOpen,
  activity: FileText,
};

type ContentType = 'all' | SearchEntityType;

const EMPTY_RESPONSE: SearchResponse = {
  courses: [],
  collections: [],
  users: [],
  chapters: [],
  activities: [],
  results: [],
  total: 0,
  page: 1,
  limit: 12,
  facets: {},
};

// ---------------------------------------------------------------------------
// Per-type result cards rendered from SearchHit.data
// ---------------------------------------------------------------------------

function CourseCard({ hit, org }: { hit: SearchHit; org: any }) {
  const d = hit.data;
  return (
    <div className="bg-white rounded-xl nice-shadow hover:shadow-md transition-all overflow-hidden group">
      <div className="relative h-40">
        {d.thumbnail_image ? (
          <img
            src={getCourseThumbnailMediaDirectory(org?.org_uuid, d.course_uuid, d.thumbnail_image)}
            alt={d.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full bg-black/5 flex items-center justify-center">
            <BookCopy size={28} className="text-black/40" />
          </div>
        )}
      </div>
      <div className="p-4">
        <h3 className="text-sm font-medium text-black/80 mb-1">{d.name}</h3>
        {hit.snippet && <p className="text-xs text-black/50 line-clamp-2">{hit.snippet}</p>}
        {d.authors && d.authors.length > 0 && (
          <div className="flex items-center gap-2 mt-3">
            <UserAvatar
              width={20}
              avatar_url={
                d.authors[0].user.avatar_image
                  ? getUserAvatarMediaDirectory(d.authors[0].user.user_uuid, d.authors[0].user.avatar_image)
                  : ''
              }
              predefined_avatar={d.authors[0].user.avatar_image ? undefined : 'empty'}
              userId={d.authors[0].user.id.toString()}
              showProfilePopup={false}
              rounded="rounded-full"
              backgroundColor="bg-gray-100"
            />
            <span className="text-xs text-black/40">
              {d.authors[0].user.first_name} {d.authors[0].user.last_name}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function CollectionCard({ hit }: { hit: SearchHit }) {
  const d = hit.data;
  return (
    <div className="flex items-start gap-4 p-4 bg-white rounded-xl nice-shadow hover:shadow-md transition-all">
      <div className="w-12 h-12 bg-black/5 rounded-lg flex items-center justify-center flex-shrink-0">
        <SquareLibrary size={24} className="text-black/40" />
      </div>
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-black/80 mb-1 truncate">{d.name}</h3>
        {hit.snippet && <p className="text-xs text-black/50 line-clamp-2">{hit.snippet}</p>}
      </div>
    </div>
  );
}

function UserCard({ hit }: { hit: SearchHit }) {
  const d = hit.data;
  return (
    <div className="flex items-center gap-4 p-4 bg-white rounded-xl nice-shadow hover:shadow-md transition-all">
      <UserAvatar
        width={48}
        avatar_url={d.avatar_image ? getUserAvatarMediaDirectory(d.user_uuid, d.avatar_image) : ''}
        predefined_avatar={d.avatar_image ? undefined : 'empty'}
        userId={d.id?.toString?.() ?? ''}
        showProfilePopup
        rounded="rounded-full"
        backgroundColor="bg-gray-100"
      />
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-black/80 truncate">
          {d.first_name} {d.last_name}
        </h3>
        <p className="text-xs text-black/50 truncate">@{d.username}</p>
        {hit.snippet && <p className="text-xs text-black/40 mt-1 line-clamp-1">{hit.snippet}</p>}
      </div>
    </div>
  );
}

function ChapterCard({ hit, t }: { hit: SearchHit; t: any }) {
  return (
    <div className="flex items-start gap-4 p-4 bg-white rounded-xl nice-shadow hover:shadow-md transition-all">
      <div className="w-12 h-12 bg-black/5 rounded-lg flex items-center justify-center flex-shrink-0">
        <BookOpen size={24} className="text-black/40" />
      </div>
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-black/80 mb-1 truncate">{hit.title}</h3>
        {hit.snippet && <p className="text-xs text-black/50 line-clamp-2">{hit.snippet}</p>}
        <p className="text-[11px] text-black/40 mt-1">
          {t('search.in_course', 'in')}{' '}
          <span className="font-medium">{hit.metadata.course_name}</span>
        </p>
      </div>
    </div>
  );
}

function ActivityCard({ hit, t }: { hit: SearchHit; t: any }) {
  const label = activityTypeLabel(
    typeof hit.metadata.activity_type === 'string' ? hit.metadata.activity_type : undefined
  );
  return (
    <div className="flex items-start gap-4 p-4 bg-white rounded-xl nice-shadow hover:shadow-md transition-all">
      <div className="w-12 h-12 bg-black/5 rounded-lg flex items-center justify-center flex-shrink-0">
        <FileText size={24} className="text-black/40" />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-sm font-medium text-black/80 truncate">{hit.title}</h3>
          {label && (
            <span className="text-[10px] font-medium text-black/40 uppercase tracking-wide whitespace-nowrap">
              {label}
            </span>
          )}
        </div>
        {hit.snippet && <p className="text-xs text-black/50 line-clamp-2">{hit.snippet}</p>}
        <p className="text-[11px] text-black/40 mt-1">
          {t('search.in_course', 'in')}{' '}
          <span className="font-medium">{hit.metadata.course_name}</span>
        </p>
      </div>
    </div>
  );
}

function SearchResultCard({ hit, org, t }: { hit: SearchHit; org: any; t: any }) {
  const href = getUriWithOrg(org?.slug, getSearchHitHref(hit));
  return (
    <Link href={href} className="block">
      {hit.type === 'course' && <CourseCard hit={hit} org={org} />}
      {hit.type === 'collection' && <CollectionCard hit={hit} />}
      {hit.type === 'user' && <UserCard hit={hit} />}
      {hit.type === 'chapter' && <ChapterCard hit={hit} t={t} />}
      {hit.type === 'activity' && <ActivityCard hit={hit} t={t} />}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function SearchPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const session = useLHSession() as any;
  const org = useOrg() as any;

  const [response, setResponse] = useState<SearchResponse>(EMPTY_RESPONSE);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState(searchParams.get('q') || '');

  // URL-driven filter state
  const query = searchParams.get('q') || '';
  const page = parseInt(searchParams.get('page') || '1');
  const selectedType: ContentType = (searchParams.get('type') as ContentType) || 'all';
  const publishedOnly = searchParams.get('published') === '1';
  const publicOnly = searchParams.get('public') === '1';
  const tagFilter = searchParams.get('tag') || '';
  const activityTypeFilter = searchParams.get('activity_type') || '';
  const perPage = 12;
  const [tagInput, setTagInput] = useState(tagFilter);

  const updateSearchParams = (updates: Record<string, string>) => {
    const current = new URLSearchParams(Array.from(searchParams.entries()));
    Object.entries(updates).forEach(([key, value]) => {
      if (value) {
        current.set(key, value);
      } else {
        current.delete(key);
      }
    });
    router.push(`?${current.toString()}`);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      updateSearchParams({ q: searchQuery, page: '1' });
    }
  };

  useEffect(() => {
    setSearchQuery(query);
  }, [query]);

  useEffect(() => {
    setTagInput(tagFilter);
  }, [tagFilter]);

  useEffect(() => {
    const fetchResults = async () => {
      if (!query.trim()) {
        setResponse(EMPTY_RESPONSE);
        return;
      }

      setIsLoading(true);
      try {
        const filters: SearchFilters = {
          types: selectedType === 'all' ? undefined : [selectedType],
          published_only: publishedOnly,
          public_only: publicOnly,
          tag: tagFilter || undefined,
          activity_type: activityTypeFilter || undefined,
        };
        const res = await searchOrgContent(
          org?.slug,
          query,
          page,
          perPage,
          null,
          session?.data?.tokens?.access_token,
          filters
        );

        const data = (res.data ?? EMPTY_RESPONSE) as SearchResponse;
        setResponse({
          ...EMPTY_RESPONSE,
          ...data,
          results: data.results ?? [],
          total: data.total ?? 0,
          facets: data.facets ?? {},
        });
      } catch (error) {
        console.error('Error searching content:', error);
        setResponse(EMPTY_RESPONSE);
      }
      setIsLoading(false);
    };

    fetchResults();
  }, [query, page, selectedType, publishedOnly, publicOnly, tagFilter, activityTypeFilter, org?.slug, session?.data?.tokens?.access_token]);

  // Facet helpers
  const facetCount = (value: string) =>
    response.facets.type?.find((b) => b.value === value)?.count ?? 0;

  const activityTypeFacets = useMemo(
    () => response.facets.activity_type ?? [],
    [response.facets.activity_type]
  );

  const totalResults = response.total;
  const totalPages = Math.max(1, Math.ceil(totalResults / perPage));

  // Active filter pills
  const activeFilters: { key: string; label: string; clear: () => void }[] = [];
  if (tagFilter)
    activeFilters.push({
      key: 'tag',
      label: `Tag: ${tagFilter}`,
      clear: () => updateSearchParams({ tag: '', page: '1' }),
    });
  if (activityTypeFilter)
    activeFilters.push({
      key: 'activity_type',
      label: activityTypeFilter.replace('TYPE_', ''),
      clear: () => updateSearchParams({ activity_type: '', page: '1' }),
    });
  if (publishedOnly)
    activeFilters.push({
      key: 'published',
      label: t('search.published_only', 'Published only'),
      clear: () => updateSearchParams({ published: '', page: '1' }),
    });
  if (publicOnly)
    activeFilters.push({
      key: 'public',
      label: t('search.public_only', 'Public only'),
      clear: () => updateSearchParams({ public: '', page: '1' }),
    });

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Search Header */}
      <div className="bg-white border-b border-black/5">
        <div className="container mx-auto px-4 py-6">
          <div className="max-w-3xl mx-auto">
            <h1 className="text-2xl font-semibold text-black/80 mb-6">{t('common.search')}</h1>

            {/* Search Input */}
            <form onSubmit={handleSearch} className="relative group mb-5">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label={t('search.search_placeholder')}
                placeholder={t('search.search_placeholder')}
                className="w-full h-12 pl-12 pr-4 rounded-xl nice-shadow bg-white
                           focus:outline-none focus:ring-1 focus:ring-black/5 focus:border-black/20
                           text-sm placeholder:text-black/40 transition-all"
              />
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <Search className="text-black/40 group-focus-within:text-black/60 transition-colors" size={20} />
              </div>
              <button
                type="submit"
                className="absolute inset-y-0 right-0 px-4 flex items-center text-sm text-black/60 hover:text-black/80"
              >
                {t('common.search')}
              </button>
            </form>

            {/* Type filter chips */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {(['all', 'course', 'collection', 'user', 'chapter', 'activity'] as ContentType[]).map(
                (tp) => {
                  const Icon = TYPE_ICONS[tp];
                  const count = tp === 'all' ? totalResults : facetCount(tp);
                  return (
                    <button
                      key={tp}
                      onClick={() => updateSearchParams({ type: tp === 'all' ? '' : tp, page: '1' })}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors whitespace-nowrap ${
                        selectedType === tp
                          ? 'bg-black/10 text-black/80 font-medium'
                          : 'hover:bg-black/5 text-black/60'
                      }`}
                    >
                      <Icon size={16} />
                      <span>{t(tp === 'all' ? 'all' : `search.type_${tp}`, tp)}</span>
                      <span className="text-black/40">({count})</span>
                    </button>
                  );
                }
              )}
            </div>

            {/* Extra filters row */}
            <div className="flex flex-wrap items-center gap-3 mt-3">
              {/* Published toggle */}
              <button
                onClick={() => updateSearchParams({ published: publishedOnly ? '' : '1', page: '1' })}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors border ${
                  publishedOnly
                    ? 'border-black/20 bg-black/5 text-black/80 font-medium'
                    : 'border-black/10 hover:bg-black/5 text-black/50'
                }`}
              >
                {t('search.published_only', 'Published only')}
              </button>

              <button
                onClick={() => updateSearchParams({ public: publicOnly ? '' : '1', page: '1' })}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors border ${
                  publicOnly
                    ? 'border-black/20 bg-black/5 text-black/80 font-medium'
                    : 'border-black/10 hover:bg-black/5 text-black/50'
                }`}
              >
                {t('search.public_only', 'Public only')}
              </button>

              {/* Tag input */}
              <form
                className="relative"
                onSubmit={(e) => {
                  e.preventDefault();
                  updateSearchParams({ tag: tagInput.trim(), page: '1' });
                }}
              >
                <Tag size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-black/30" />
                <input
                  type="text"
                  placeholder={t('search.filter_by_tag', 'Filter by tag...')}
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  className="h-7 pl-7 pr-3 text-xs rounded-lg border border-black/10 bg-white
                             focus:outline-none focus:ring-1 focus:ring-black/10 w-36 placeholder:text-black/30"
                />
              </form>

              {/* Activity type dropdown (only shown when activity facets exist) */}
              {activityTypeFacets.length > 0 && (
                <select
                  value={activityTypeFilter}
                  onChange={(e) => updateSearchParams({ activity_type: e.target.value, page: '1' })}
                  className="h-7 px-2 text-xs rounded-lg border border-black/10 bg-white
                             focus:outline-none focus:ring-1 focus:ring-black/10 text-black/60"
                >
                  <option value="">{t('search.all_activity_types', 'All activity types')}</option>
                  {activityTypeFacets.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.value.replace('TYPE_', '')} ({f.count})
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Active filter pills */}
            {activeFilters.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mt-3">
                {activeFilters.map((af) => (
                  <span
                    key={af.key}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-black/5 text-xs text-black/60"
                  >
                    {af.label}
                    <button
                      onClick={af.clear}
                      className="hover:text-black/80 transition-colors"
                      aria-label={`Clear ${af.label}`}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Unified ranked results */}
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">
          {query && (
            <div className="text-sm text-black/60 mb-6">
              {t('search.found_results', { count: totalResults, query })}
            </div>
          )}

          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="bg-white rounded-xl nice-shadow p-4 animate-pulse">
                  <div className="flex gap-4">
                    <div className="w-12 h-12 bg-black/5 rounded-lg flex-shrink-0" />
                    <div className="flex-1 space-y-2">
                      <div className="w-3/4 h-4 bg-black/5 rounded" />
                      <div className="w-1/2 h-3 bg-black/5 rounded" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : totalResults === 0 && query ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="mb-4 p-4 bg-black/5 rounded-full">
                <Search className="w-8 h-8 text-black/40" />
              </div>
              <h3 className="text-lg font-medium text-black/80 mb-2">{t('search.no_results_found')}</h3>
              <p className="text-sm text-black/50 max-w-md">
                {t('search.no_results_description', { query })}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {response.results.map((hit) => (
                <SearchResultCard
                  key={`${hit.type}-${hit.id}`}
                  hit={hit}
                  org={org}
                  t={t}
                />
              ))}
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex justify-center gap-2 mt-8">
              {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1).map((pageNum) => (
                <button
                  key={pageNum}
                  onClick={() => updateSearchParams({ page: pageNum.toString() })}
                  className={`w-8 h-8 rounded-lg text-sm transition-colors ${
                    page === pageNum
                      ? 'bg-black/10 text-black/80 font-medium'
                      : 'hover:bg-black/5 text-black/60'
                  }`}
                >
                  {pageNum}
                </button>
              ))}
              {totalPages > 10 && (
                <span className="w-8 h-8 flex items-center justify-center text-sm text-black/40">...</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default SearchPage;
