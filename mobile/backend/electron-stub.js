'use strict'
// What require('electron') gives plain Node (Lokal's web mode): the npm
// package's path string. Destructuring it yields undefined, exactly as the
// backend already expects outside Electron.
module.exports = '/lokal-android/no-electron'
