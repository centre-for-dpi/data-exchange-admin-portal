// @ts-check
// License policy from ADR-0008 (complements ADR-0002). Pure functions, no I/O, so they can be unit tested.

/** SPDX identifiers allowed without an exception. */
export const ALLOWED_LICENSES = new Set([
  // Permissive
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'BlueOak-1.0.0',
  'Python-2.0',
  'Zlib',
  'Unlicense',
  // Weak copyleft
  'MPL-2.0',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
]);

/**
 * @typedef {{ type: 'license', id: string }
 *   | { type: 'and' | 'or', left: SpdxNode, right: SpdxNode }} SpdxNode
 */

/**
 * Parses an SPDX license expression (`MIT`, `(MIT OR CC0-1.0)`, `Apache-2.0 AND MIT`,
 * `GPL-2.0-only WITH Classpath-exception-2.0`). `WITH` clauses are kept as part of the
 * license id, so they are only allowed if listed verbatim. AND binds tighter than OR.
 * @param {string} expression
 * @returns {SpdxNode}
 */
export function parseSpdx(expression) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  /** @returns {SpdxNode} */
  function parseOr() {
    let left = parseAnd();
    while (peek()?.toUpperCase() === 'OR') {
      next();
      left = { type: 'or', left, right: parseAnd() };
    }
    return left;
  }

  /** @returns {SpdxNode} */
  function parseAnd() {
    let left = parseAtom();
    while (peek()?.toUpperCase() === 'AND') {
      next();
      left = { type: 'and', left, right: parseAtom() };
    }
    return left;
  }

  /** @returns {SpdxNode} */
  function parseAtom() {
    const token = next();
    if (token === undefined) {
      throw new Error(`Unexpected end of SPDX expression "${expression}"`);
    }
    if (token === '(') {
      const inner = parseOr();
      if (next() !== ')') {
        throw new Error(`Missing ")" in SPDX expression "${expression}"`);
      }
      return inner;
    }
    if (token === ')' || ['AND', 'OR', 'WITH'].includes(token.toUpperCase())) {
      throw new Error(`Unexpected "${token}" in SPDX expression "${expression}"`);
    }
    let id = token;
    if (peek()?.toUpperCase() === 'WITH') {
      next();
      const exception = next();
      if (exception === undefined) {
        throw new Error(`Missing exception after WITH in "${expression}"`);
      }
      id = `${id} WITH ${exception}`;
    }
    return { type: 'license', id };
  }

  const ast = parseOr();
  if (pos !== tokens.length) {
    throw new Error(`Unexpected "${tokens[pos]}" in SPDX expression "${expression}"`);
  }
  return ast;
}

/**
 * True if the expression is satisfied by the allowed set: OR needs one side, AND needs both.
 * Unparseable expressions are never allowed.
 * @param {string} expression
 * @param {Set<string>} [allowed]
 */
export function isLicenseAllowed(expression, allowed = ALLOWED_LICENSES) {
  /** @param {SpdxNode} node @returns {boolean} */
  const evaluate = (node) => {
    switch (node.type) {
      case 'license':
        return allowed.has(node.id);
      case 'and':
        return evaluate(node.left) && evaluate(node.right);
      case 'or':
        return evaluate(node.left) || evaluate(node.right);
    }
  };
  try {
    return evaluate(parseSpdx(expression));
  } catch {
    return false;
  }
}

/**
 * @typedef {{ name: string, versions: string[], license: string }} PackageLicense
 * @typedef {{ package: string, license: string, reason: string, addedAt: string }} LicenseException
 * @typedef {{
 *   violations: PackageLicense[],
 *   excepted: PackageLicense[],
 *   unusedExceptions: LicenseException[],
 *   countsByLicense: Map<string, number>,
 *   total: number,
 * }} LicenseReport
 */

/**
 * Evaluates `pnpm licenses list --json` output against the policy and the per-package exceptions.
 * An exception only applies when both the package name and the exact license string match.
 * @param {Record<string, Array<{ name: string, versions: string[], license?: string }>>} pnpmLicenses
 * @param {LicenseException[]} exceptions
 * @returns {LicenseReport}
 */
export function evaluateLicenses(pnpmLicenses, exceptions) {
  /** @type {PackageLicense[]} */
  const violations = [];
  /** @type {PackageLicense[]} */
  const excepted = [];
  /** @type {Map<string, number>} */
  const countsByLicense = new Map();
  const usedExceptions = new Set();
  let total = 0;

  for (const [groupLicense, packages] of Object.entries(pnpmLicenses)) {
    for (const pkg of packages) {
      const license = pkg.license ?? groupLicense;
      const entry = { name: pkg.name, versions: pkg.versions, license };
      total += 1;
      countsByLicense.set(license, (countsByLicense.get(license) ?? 0) + 1);

      if (isLicenseAllowed(license)) continue;

      const exception = exceptions.find((e) => e.package === pkg.name && e.license === license);
      if (exception) {
        usedExceptions.add(exception);
        excepted.push(entry);
      } else {
        violations.push(entry);
      }
    }
  }

  const unusedExceptions = exceptions.filter((e) => !usedExceptions.has(e));
  return { violations, excepted, unusedExceptions, countsByLicense, total };
}
