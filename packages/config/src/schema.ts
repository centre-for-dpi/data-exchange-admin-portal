import { z } from 'zod';

/** UI languages of the portal (SPEC.md §11). Country texts may be given in any of them. */
export const UI_LOCALES = ['es', 'en'] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

const nonEmpty = z.string().trim().min(1);

/** A plain string, or a map with at least one UI language. */
export const localizedTextSchema = z.union([
  nonEmpty,
  z
    .strictObject({ es: nonEmpty.optional(), en: nonEmpty.optional() })
    .refine((t) => t.es !== undefined || t.en !== undefined, {
      message: 'must define at least one of: es, en',
    }),
]);
export type LocalizedText = z.infer<typeof localizedTextSchema>;

const codeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'must be lower snake_case (letters, digits, underscore)');

const isValidTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const isValidLocale = (locale: string): boolean => {
  try {
    return Intl.getCanonicalLocales(locale).length === 1;
  } catch {
    return false;
  }
};

const authoritySchema = z.strictObject({
  name: nonEmpty,
  shortName: nonEmpty,
});

const catalogEntrySchema = z.strictObject({
  code: codeSchema,
  name: localizedTextSchema,
});

const purposeSchema = z.strictObject({
  code: codeSchema,
  name: localizedTextSchema,
  description: localizedTextSchema,
  legalReference: nonEmpty.optional(),
});

const uniqueBy =
  <T>(key: (item: T) => string, what: string) =>
  (items: T[], ctx: z.RefinementCtx) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      const value = key(item);
      if (seen.has(value)) {
        ctx.addIssue({ code: 'custom', message: `duplicate ${what} "${value}"`, path: [index] });
      }
      seen.add(value);
    });
  };

const months = z.number().int().min(1).max(120);

export const countryConfigSchema = z.strictObject({
  country: z.strictObject({
    /** ISO 3166-1 alpha-2, upper case (XX for the example template). */
    code: z.string().regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 code in upper case'),
    name: nonEmpty,
    /** BCP 47 locale used for formatting (dates, numbers), e.g. es-419. */
    locale: z.string().refine(isValidLocale, 'must be a valid BCP 47 locale'),
    /** IANA time zone used to display dates (stored in UTC). */
    timezone: z.string().refine(isValidTimeZone, 'must be a valid IANA time zone'),
  }),
  authorities: z.strictObject({
    operator: authoritySchema,
    regulator: authoritySchema,
  }),
  legal: z.strictObject({
    dataProtectionLaw: nonEmpty,
    dataProtectionAuthority: nonEmpty,
  }),
  identifiers: z.strictObject({
    // At most 32 characters: the length the citizens' realm accepts for document_type.
    person: z.array(nonEmpty.max(32)).min(1),
    organization: z.array(nonEmpty.max(32)).min(1),
  }),
  sectors: z
    .array(catalogEntrySchema)
    .min(1)
    .superRefine(uniqueBy((s) => s.code, 'sector code')),
  purposes: z
    .array(purposeSchema)
    .min(1)
    .superRefine(uniqueBy((p) => p.code, 'purpose code')),
  features: z.strictObject({
    publicCatalog: z.boolean(),
    mtls: z.strictObject({ required: z.boolean() }),
    sandbox: z.strictObject({ autoApprove: z.boolean() }),
    approval: z.strictObject({ regulatorForSensitive: z.boolean() }),
    lint: z.strictObject({ noIdInQuery: z.boolean() }),
    /**
     * The gateway signs each call to the provider (X-DEN-Assertion, ADR-0024, M6-10): a JWS the
     * provider verifies with the portal's JWKS and can keep as proof. Off by default.
     */
    gatewayAssertion: z.boolean().default(false),
  }),
  /** Maximum subscription validity per API classification (SPEC.md §5). */
  subscriptionMaxValidityMonths: z.strictObject({
    public: months,
    internal: months,
    personal: months,
    sensitive: months,
  }),
  /** Notice periods and lifetimes; defaults are the values stated in SPEC.md. */
  lifecycle: z
    .strictObject({
      apiRetirementNoticeDays: z.number().int().min(0).default(90),
      subscriptionRenewalNoticeDays: z.number().int().min(1).default(30),
      certificateValidityDays: z.number().int().min(1).max(397).default(90),
      certificateExpiryWarningDays: z.number().int().min(1).default(15),
      /**
       * Days the previous credential (secret or certificate) keeps working after a new one is
       * issued (SPEC.md §4.3). At most 30: the rotated-secret window of the Keycloak policy.
       */
      credentialRotationDays: z.number().int().min(1).max(30).default(7),
      enrollmentTokenValidityHours: z.number().int().min(1).max(720).default(72),
      nodeOfflineAfterMinutes: z.number().int().min(1).default(5),
      /** Days a signing key of the gateway's assertions signs before the next one takes over. */
      assertionKeyRotationDays: z.number().int().min(7).max(365).default(90),
    })
    .default({
      apiRetirementNoticeDays: 90,
      subscriptionRenewalNoticeDays: 30,
      certificateValidityDays: 90,
      certificateExpiryWarningDays: 15,
      credentialRotationDays: 7,
      enrollmentTokenValidityHours: 72,
      nodeOfflineAfterMinutes: 5,
      assertionKeyRotationDays: 90,
    }),
  /** Retention periods (SPEC.md §11). */
  retention: z
    .strictObject({
      auditYears: z.number().int().min(1).default(5),
      accessLogMonths: z.number().int().min(1).default(12),
      /** Transparency register, consultations per data subject (ADR-0015). */
      subjectAccessMonths: z.number().int().min(1).default(60),
    })
    .default({ auditYears: 5, accessLogMonths: 12, subjectAccessMonths: 60 }),
  /** Documents offered to users (SPEC.md §4.4, M2-07). Paths are relative to the YAML file. */
  documents: z
    .strictObject({
      /** Model data exchange agreement that consumers and providers can start from. */
      agreementTemplate: nonEmpty.optional(),
    })
    .default({}),
  branding: z.strictObject({
    productName: nonEmpty,
    /** Path relative to the country YAML file. */
    logo: nonEmpty,
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #RRGGBB color'),
  }),
});

/** Validated configuration, with defaults applied and `branding.logo` resolved to an absolute path. */
export type CountryConfig = z.output<typeof countryConfigSchema>;
export type CountryConfigInput = z.input<typeof countryConfigSchema>;
