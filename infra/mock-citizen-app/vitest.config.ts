import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Dates are shown in the country's time zone (config/country).
    env: { DEN_COUNTRY: 'co' },
  },
});
