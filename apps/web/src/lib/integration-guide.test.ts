import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import es from '../../messages/es.json';
import { GUIDE_LANGUAGES, guideSnippets } from './integration-guide';

const base = {
  clientId: 'den-app-0190d0c4-0000-7000-8000-000000000001',
  tokenUrl: 'https://gw.example/realms/den-gateway/protocol/openid-connect/token',
  gateway: 'https://gw.example',
  path: '/salud/afiliacion/v1/afiliados/1000000001',
  purpose: 'eligibility_check',
  endUser: 'funcionario-42',
};

describe('integration guide snippets (M5-08)', () => {
  it('one program per language: token, call and the DEN headers', () => {
    const snippets = guideSnippets({ ...base, mtls: true });
    expect(snippets.map((s) => s.language)).toEqual([...GUIDE_LANGUAGES]);
    for (const s of snippets) {
      for (const expected of [
        base.clientId,
        base.tokenUrl,
        base.gateway,
        base.path,
        base.purpose,
        base.endUser,
        'client_credentials',
        'DEN_CLIENT_SECRET',
      ]) {
        expect(s.code, `${s.language}: ${expected}`).toContain(expected);
      }
      expect(s.code.toLowerCase(), s.language).toContain('x-den-purpose');
      expect(s.code.toLowerCase(), s.language).toContain('x-den-end-user');
      expect(s.code.toLowerCase(), s.language).toContain('bearer');
    }
  });

  it('with mTLS every program presents the certificate and trusts the network CA', () => {
    for (const s of guideSnippets({ ...base, mtls: true })) {
      expect(s.code, s.language).toContain('den-network-ca.pem');
      // Java takes certificate and key in one PKCS#12 file, made from them.
      expect(s.code, s.language).toContain(`${base.clientId}.crt`);
    }
    for (const s of guideSnippets({ ...base, mtls: false })) {
      expect(s.code, s.language).not.toContain('den-network-ca.pem');
    }
  });

  it('never puts a secret in the code', () => {
    for (const s of guideSnippets({ ...base, mtls: true })) {
      expect(s.code, s.language).not.toMatch(/TU_SECRETO|YOUR_SECRET/);
    }
  });

  it('the placeholders of the guide come out with their braces in both languages', () => {
    const t = createTranslator({ locale: 'es', messages: es });
    expect(t('myApps.guide.path')).toBe('/{entidad}/{api}/v1/...');
    expect(t('myApps.guide.purpose')).toBe('{finalidad}');
    const tEn = createTranslator({ locale: 'en', messages: en });
    expect(tEn('myApps.guide.endUser')).toBe('{official}');
  });
});
