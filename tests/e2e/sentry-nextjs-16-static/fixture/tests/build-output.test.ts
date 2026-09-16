import { expect, test } from '@playwright/test';
import { findAbsolutePathImports } from './test-utils';
import * as path from 'path';

test('emits no absolute-path imports into the server output', () => {
  const leaks = findAbsolutePathImports({ outputDir: path.join(import.meta.dirname, '..', 'dist', 'server') });

  expect(leaks).toEqual([]);
});
