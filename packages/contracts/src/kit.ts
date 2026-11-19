import { z } from 'zod';
import { ValidationMessage } from './validation-messages.js';

/**
 * The node kit's releases the operator offers (P-03). The kit is a separate product (ADR-0011):
 * the portal only says which version is current, where to download it, its checksum and, when
 * the operator mirrors it, serves the same bundle under `/kit/<version>/<file>`.
 */

/** Semantic version without build metadata: it is a path segment of the mirror. */
export const KIT_RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** The bundle's file name: the last segment of its link, a gzip tarball. */
export const KIT_BUNDLE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:tar\.gz|tgz)$/;
/** Media type the mirror serves the bundle with. */
export const KIT_BUNDLE_MEDIA_TYPE = 'application/gzip';
/** The largest size the schema accepts (the column is a 32-bit integer). */
export const KIT_BUNDLE_MAX_SIZE = 2_147_483_647;

export const kitReleaseVersionSchema = z
  .string()
  .max(40)
  .regex(KIT_RELEASE_VERSION, ValidationMessage.semantic_version);

/** The bundle's file name from its link, or null when the link does not end in one. */
export function kitBundleFileName(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const last = decodeURIComponent(path.split('/').pop() ?? '');
  return KIT_BUNDLE_FILE_NAME.test(last) ? last : null;
}

/** Control characters other than tab and line feed (DEL included). */
const hasControlCharacters = (value: string) =>
  [...value].some((char) => {
    const code = char.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10) || code === 127;
  });

const httpsUrl = z.url({ protocol: /^https$/, error: ValidationMessage.https_url }).max(2000);

/** PUT /admin/kit-releases/:version: registers or corrects a release and makes it current. */
export const setKitReleaseSchema = z.strictObject({
  /** Where entities download the bundle, e.g. the kit's GitHub Release asset. */
  url: httpsUrl.refine((value) => kitBundleFileName(value) !== null, {
    error: ValidationMessage.kit_bundle_link,
  }),
  sizeBytes: z.number().int().min(1).max(KIT_BUNDLE_MAX_SIZE),
  sha256: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{64}$/, ValidationMessage.sha256_hex),
  /** The release's detached signature, once the kit's releases are signed (kit K5). */
  signatureUrl: httpsUrl.optional(),
  /** The operator's `allowed_signers` line(s) for that signature. */
  allowedSigners: z
    .string()
    // A text area sends CRLF line endings.
    .overwrite((value) => value.replace(/\r\n?/g, '\n'))
    .trim()
    .min(1)
    .max(8192)
    .refine((value) => !hasControlCharacters(value), {
      error: ValidationMessage.no_control_characters,
    })
    .optional(),
});
export type SetKitReleaseInput = z.input<typeof setKitReleaseSchema>;

export const kitReleaseVersionParamsSchema = z.object({ version: kitReleaseVersionSchema });

/** What anyone may read about a release: nothing in it is secret. */
export const publicKitReleaseSchema = z.object({
  version: z.string(),
  url: z.string(),
  fileName: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  signatureUrl: z.string().nullable(),
  allowedSigners: z.string().nullable(),
  /** The portal serves the same bundle under /kit/<version>/<fileName>. */
  mirrored: z.boolean(),
  /** When the operator made it the current version. */
  madeCurrentAt: z.iso.datetime().nullable(),
});
export type PublicKitRelease = z.infer<typeof publicKitReleaseSchema>;

/** GET /kit/current: the version the operator offers now, or null before it sets one. */
export const currentKitReleaseSchema = z.object({ release: publicKitReleaseSchema.nullable() });
export type CurrentKitRelease = z.infer<typeof currentKitReleaseSchema>;

/** A release as the operator console lists it (history, newest first). */
export const kitReleaseSchema = publicKitReleaseSchema.extend({
  current: z.boolean(),
  mirroredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type KitRelease = z.infer<typeof kitReleaseSchema>;

export const kitReleaseListSchema = z.object({ items: z.array(kitReleaseSchema) });
export type KitReleaseList = z.infer<typeof kitReleaseListSchema>;
