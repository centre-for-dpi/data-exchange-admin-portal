import type { PublicKitRelease } from '@den/contracts';
import { getFormatter, getTranslations } from 'next-intl/server';
import { kitInstallCommands, kitMirrorUrl, megabytes, portalUrl } from '../../lib/kit-install';
import { Notice } from '../ui/notice';
import { CommandBlock } from './command-block';

/**
 * The node kit's current version (P-03): where to download it, its size and SHA-256, and the
 * commands for the entity's server with this portal's URL. Shown on the nodes page to every
 * member and on the public site. The checksum is a convenience, not a guarantee: the page says
 * so, and shows the operator's signature once releases are signed.
 */
export async function KitReleasePanel({
  release,
  locale,
}: {
  release: PublicKitRelease | null;
  locale: string;
}) {
  const t = await getTranslations('kit');
  const format = await getFormatter();
  if (!release) {
    return (
      <Notice tone="info" data-testid="kit-release">
        {t('none')}
      </Notice>
    );
  }
  const portal = portalUrl();
  const mirror = release.mirrored ? kitMirrorUrl(portal, release) : null;
  const commands = (url: string) =>
    kitInstallCommands({ url, fileName: release.fileName, sha256: release.sha256, locale });

  return (
    <div className="card space-y-6 p-6 md:p-8" data-testid="kit-release">
      <dl className="facts">
        <dt>{t('version')}</dt>
        <dd className="font-mono" data-testid="kit-version">
          {release.version}
        </dd>
        {release.madeCurrentAt ? (
          <>
            <dt>{t('since')}</dt>
            <dd>{format.dateTime(new Date(release.madeCurrentAt), { dateStyle: 'medium' })}</dd>
          </>
        ) : null}
        <dt>{t('download')}</dt>
        <dd className="space-y-1">
          <a href={release.url} className="link block break-all" data-testid="kit-link">
            {t('fromRelease', { file: release.fileName })}
          </a>
          {mirror ? (
            <a href={mirror} className="link block break-all" data-testid="kit-mirror-link">
              {t('fromPortal', { file: release.fileName })}
            </a>
          ) : null}
        </dd>
        <dt>{t('size')}</dt>
        <dd>
          {t('sizeValue', {
            megabytes: megabytes(release.sizeBytes, locale),
            bytes: format.number(release.sizeBytes),
          })}
        </dd>
        <dt>{t('sha256')}</dt>
        <dd className="font-mono break-all" data-testid="kit-sha256">
          {release.sha256}
        </dd>
        {release.signatureUrl ? (
          <>
            <dt>{t('signature')}</dt>
            <dd>
              <a href={release.signatureUrl} className="link break-all">
                {release.signatureUrl}
              </a>
            </dd>
          </>
        ) : null}
        {release.allowedSigners ? (
          <>
            <dt>{t('allowedSigners')}</dt>
            <dd>
              <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap break-all">
                {release.allowedSigners}
              </pre>
            </dd>
          </>
        ) : null}
      </dl>

      <Notice tone="warning" data-testid="kit-checksum-notice">
        <p>{t('checksumIsConvenience')}</p>
        <p className="mt-2">{release.signatureUrl ? t('signedCheck') : t('unsignedCheck')}</p>
      </Notice>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">{t('commandsTitle')}</h3>
        <p className="text-sm text-muted-foreground">{t('commandsLead')}</p>
        <CommandBlock
          label={t('commandsFromRelease')}
          code={commands(release.url)}
          testId="kit-commands-release"
        />
        {mirror ? (
          <CommandBlock
            label={t('commandsFromPortal')}
            code={commands(mirror)}
            testId="kit-commands-portal"
          />
        ) : null}
        <p className="text-sm">
          {t.rich('portalAnswer', {
            url: () => (
              <code className="font-mono font-semibold" data-testid="kit-portal-url">
                {portal}
              </code>
            ),
          })}
        </p>
        <p className="text-sm text-muted-foreground">{t('afterInstall')}</p>
      </div>
    </div>
  );
}
