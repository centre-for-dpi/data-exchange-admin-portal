'use client';

import '@scalar/api-reference-react/style.css';
import dynamic from 'next/dynamic';
import { useEffect, useRef } from 'react';
import { config as zodConfig } from 'zod';

// Scalar validates its configuration with zod, whose JIT probes `Function("")`. The CSP forbids
// eval (M3-09), so the probe only produces a violation report: zod runs the same without it.
zodConfig({ jitless: true });

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
/* Its download link keeps its text whole with more text spacing (WCAG 1.4.12, M6-02). */
.download-button {
  white-space: normal !important;
  overflow: visible !important;
  max-width: 100%;
}
`;

/**
 * Read-only interactive documentation (Scalar, MIT) of a published version. The OpenAPI document is
 * passed inline (no extra request with the user's token), the "try it" client is hidden until the
 * sandbox exists, and nothing is loaded from third-party hosts (fonts, telemetry).
 */
export function ApiDocs({ spec }: { spec: Record<string, unknown> }) {
  const container = useRef<HTMLDivElement>(null);
  // Scalar titles the document with an h1; the page already has its own (the API's name). Its
  // headings go one level down, so the page keeps a single level-1 heading (WCAG 1.3.1, M6-02).
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const demote = () => {
      for (const heading of root.querySelectorAll('h1:not([aria-level])')) {
        heading.setAttribute('aria-level', '2');
      }
    };
    demote();
    const observer = new MutationObserver(demote);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={container} className="card overflow-hidden">
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
