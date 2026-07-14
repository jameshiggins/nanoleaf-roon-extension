'use strict';

/**
 * Roon extension registration: pairing + a status line in Roon's Extensions UI.
 *
 * Deliberately optional at runtime — the audio path (SlimProto/capture → Nanoleaf)
 * works without a Roon API connection, so this never gates the light output.
 *
 * node-roon-api is lazy-required so tests and roon.enabled=false setups
 * don't need the GitHub-hosted packages installed.
 */

const fs = require('node:fs');
const path = require('node:path');
const log = require('../log')('roon');

// node-roon-api persists pairing state to ./config.json by default, which would
// collide with this project's own config.json — redirect it to roon-state/.
const STATE_DIR = path.join(__dirname, '..', '..', 'roon-state');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

class RoonExtension {
  /**
   * @param {{ onZoneEvent?: (response: string, msg: object|undefined) => void }} [opts]
   *   onZoneEvent: raw subscribe_zones callback (e.g. TrackWatcher#handleEvent).
   *   Providing it makes RoonApiTransport a required service and (re)subscribes
   *   on every pairing — core_paired delivers a fresh Core after each reconnect,
   *   so the subscription must be renewed there.
   */
  constructor(opts = {}) {
    this.onZoneEvent = opts.onZoneEvent ?? null;
    this.roon = null;
    this.status = null;
    this.core = null;
  }

  start() {
    let RoonApi, RoonApiStatus, RoonApiTransport;
    try {
      RoonApi = require('node-roon-api');
      RoonApiStatus = require('node-roon-api-status');
      if (this.onZoneEvent) RoonApiTransport = require('node-roon-api-transport');
    } catch (err) {
      throw new Error(
        'node-roon-api is not installed — run `npm install`, or set roon.enabled=false ' +
        `(${err.message})`
      );
    }

    this.roon = new RoonApi({
      extension_id: 'com.jameshiggins.nanoleaf-roon',
      display_name: 'Nanoleaf Roon Extension',
      display_version: require('../../package.json').version,
      publisher: 'James Higgins',
      email: 'higginsjamesallen@gmail.com',
      website: 'https://github.com/jameshiggins/nanoleaf-roon-extension',
      get_persisted_state: loadState,
      set_persisted_state: saveState,
      core_paired: (core) => {
        this.core = core;
        log.info(`paired with Roon Core "${core.display_name}" (${core.display_version})`);
        if (this.onZoneEvent) {
          core.services.RoonApiTransport.subscribe_zones((response, msg) => {
            try {
              this.onZoneEvent(response, msg);
            } catch (err) {
              log.error('zone event handler failed:', err);
            }
          });
        }
      },
      core_unpaired: () => {
        this.core = null;
        log.warn('unpaired from Roon Core');
      },
    });

    this.status = new RoonApiStatus(this.roon);
    this.roon.init_services({
      provided_services: [this.status],
      ...(this.onZoneEvent ? { required_services: [RoonApiTransport] } : {}),
    });
    this.setStatus('Starting…');
    this.roon.start_discovery();
    log.info('Roon discovery started — enable the extension in Roon Settings → Extensions');
  }

  /** Show a status line in Roon's extension list. No-op when Roon is disabled. */
  setStatus(message, isError = false) {
    if (this.status) this.status.set_status(message, isError);
  }
}

module.exports = { RoonExtension };
