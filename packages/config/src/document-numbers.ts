import { type CountryConfig, DOCUMENT_NUMBER_SHAPE } from './schema.js';

type Identifiers = Pick<CountryConfig, 'identifiers'>;

/**
 * The canonical form of the number of every person document type (ADR-0030): the country's own
 * pattern for that type, or DOCUMENT_NUMBER_SHAPE. The portal puts it in OPA's bundle.
 */
export function documentNumberFormats(config: Identifiers): Record<string, string> {
  const formats = config.identifiers.personNumberFormat;
  return Object.fromEntries(
    config.identifiers.person.map((type) => [type, formats[type] ?? DOCUMENT_NUMBER_SHAPE]),
  );
}

/**
 * Whether `number` is written exactly in the canonical form of a document of `type`, as the gateway
 * decides it (packages/policy/den/authz.rego, subject_canonical): the type is one of the country's
 * and the number matches both DOCUMENT_NUMBER_SHAPE and the type's pattern.
 */
export function isCanonicalDocumentNumber(
  config: Identifiers,
  type: string,
  number: string,
): boolean {
  const format = documentNumberFormats(config)[type];
  return (
    format !== undefined &&
    new RegExp(DOCUMENT_NUMBER_SHAPE).test(number) &&
    new RegExp(format).test(number)
  );
}
