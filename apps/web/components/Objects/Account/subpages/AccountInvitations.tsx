'use client'
import React, { useState } from 'react'
import Link from 'next/link'
import useSWR, { mutate } from 'swr'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { getAPIUrl, getUriWithOrg } from '@services/config/config'
import { swrFetcher } from '@services/utils/ts/requests'
import { acceptCourseInvite, rejectCourseInvite } from '@services/courses/enrollments'
import { ArrowRight, CalendarDays, Check, Mail, X } from 'lucide-react'
import toast from 'react-hot-toast'

interface AccountInvitationsProps {
  orgslug: string
}

type EnrollmentStatus = 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired'

interface Invite {
  enrollment_uuid: string
  course_uuid: string
  course_name: string
  status: EnrollmentStatus
  invite_code: string | null
  expires_at: string | null
  creation_date: string
}

// Status pill reused for every card so the learner can tell state at a glance.
const StatusBadge = ({ status }: { status: EnrollmentStatus }) => {
  const styles: Record<EnrollmentStatus, string> = {
    pending: 'bg-yellow-100 text-yellow-700',
    accepted: 'bg-green-100 text-green-700',
    rejected: 'bg-rose-100 text-rose-700',
    revoked: 'bg-gray-100 text-gray-600',
    expired: 'bg-orange-100 text-orange-700',
  }
  const labels: Record<EnrollmentStatus, string> = {
    pending: 'Pending',
    accepted: 'Accepted',
    rejected: 'Declined',
    revoked: 'Revoked by instructor',
    expired: 'Expired',
  }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${styles[status]}`}>
      {labels[status]}
    </span>
  )
}

const formatDate = (value?: string | null) => {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function AccountInvitations({ orgslug }: AccountInvitationsProps) {
  const session = useLHSession() as any
  const access_token = session?.data?.tokens?.access_token

  const listUrl = `${getAPIUrl()}courses/enrollments/invites/mine`
  const { data: invites, error, isLoading } = useSWR<Invite[]>(
    access_token ? listUrl : null,
    (url: string) => swrFetcher(url, access_token),
    { revalidateOnFocus: true }
  )

  // Track which invite is mid-request so buttons disable per-row.
  const [busy, setBusy] = useState<string | null>(null)

  const handleAccept = async (invite: Invite) => {
    if (!invite.invite_code) return
    setBusy(invite.enrollment_uuid)
    try {
      const res = await acceptCourseInvite(invite.invite_code, access_token)
      if (res.status === 200) {
        toast.success(`Enrolled in ${invite.course_name}`)
        mutate(listUrl)
      } else {
        // Backend returns a clear reason for expired / revoked codes.
        toast.error(res.data?.detail || 'Could not accept invitation')
        mutate(listUrl)
      }
    } catch (error: any) {
      toast.error(error?.detail || error?.message || 'Could not accept invitation')
    } finally {
      setBusy(null)
    }
  }

  const handleReject = async (invite: Invite) => {
    if (!invite.invite_code) return
    setBusy(invite.enrollment_uuid)
    try {
      const res = await rejectCourseInvite(invite.invite_code, access_token)
      if (res.status === 200) {
        toast.success('Invitation declined')
        mutate(listUrl)
      } else {
        toast.error(res.data?.detail || 'Could not decline invitation')
        mutate(listUrl)
      }
    } catch (error: any) {
      toast.error(error?.detail || error?.message || 'Could not decline invitation')
    } finally {
      setBusy(null)
    }
  }

  // Pending invites first — they're the only ones requiring action.
  const sorted = [...(invites ?? [])].sort((a, b) =>
    a.status === 'pending' && b.status !== 'pending' ? -1 :
    b.status === 'pending' && a.status !== 'pending' ? 1 : 0
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-col bg-white rounded-xl nice-shadow px-5 py-4">
        <h1 className="font-bold text-lg text-gray-800">Course Invitations</h1>
        <p className="text-gray-500 text-sm">
          Invitations sent to you by instructors for exclusive courses.
        </p>
      </div>

      {isLoading && (
        <div className="bg-white rounded-xl nice-shadow p-8 text-center text-gray-400">
          Loading invitations…
        </div>
      )}

      {!access_token && (
        <div className="bg-white rounded-xl nice-shadow p-8 text-center text-gray-400">
          Sign in to view your invitations.
        </div>
      )}

      {error && (
        <div className="bg-white rounded-xl nice-shadow p-8 text-center text-gray-500 space-y-3">
          <p>We couldn&apos;t load your invitations right now.</p>
          <button
            onClick={() => mutate(listUrl)}
            className="inline-flex items-center justify-center rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Retry
          </button>
        </div>
      )}

      {!access_token || error ? null : !isLoading && sorted.length === 0 && (
        <div className="bg-white rounded-xl nice-shadow p-10 text-center text-gray-400">
          <Mail size={28} className="mx-auto mb-3 opacity-50" />
          You have no course invitations.
        </div>
      )}

      {!access_token || error ? null : sorted.map((invite) => {
        const expires = formatDate(invite.expires_at)
        const invited = formatDate(invite.creation_date)
        const isPending = invite.status === 'pending'
        const isAccepted = invite.status === 'accepted'
        const rowBusy = busy === invite.enrollment_uuid

        return (
          <div key={invite.enrollment_uuid} className="bg-white rounded-xl nice-shadow overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-600">
                <Mail size={12} /> Course invitation
              </span>
              <StatusBadge status={invite.status} />
            </div>
            <div className="p-4 space-y-3">
              <p className="font-bold text-gray-900 leading-snug">{invite.course_name}</p>

              <div className="flex flex-wrap gap-4 text-xs text-gray-400">
                {invited && (
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarDays size={12} /> Invited {invited}
                  </span>
                )}
                {isPending && expires && (
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarDays size={12} /> Expires {expires}
                  </span>
                )}
              </div>

              {/* Actions depend on lifecycle state. */}
              <div className="flex items-center gap-2 pt-1">
                {isPending && (
                  <>
                    <button
                      onClick={() => handleAccept(invite)}
                      disabled={rowBusy}
                      className="flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold text-white bg-gray-900 hover:bg-gray-800 disabled:opacity-60 transition-colors px-3 py-2 rounded-lg"
                    >
                      <Check size={12} /> Accept
                    </button>
                    <button
                      onClick={() => handleReject(invite)}
                      disabled={rowBusy}
                      className="flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 disabled:opacity-60 transition-colors px-3 py-2 rounded-lg"
                    >
                      <X size={12} /> Decline
                    </button>
                  </>
                )}
                {isAccepted && (
                  <Link
                    href={getUriWithOrg(orgslug, `/course/${invite.course_uuid.replace('course_', '')}`)}
                    className="flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors px-3 py-2 rounded-lg"
                  >
                    Go to course <ArrowRight size={12} />
                  </Link>
                )}
                {!isPending && !isAccepted && (
                  <p className="text-xs text-gray-400 py-2">
                    {invite.status === 'expired' && 'This invitation has expired. Ask the instructor to resend it.'}
                    {invite.status === 'revoked' && 'The instructor withdrew this invitation.'}
                    {invite.status === 'rejected' && 'You declined this invitation.'}
                  </p>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default AccountInvitations
