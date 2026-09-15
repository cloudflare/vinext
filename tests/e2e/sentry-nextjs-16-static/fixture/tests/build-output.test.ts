import { expect, test } from '@playwright/test';
import { findAbsolutePathImports } from '@sentry-internal/test-utils';
import * as path from 'path';

test('emits no absolute-path imports into the server output', () => {
  const leaks = findAbsolutePathImports({ outputDir: path.join(process.cwd(), '.next', 'server') });

  expect(leaks).toEqual([]);
});
