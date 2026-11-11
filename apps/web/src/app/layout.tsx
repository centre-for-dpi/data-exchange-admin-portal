import type { ReactNode } from 'react';

// Locale, metadata and branding come from next-intl and the country config in M0-07.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
