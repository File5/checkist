import { invalidIds } from './http.ts'
import { getLocalJson, mutate } from './local.ts'
import { isJob, isJobDetail, isPhoto, isPhotoUpload, isReceiptImage, isReceiptImageDetail, isReviewConfirmResult } from './recognition-schema.ts'
import { page } from './schema.ts'
import type { LocalApiResult, Page, RequestOptions } from './types.ts'
import type {
  Job, JobDetail, JobParams, Photo, PhotoParams, PhotoUpload, ReceiptImage, ReceiptImageDetail, ReceiptImageParams,
  ReviewConfirmInput, ReviewConfirmResult,
} from './recognition-types.ts'

export type * from './recognition-types.ts'
export { clearRecognitionCsrf, getLocalJson, getRecognitionCsrf } from './local.ts'

export function uploadPhoto(file: File, options: RequestOptions = {}): Promise<LocalApiResult<PhotoUpload>> {
  const body = new FormData()
  body.append('file', file)
  return mutate('recognition/photos/', body, isPhotoUpload, options, true)
}
export function getPhotos(params: PhotoParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<Page<Photo>>> {
  return getLocalJson('recognition/photos/', params, page(isPhoto), options)
}
export async function getPhoto(id: number, options: RequestOptions = {}): Promise<LocalApiResult<Photo>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`recognition/photos/${id}/`, {}, isPhoto, options)
}
export async function getJobs(params: JobParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<Page<Job>>> {
  return invalidIds({ photo: params.photo }, options.signal) ?? getLocalJson('recognition/jobs/', params, page(isJob), options)
}
export async function getJob(id: number, options: RequestOptions = {}): Promise<LocalApiResult<JobDetail>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`recognition/jobs/${id}/`, {}, isJobDetail, options)
}
export async function cancelJob(id: number, options: RequestOptions = {}): Promise<LocalApiResult<JobDetail>> {
  return invalidIds({ id }, options.signal) ?? mutate(`recognition/jobs/${id}/cancel/`, '{}', isJobDetail, options)
}
export async function retryJob(id: number, options: RequestOptions = {}): Promise<LocalApiResult<JobDetail>> {
  return invalidIds({ id }, options.signal) ?? mutate(`recognition/jobs/${id}/retry/`, '{}', isJobDetail, options)
}
export async function getReceiptImages(params: ReceiptImageParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<Page<ReceiptImage>>> {
  return invalidIds({ photo: params.photo, job: params.job, receipt: params.receipt }, options.signal)
    ?? getLocalJson('recognition/receipt-images/', params, page(isReceiptImage), options)
}
export async function getReceiptImage(id: number, options: RequestOptions = {}): Promise<LocalApiResult<ReceiptImageDetail>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`recognition/receipt-images/${id}/`, {}, isReceiptImageDetail, options)
}
/** One synchronous «corrections + confirmation» of a needs_review crop. Never replayed: after a refusal, a lost
 * answer or a timeout the caller reads the job and the crop again.
 */
export async function confirmReceiptImage(id: number, input: ReviewConfirmInput, options: RequestOptions = {}): Promise<LocalApiResult<ReviewConfirmResult>> {
  return invalidIds({ id }, options.signal) ?? mutate(`recognition/receipt-images/${id}/confirm/`, JSON.stringify(input), isReviewConfirmResult, options)
}
