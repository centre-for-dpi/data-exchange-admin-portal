'use client';

import '@scalar/api-reference-react/style.css';
import dynamic from 'next/dynamic';

// Scalar renders in the browser only (it uses window); the document comes from our server.
const ApiReferenceReact = dynamic(
  () => import('@scalar/api-reference-react').then((m) => m.ApiReferenceReact),
  { ssr: false },
);

/**
 * Scalar's default light palette fails WCAG 2.1 AA contrast for muted text and HTTP method colours
 * (found by axe). These values keep at least 4.5:1 on white (CLAUDE.md, rule 10).
 */
const accessibleColors = `
.light-mode {
  --scalar-color-1: #111827;
  --scalar-color-2: #374151;
  --scalar-color-3: #4b5563;
  --scalar-color-green: #047857;
  --scalar-color-blue: #1d4ed8;
  --scalar-color-orange: #b45309;
  --scalar-color-red: #b91c1c;
  --scalar-color-yellow: #854d0e;
  --scalar-color-purple: #6d28d9;
}
`;

/**
 * Read-only interactive documentation (Scalar, MIT) of a published version. The OpenAPI document is
 * passed inline (no extra request with the user's token), the "try it" client is hidden until the
 * sandbox exists, and nothing is loaded from third-party hosts (fonts, telemetry).
 */
export function ApiDocs({ spec }: { spec: Record<string, unknown> }) {
  return (
    <div className="rounded-md border border-border">
      <ApiReferenceReact
        configuration={{
          content: spec,
          hideTestRequestButton: true,
          hideClientButton: true,
          hideDarkModeToggle: true,
          forceDarkModeState: 'light',
          withDefaultFonts: false,
          telemetry: false,
          showDeveloperTools: 'never',
          customCss: accessibleColors,
        }}
      />
    </div>
  );
}
