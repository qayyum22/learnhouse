'use client'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { useOrg } from '@components/Contexts/OrgContext'
import { getAPIUrl, getUriWithOrg } from '@services/config/config'
import { swrFetcher } from '@services/utils/ts/requests'
import {
  Clock,
  Flame,
  Target,
  Trophy,
  CheckCircle,
  CalendarClock,
  ChevronRight,
  AlertCircle,
} from 'lucide-react'
import Link from 'next/link'
import useSWR from 'swr'
import { useTranslation } from 'react-i18next'

interface LearnerDashboardProps {
  orgslug: string
}

interface DashboardDeadline {
  assignment_uuid: string
  title: string
  due_date: string
  course_name: string
  course_uuid: string
  activity_uuid: string
}

interface DashboardActivityDay {
  date: string
  count: number
}

interface DashboardData {
  overall_completion_percent: number
  total_activities: number
  completed_activities: number
  courses_in_progress: number
  courses_completed: number
  current_streak_days: number
  last_activity_date: string | null
  time_spent_minutes: number
  recent_activity: DashboardActivityDay[]
  upcoming_deadlines: DashboardDeadline[]
}

function heatColor(count: number) {
  if (count === 0) return 'bg-gray-100'
  if (count === 1) return 'bg-teal-200'
  if (count === 2) return 'bg-teal-300'
  if (count <= 4) return 'bg-teal-400'
  return 'bg-teal-500'
}

function formatDueDate(iso: string, locale: string) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const diffMs = d.getTime() - Date.now()
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24))
  const formatted = d.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
  })
  if (diffDays >= 0 && diffDays <= 7) {
    return `${formatted} · ${diffDays}d`
  }
  return formatted
}

function formatTimeSpent(minutes: number, t: (key: string, opts?: any) => string) {
  if (minutes < 60) {
    return t('trail.dashboard.time_minutes', { count: minutes })
  }
  const hours = Math.floor(minutes / 60)
  const remaining = minutes % 60
  if (remaining === 0) {
    return t('trail.dashboard.time_hours', { count: hours })
  }
  return t('trail.dashboard.time_hours_minutes', { hours, minutes: remaining })
}

function LearnerDashboard({ orgslug }: LearnerDashboardProps) {
  const { t, i18n } = useTranslation()
  const session = useLHSession() as any
  const access_token = session?.data?.tokens?.access_token
  const org = useOrg() as any
  const orgID = org?.id

  const { data, error, isLoading } = useSWR<DashboardData>(
    orgID && access_token
      ? `${getAPIUrl()}trail/org/${orgID}/dashboard`
      : null,
    (url: string) => swrFetcher(url, access_token)
  )

  if (!orgID || !access_token || isLoading) {
    return (
      <div className="mb-8 grid grid-cols-2 md:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-24 bg-white rounded-xl nice-shadow animate-pulse"
          />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="mb-8 flex items-center gap-2 rounded-xl bg-red-50 p-4 text-sm text-red-700">
        <AlertCircle size={16} className="shrink-0" />
        {t('trail.dashboard.error_loading')}
      </div>
    )
  }

  if (!data) return null

  const hasEnrollment =
    data.courses_in_progress > 0 || data.courses_completed > 0
  if (!hasEnrollment) return null

  const pct = data.overall_completion_percent
  const circumference = 2 * Math.PI * 36
  const dashOffset = circumference * (1 - pct / 100)

  return (
    <div className="mb-8 space-y-4">
      {/* Stat tiles */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {/* Overall completion with ring */}
        <div className="bg-white rounded-xl nice-shadow p-4 flex items-center gap-4">
          <div className="relative w-[72px] h-[72px] shrink-0">
            <svg
              width="72"
              height="72"
              viewBox="0 0 80 80"
              className="-rotate-90"
            >
              <circle
                cx="40"
                cy="40"
                r="36"
                fill="none"
                stroke="currentColor"
                strokeWidth="6"
                className="text-gray-100"
              />
              <circle
                cx="40"
                cy="40"
                r="36"
                fill="none"
                stroke="currentColor"
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                className={pct >= 100 ? 'text-green-500' : 'text-teal-500'}
                style={{ transition: 'stroke-dashoffset 0.4s ease' }}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-base font-bold text-gray-900">
                {pct}%
              </span>
            </div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-gray-500 mb-0.5">
              <Target size={14} />
              <span className="text-[10px] font-bold uppercase tracking-wider">
                {t('trail.dashboard.overall_progress')}
              </span>
            </div>
            <div className="text-xs text-gray-400">
              {t('courses.completed_of', {
                completed: data.completed_activities,
                total: data.total_activities,
              })}
            </div>
          </div>
        </div>

        {/* Time spent */}
        <div className="bg-white rounded-xl nice-shadow p-4 flex flex-col justify-between">
          <div className="flex items-center gap-1.5 text-gray-500">
            <Clock size={14} className={data.time_spent_minutes > 0 ? 'text-blue-500' : ''} />
            <span className="text-[10px] font-bold uppercase tracking-wider">
              {t('trail.dashboard.time_spent')}
            </span>
          </div>
          <span className="text-lg font-bold text-gray-900 leading-tight">
            {formatTimeSpent(data.time_spent_minutes, t)}
          </span>
          <span className="text-[10px] text-gray-400">
            {t('trail.dashboard.time_estimated')}
          </span>
        </div>

        {/* Streak */}
        <div className="bg-white rounded-xl nice-shadow p-4 flex flex-col justify-between">
          <div className="flex items-center gap-1.5 text-gray-500">
            <Flame
              size={14}
              className={
                data.current_streak_days > 0 ? 'text-orange-500' : ''
              }
            />
            <span className="text-[10px] font-bold uppercase tracking-wider">
              {t('trail.dashboard.streak')}
            </span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-3xl font-bold text-gray-900 leading-none">
              {data.current_streak_days}
            </span>
            <span className="text-sm text-gray-400">
              {t('trail.dashboard.days')}
            </span>
          </div>
          {data.current_streak_days > 0 ? (
            <span className="text-[10px] text-orange-600 font-semibold uppercase tracking-wider">
              {t('trail.dashboard.keep_going')}
            </span>
          ) : (
            <span className="text-[10px] text-gray-400">
              {t('trail.dashboard.complete_activity_to_start')}
            </span>
          )}
        </div>

        {/* In progress */}
        <div className="bg-white rounded-xl nice-shadow p-4 flex flex-col justify-between">
          <div className="flex items-center gap-1.5 text-gray-500">
            <CheckCircle size={14} />
            <span className="text-[10px] font-bold uppercase tracking-wider">
              {t('trail.dashboard.in_progress')}
            </span>
          </div>
          <span className="text-3xl font-bold text-gray-900 leading-none">
            {data.courses_in_progress}
          </span>
          <span className="text-[10px] text-gray-400 uppercase tracking-wider">
            {t('courses.courses')}
          </span>
        </div>

        {/* Completed */}
        <div className="bg-white rounded-xl nice-shadow p-4 flex flex-col justify-between">
          <div className="flex items-center gap-1.5 text-gray-500">
            <Trophy
              size={14}
              className={data.courses_completed > 0 ? 'text-yellow-500' : ''}
            />
            <span className="text-[10px] font-bold uppercase tracking-wider">
              {t('common.completed')}
            </span>
          </div>
          <span className="text-3xl font-bold text-gray-900 leading-none">
            {data.courses_completed}
          </span>
          <span className="text-[10px] text-gray-400 uppercase tracking-wider">
            {t('courses.courses')}
          </span>
        </div>
      </div>

      {/* Activity heatmap + deadlines */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Heatmap */}
        <div className="lg:col-span-2 bg-white rounded-xl nice-shadow p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
              {t('trail.dashboard.last_30_days')}
            </span>
            {data.last_activity_date && (
              <span className="text-[10px] text-gray-400">
                {t('trail.dashboard.last_active')}{' '}
                {new Date(data.last_activity_date).toLocaleDateString(
                  i18n.language,
                  { month: 'short', day: 'numeric' }
                )}
              </span>
            )}
          </div>
          <div className="grid grid-cols-[repeat(30,minmax(0,1fr))] gap-1">
            {data.recent_activity.map((day) => (
              <div
                key={day.date}
                title={`${day.date}${day.count > 0 ? ` · ${day.count}` : ''}`}
                className={`aspect-square rounded-sm ${heatColor(day.count)}`}
              />
            ))}
          </div>
        </div>

        {/* Upcoming deadlines */}
        <div className="bg-white rounded-xl nice-shadow p-4">
          <div className="flex items-center gap-1.5 text-gray-500 mb-3">
            <CalendarClock size={14} />
            <span className="text-[10px] font-bold uppercase tracking-wider">
              {t('trail.dashboard.upcoming_deadlines')}
            </span>
          </div>
          {data.upcoming_deadlines.length === 0 ? (
            <div className="text-xs text-gray-400 py-2">
              {t('trail.dashboard.no_upcoming_deadlines')}
            </div>
          ) : (
            <div className="space-y-2">
              {data.upcoming_deadlines.map((dl) => {
                const courseId = dl.course_uuid.replace('course_', '')
                const activityId = dl.activity_uuid.replace('activity_', '')
                return (
                  <Link
                    key={dl.assignment_uuid}
                    href={getUriWithOrg(
                      orgslug,
                      `/course/${courseId}/activity/${activityId}`
                    )}
                    className="flex items-center justify-between gap-2 p-2 -mx-2 rounded-lg hover:bg-gray-50 transition-colors group"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-gray-900 truncate">
                        {dl.title}
                      </div>
                      <div className="text-xs text-gray-400 truncate">
                        {dl.course_name}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="text-xs font-semibold text-amber-600">
                        {formatDueDate(dl.due_date, i18n.language)}
                      </span>
                      <ChevronRight
                        size={14}
                        className="text-gray-300 group-hover:text-gray-500"
                      />
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default LearnerDashboard
