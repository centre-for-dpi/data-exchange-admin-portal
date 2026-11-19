import type { PublicKitRelease } from '@den/contracts';

/**
 * The commands an entity's server runs to download, check and install the node kit (P-03).
 * They follow the entities' walkthrough (docs/guides/walkthrough.md §5.2): download the bundle,
 * check it against the SHA-256 the page shows, extract it and run the installer, which asks for
 * the portal's URL. The kit is another product (ADR-0011): nothing here invents its options.
 */

/** The portal's public URL (DEN_WEB_URL, as the API's links), without a trailing slash. */
export function portalUrl(): string {
  const value = process.env.DEN_WEB_URL ?? process.env.AUTH_URL ?? 'http://localhost:3000';
  return value.replace(/\/+$/, '');
}

/** Where the portal's mirror serves a release's bundle (apps/web/src/app/kit). */
export const kitMirrorUrl = (
  portal: string,
  release: Pick<PublicKitRelease, 'version' | 'fileName'>,
) => `${portal}/kit/${release.version}/${release.fileName}`;

/** The directory the bundle extracts to: its file name without the extension. */
export const kitDirectory = (fileName: string) => fileName.replace(/\.(?:tar\.gz|tgz)$/, '');

export interface KitCommandsInput {
  /** Where to download the bundle from: the release's link or the portal's mirror. */
  url: string;
  fileName: string;
  sha256: string;
  /** The installer speaks English unless DEN_LANG=es. */
  locale: string;
}

/** A shell word: as is when it has nothing the shell would read, else in single quotes. */
export const shellWord = (value: string) =>
  /^[A-Za-z0-9._~:/%+@=,-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

/**
 * One line per step. The file name ([A-Za-z0-9._-], checked by the API) and the hex checksum
 * need no quoting; the link may carry a query string, so it goes through shellWord.
 */
export function kitInstallCommands({ url, fileName, sha256, locale }: KitCommandsInput): string {
  return [
    `curl -fLO ${shellWord(url)}`,
    `echo "${sha256}  ${fileName}" | sha256sum -c -`,
    `tar -xzf ${fileName}`,
    `cd ${kitDirectory(fileName)}`,
    locale === 'es' ? 'sudo DEN_LANG=es ./install.sh' : 'sudo ./install.sh',
  ].join('\n');
}

/** "24.8 MB": the size in the units people read, next to the exact bytes. */
export function megabytes(bytes: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1_000_000);
}
