'use strict'
// sharp's native image library isn't available on Android. Every caller
// already handles a missing sharp (artwork resizing falls back to the
// original image).
throw Object.assign(new Error('sharp is not available on Android'), { code: 'MODULE_NOT_FOUND' })
