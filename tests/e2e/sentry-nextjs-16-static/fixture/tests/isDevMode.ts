export const isDevMode = !!process.env.TEST_ENV && process.env.TEST_ENV.includes('development');
export const isTurbopackDevMode = process.env.TEST_ENV === 'development';
