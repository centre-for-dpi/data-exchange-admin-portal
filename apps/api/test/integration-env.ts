import { useTestDatabase } from './load-env.js';

useTestDatabase();
// The validations at submission (M4-06) need APISIX and the contract runner; their own test turns
// them on. Elsewhere a version in review is approved right away.
process.env.DEN_VERSION_VALIDATION ??= 'off';
