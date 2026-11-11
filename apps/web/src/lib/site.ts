import { getCountryConfig } from '@rid/config';
import { readableForeground } from './branding';

/** Country branding and authorities for the UI (server only: reads config/country/*.yaml). */
export function getSite() {
  const config = getCountryConfig();
  return {
    productName: config.branding.productName,
    primaryColor: config.branding.primaryColor,
    primaryForeground: readableForeground(config.branding.primaryColor),
    logoFile: config.branding.logo,
    operator: config.authorities.operator,
    regulator: config.authorities.regulator,
    publicCatalog: config.features.publicCatalog,
  };
}
