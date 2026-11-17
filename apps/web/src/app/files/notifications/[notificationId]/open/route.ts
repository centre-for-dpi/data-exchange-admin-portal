import { notificationSchema } from '@den/contracts';
import { NextResponse } from 'next/server';
import { ApiError, apiSend } from '../../../../../lib/api';
import { routing } from '../../../../../i18n/routing';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Opens a notification: marks it read and goes to its page (M2-08). Only same-site paths that the
 * API stored are followed, never an absolute URL: no open redirect.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ notificationId: string }> },
): Promise<Response> {
  const { notificationId } = await params;
  const url = new URL(request.url);
  const locale = url.searchParams.get('locale');
  const prefix =
    locale &&
    locale !== routing.defaultLocale &&
    (routing.locales as readonly string[]).includes(locale)
      ? `/${locale}`
      : '';
  if (!UUID.test(notificationId))
    return NextResponse.redirect(new URL(`${prefix}/notifications`, url));
  try {
    const result = await apiSend(
      'POST',
      `/me/notifications/${notificationId}/read`,
      undefined,
      notificationSchema,
    );
    const link = result.ok ? result.data.link : '/notifications';
    const safe = link.startsWith('/') && !link.startsWith('//') ? link : '/notifications';
    return NextResponse.redirect(new URL(`${prefix}${safe}`, url));
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.redirect(new URL(`${prefix}/`, url));
    throw error;
  }
}
