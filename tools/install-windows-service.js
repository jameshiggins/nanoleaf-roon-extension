'use strict';

/**
 * Register/unregister the extension as a Windows service via node-windows.
 * Prereq: npm install -g node-windows && npm link node-windows
 * Usage:  node tools\install-windows-service.js [--uninstall]
 * (NSSM is the recommended path — see docs/DEPLOY-WINDOWS-SERVICE.md — this is the
 * npm-native alternative.)
 */

const path = require('node:path');

let Service;
try {
  ({ Service } = require('node-windows'));
} catch {
  console.error('node-windows is not installed. Run: npm install -g node-windows && npm link node-windows');
  process.exit(1);
}

const svc = new Service({
  name: 'NanoleafRoon',
  description: 'Nanoleaf Roon Extension — streams Roon audio levels to Nanoleaf panels',
  script: path.join(__dirname, '..', 'src', 'index.js'),
  workingDirectory: path.join(__dirname, '..'),
});

if (process.argv.includes('--uninstall')) {
  svc.on('uninstall', () => console.log('Service uninstalled.'));
  svc.uninstall();
} else {
  svc.on('install', () => {
    svc.start();
    console.log('Service installed and started.');
  });
  svc.on('alreadyinstalled', () => console.log('Service is already installed.'));
  svc.install();
}
