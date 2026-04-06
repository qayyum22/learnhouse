'use client'
import { useCourse } from '@components/Contexts/CourseContext'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import ConfirmationModal from '@components/Objects/StyledElements/ConfirmationModal/ConfirmationModal'
import { getAPIUrl } from '@services/config/config'
import {
  inviteLearnersByEmail,
  resendCourseEnrollmentInvite,
  revokeCourseEnrollment,
} from '@services/courses/enrollments'
import { swrFetcher } from '@services/utils/ts/requests'
import { Mail, RefreshCcw, Send, UserX, Users } from 'lucide-react'
import React, { useState } from 'react'
import toast from 'react-hot-toast'
import useSWR, { mutate } from 'swr'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import UserAvatar from '@components/Objects/UserAvatar'
import { getUserAvatarMediaDirectory } from '@services/media/media'

type EditCourseEnrollmentsProps = {
  orgslug: string
}

type EnrollmentStatus = 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired'

interface Enrollment {
  id: number
  enrollment_uuid: string
  email: string
  status: EnrollmentStatus
  expires_at: string | null
  creation_date: string
  update_date: string
  user: {
    username: string
    first_name: string
    last_name: string
    avatar_image: string
    user_uuid: string
  } | null
}

// Human-friendly date formatting shared by both columns.
const formatDate = (value?: string | null) => {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// Colored pill per lifecycle state so instructors can scan the table at a glance.
const StatusBadge = ({ status }: { status: EnrollmentStatus }) => {
  const styles: Record<EnrollmentStatus, string> = {
    pending: 'bg-yellow-50 text-yellow-700',
    accepted: 'bg-green-50 text-green-700',
    rejected: 'bg-rose-50 text-rose-700',
    revoked: 'bg-gray-100 text-gray-600',
    expired: 'bg-orange-50 text-orange-700',
  }
  const labels: Record<EnrollmentStatus, string> = {
    pending: 'Pending',
    accepted: 'Accepted',
    rejected: 'Rejected',
    revoked: 'Revoked',
    expired: 'Expired',
  }
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold ${styles[status]}`}>
      {labels[status]}
    </span>
  )
}

function EditCourseEnrollments(props: EditCourseEnrollmentsProps) {
  const session = useLHSession() as any
  const access_token = session?.data?.tokens?.access_token
  const course = useCourse() as any
  const { courseStructure } = course as any
  const canFetch = Boolean(courseStructure?.course_uuid && access_token)

  const listUrl = courseStructure
    ? `${getAPIUrl()}courses/${courseStructure.course_uuid}/enrollments`
    : null

  // SWR drives the table; every mutation calls mutate(listUrl) to refresh.
  const { data: enrollments, error, isLoading } = useSWR<Enrollment[]>(
    canFetch ? listUrl : null,
    (url: string) => swrFetcher(url, access_token),
    { revalidateOnFocus: false }
  )

  const [emailInput, setEmailInput] = useState('')
  const [isSending, setIsSending] = useState(false)

  // Accept comma / whitespace / newline separated lists pasted into the textarea.
  const parseEmails = (raw: string): string[] =>
    raw
      .split(/[\s,;]+/)
      .map((e) => e.trim())
      .filter((e) => e.length > 0)

  const handleSendInvites = async () => {
    const emails = parseEmails(emailInput)
    if (emails.length === 0) {
      toast.error('Enter at least one email address')
      return
    }
    setIsSending(true)
    try {
      const res = await inviteLearnersByEmail(courseStructure.course_uuid, emails, access_token)
      if (res.status === 200) {
        const data = res.data as { successful: any[]; failed: { email: string; reason: string }[] }
        if (data.successful.length > 0) {
          toast.success(`Sent ${data.successful.length} invitation(s)`)
        }
        // Surface each skip reason (duplicate, already enrolled, author, …).
        data.failed.forEach((f) => toast.error(`${f.email}: ${f.reason}`))
        setEmailInput('')
        mutate(listUrl)
      } else {
        toast.error(res.data?.detail || 'Failed to send invitations')
      }
    } catch (error: any) {
      toast.error(error?.detail || error?.message || 'Failed to send invitations')
    } finally {
      setIsSending(false)
    }
  }

  const handleResend = async (enrollment: Enrollment) => {
    try {
      const res = await resendCourseEnrollmentInvite(
        courseStructure.course_uuid,
        enrollment.enrollment_uuid,
        access_token
      )
      if (res.status === 200) {
        toast.success(`Invitation resent to ${enrollment.email}`)
        mutate(listUrl)
      } else {
        toast.error(res.data?.detail || 'Failed to resend invitation')
      }
    } catch (error: any) {
      toast.error(error?.detail || error?.message || 'Failed to resend invitation')
    }
  }

  const handleRevoke = async (enrollment: Enrollment) => {
    try {
      const res = await revokeCourseEnrollment(
        courseStructure.course_uuid,
        enrollment.enrollment_uuid,
        access_token
      )
      if (res.status === 200) {
        toast.success(`Revoked access for ${enrollment.email}`)
        mutate(listUrl)
      } else {
        toast.error(res.data?.detail || 'Failed to revoke')
      }
    } catch (error: any) {
      toast.error(error?.detail || error?.message || 'Failed to revoke')
    }
  }

  // 403 from the API means the viewer isn't a course owner/admin.
  if (error?.status === 403) {
    return (
      <div className="mx-4 sm:mx-10 mt-6 bg-white rounded-xl shadow-xs p-8 text-center text-gray-500">
        You do not have permission to manage enrollments for this course.
      </div>
    )
  }

  if (error && error?.status !== 403) {
    return (
      <div className="mx-4 sm:mx-10 mt-6 bg-white rounded-xl shadow-xs p-8 text-center text-gray-500 space-y-3">
        <p>We couldn&apos;t load the enrollment list right now.</p>
        <Button variant="outline" onClick={() => listUrl && mutate(listUrl)}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div>
      {courseStructure && (
        <div>
          <div className="h-6" />
          <div className="mx-4 sm:mx-10 bg-white rounded-xl shadow-xs px-4 py-4">
            <div className="flex flex-col bg-gray-50 -space-y-1 px-3 sm:px-5 py-3 rounded-md mb-3">
              <h1 className="font-bold text-lg sm:text-xl text-gray-800">Learner Enrollments</h1>
              <h2 className="text-gray-500 text-xs sm:text-sm">
                Invite learners by email to give them access to this exclusive course.
              </h2>
            </div>

            {/* Invite form — accepts a pasted list of addresses. */}
            <div className="bg-slate-50 rounded-lg p-4 mb-4 space-y-3">
              <div className="flex items-center gap-2 text-slate-700 font-semibold text-sm">
                <Mail size={16} /> Invite learners
              </div>
              <textarea
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="alice@example.com, bob@example.com"
                rows={3}
                className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">
                  {parseEmails(emailInput).length} address(es) • invites expire after 14 days
                </span>
                <Button
                  onClick={handleSendInvites}
                  disabled={isSending || parseEmails(emailInput).length === 0}
                  className="bg-gray-900 text-white hover:bg-gray-800 text-sm"
                >
                  <Send size={14} className="mr-2" />
                  {isSending ? 'Sending…' : 'Send invites'}
                </Button>
              </div>
            </div>

            {/* Enrollment table */}
            <div className="bg-white rounded-xl nice-shadow">
              <div className="max-h-[600px] overflow-y-auto">
                {isLoading && (
                  <div className="p-8 text-center text-sm text-gray-400">
                    Loading enrollments…
                  </div>
                )}
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[40px]"></TableHead>
                      <TableHead>Learner</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Invited on</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? null : enrollments && enrollments.length > 0 ? (
                      enrollments.map((e) => (
                        <TableRow key={e.enrollment_uuid}>
                          <TableCell>
                            {e.user ? (
                              <UserAvatar
                                width={30}
                                border="border-2"
                                avatar_url={
                                  e.user.avatar_image
                                    ? getUserAvatarMediaDirectory(e.user.user_uuid, e.user.avatar_image)
                                    : ''
                                }
                                rounded="rounded"
                                predefined_avatar={e.user.avatar_image ? undefined : 'empty'}
                              />
                            ) : (
                              <div className="w-[30px] h-[30px] rounded bg-gray-100 flex items-center justify-center">
                                <Mail size={14} className="text-gray-400" />
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="font-medium">
                            {e.user ? (
                              <>
                                {e.user.first_name} {e.user.last_name}
                                <div className="text-xs text-gray-500">@{e.user.username}</div>
                              </>
                            ) : (
                              <span className="text-gray-400 italic">No account yet</span>
                            )}
                          </TableCell>
                          <TableCell className="text-gray-600 text-sm">{e.email}</TableCell>
                          <TableCell>
                            <StatusBadge status={e.status} />
                          </TableCell>
                          <TableCell className="text-gray-500 text-sm">{formatDate(e.creation_date)}</TableCell>
                          <TableCell className="text-gray-500 text-sm">
                            {e.status === 'pending' ? formatDate(e.expires_at) : '—'}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex gap-2 justify-end">
                              {/* Resend is available for anything not yet accepted. */}
                              {e.status !== 'accepted' && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleResend(e)}
                                  title="Resend invitation"
                                >
                                  <RefreshCcw size={14} />
                                </Button>
                              )}
                              {/* Revoke hides behind a confirm to prevent accidental access removal. */}
                              {e.status !== 'revoked' && (
                                <ConfirmationModal
                                  confirmationButtonText="Revoke"
                                  confirmationMessage={`Remove ${e.email} from this course? They will immediately lose access.`}
                                  dialogTitle="Revoke enrollment"
                                  dialogTrigger={
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="text-red-600 border-red-200 hover:bg-red-50"
                                      title="Revoke access"
                                    >
                                      <UserX size={14} />
                                    </Button>
                                  }
                                  functionToExecute={() => handleRevoke(e)}
                                  status="warning"
                                />
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center py-10 text-gray-400">
                          <Users size={24} className="mx-auto mb-2 opacity-50" />
                          No learners invited yet.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default EditCourseEnrollments
