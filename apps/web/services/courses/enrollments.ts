import { getAPIUrl } from '@services/config/config'
import {
  RequestBodyWithAuthHeader,
  getResponseMetadata,
} from '@services/utils/ts/requests'

/*
 * Course enrollment / email-invite API client.
 * GET list endpoints are consumed via SWR with swrFetcher; only mutations live here.
 */

// Instructor: invite one or more learners by email.
export async function inviteLearnersByEmail(
  course_uuid: string,
  emails: string[],
  access_token: string | null | undefined,
  options?: { send_invites?: boolean; ttl_days?: number | null }
) {
  const result: any = await fetch(
    `${getAPIUrl()}courses/${course_uuid}/enrollments/invite`,
    RequestBodyWithAuthHeader(
      'POST',
      {
        emails,
        send_invites: options?.send_invites ?? true,
        ttl_days: options?.ttl_days,
      },
      null,
      access_token || undefined
    )
  )
  return await getResponseMetadata(result)
}

// Instructor: revoke an accepted enrollment or cancel a pending invite.
export async function revokeCourseEnrollment(
  course_uuid: string,
  enrollment_uuid: string,
  access_token: string | null | undefined
) {
  const result: any = await fetch(
    `${getAPIUrl()}courses/${course_uuid}/enrollments/${enrollment_uuid}`,
    RequestBodyWithAuthHeader('DELETE', null, null, access_token || undefined)
  )
  return await getResponseMetadata(result)
}

// Instructor: regenerate token + re-send email for a non-accepted invite.
export async function resendCourseEnrollmentInvite(
  course_uuid: string,
  enrollment_uuid: string,
  access_token: string | null | undefined
) {
  const result: any = await fetch(
    `${getAPIUrl()}courses/${course_uuid}/enrollments/${enrollment_uuid}/resend`,
    RequestBodyWithAuthHeader('POST', null, null, access_token || undefined)
  )
  return await getResponseMetadata(result)
}

// Learner: accept a pending invitation by code.
export async function acceptCourseInvite(
  invite_code: string,
  access_token: string | null | undefined
) {
  const result: any = await fetch(
    `${getAPIUrl()}courses/enrollments/invites/${invite_code}/accept`,
    RequestBodyWithAuthHeader('POST', null, null, access_token || undefined)
  )
  return await getResponseMetadata(result)
}

// Learner: decline a pending invitation by code.
export async function rejectCourseInvite(
  invite_code: string,
  access_token: string | null | undefined
) {
  const result: any = await fetch(
    `${getAPIUrl()}courses/enrollments/invites/${invite_code}/reject`,
    RequestBodyWithAuthHeader('POST', null, null, access_token || undefined)
  )
  return await getResponseMetadata(result)
}
