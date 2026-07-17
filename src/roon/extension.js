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

/**
 * Settings layout shown in Roon → Settings → Extensions → (gear).
 * @param {{ sleep: string }} values
 */
function makeSleepLayout(values) {
  return {
    values,
    layout: [
      {
        type: 'group',
        title: 'Sleep timer',
        subtitle: 'Stop playback at the end of the track that is playing. One-shot — it resets to Off after it fires.',
        items: [
          {
            type: 'dropdown',
            title: 'Stop playback',
            setting: 'sleep',
            values: [
              { title: 'Off', value: 'off' },
              { title: 'At end of current track', value: 'end-of-track' },
            ],
          },
        ],
      },
    ],
    has_error: false,
  };
}

class RoonExtension {
  /**
   * @param {{ onZoneEvent?: (response: string, msg: object|undefined) => void,
   *           wantImages?: boolean }} [opts]
   *   onZoneEvent: raw subscribe_zones callback (e.g. TrackWatcher#handleEvent).
   *   Providing it makes RoonApiTransport a required service and (re)subscribes
   *   on every pairing — core_paired delivers a fresh Core after each reconnect,
   *   so the subscription must be renewed there.
   *   wantImages: request the image service so getImage() can fetch album art.
   *   onSleepMode: called with the new dropdown value ('off' | 'end-of-track')
   *   when the user saves the sleep setting in Roon. Providing it registers the
   *   RoonApiSettings service so the dropdown appears in Roon's Extensions UI.
   */
  constructor(opts = {}) {
    this.onZoneEvent = opts.onZoneEvent ?? null;
    this.wantImages = opts.wantImages ?? false;
    this.onSleepMode = opts.onSleepMode ?? null;
    this.roon = null;
    this.status = null;
    this.core = null;
    this.settings = null;
    this._sleepMode = 'off'; // transient: never persisted, so it's Off on every start
  }

  start() {
    let RoonApi, RoonApiStatus, RoonApiTransport, RoonApiImage, RoonApiSettings;
    try {
      RoonApi = require('node-roon-api');
      RoonApiStatus = require('node-roon-api-status');
      if (this.onZoneEvent) RoonApiTransport = require('node-roon-api-transport');
      if (this.wantImages) RoonApiImage = require('node-roon-api-image');
      if (this.onSleepMode) RoonApiSettings = require('node-roon-api-settings');
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
    const provided = [this.status];
    if (RoonApiSettings) {
      this.settings = new RoonApiSettings(this.roon, {
        get_settings: (cb) => cb(makeSleepLayout({ sleep: this._sleepMode })),
        save_settings: (req, isdryrun, settings) => {
          const l = makeSleepLayout(settings.values);
          req.send_complete(l.has_error ? 'NotValid' : 'Success', { settings: l });
          if (isdryrun || l.has_error) return;
          this._sleepMode = l.values.sleep;
          this.settings.update_settings(l);
          try {
            this.onSleepMode(this._sleepMode);
          } catch (err) {
            log.error('onSleepMode handler failed:', err);
          }
        },
        // The layout has no buttons, so Roon never calls this — but the service
        // always registers a button_pressed method, so provide a no-op guard.
        button_pressed: (req) => req && req.send_complete && req.send_complete('Success'),
      });
      provided.push(this.settings);
    }
    const required = [];
    if (this.onZoneEvent) required.push(RoonApiTransport);
    if (this.wantImages) required.push(RoonApiImage);
    this.roon.init_services({
      provided_services: provided,
      ...(required.length ? { required_services: required } : {}),
    });
    this.setStatus('Starting…');
    this.roon.start_discovery();
    log.info('Roon discovery started — enable the extension in Roon Settings → Extensions');
  }

  /** Show a status line in Roon's extension list. No-op when Roon is disabled. */
  setStatus(message, isError = false) {
    if (this.status) this.status.set_status(message, isError);
  }

  /**
   * Reflect the sleep dropdown's value in Roon's UI without a user save — used
   * to reset it to 'off' after the timer fires (one-shot). No-op if the
   * settings service isn't registered.
   * @param {'off'|'end-of-track'} value
   */
  setSleepMode(value) {
    this._sleepMode = value;
    if (this.settings) this.settings.update_settings(makeSleepLayout({ sleep: value }));
  }

  /**
   * Issue a transport control on a zone (used by the sleep timer to stop
   * playback). RoonApiTransport.control accepts a zone_id string directly.
   * @param {string} zoneId
   * @param {'stop'|'pause'} [control]
   */
  stopZone(zoneId, control = 'stop') {
    const svc = this.core && this.core.services && this.core.services.RoonApiTransport;
    if (!svc) { log.warn('cannot stop playback — Roon transport unavailable (not paired?)'); return; }
    svc.control(zoneId, control, (err) => {
      if (err) log.warn(`transport ${control} failed: ${err}`);
    });
  }

  /**
   * Fetch album art by image_key, scaled server-side to a small thumbnail.
   * @param {string} imageKey
   * @param {{ width?: number, height?: number }} [opts]
   * @returns {Promise<{ contentType: string, body: Buffer }>}
   */
  getImage(imageKey, { width = 64, height = 64 } = {}) {
    return new Promise((resolve, reject) => {
      const svc = this.core && this.core.services && this.core.services.RoonApiImage;
      if (!svc) return reject(new Error('Roon image service unavailable (not paired?)'));
      svc.get_image(
        imageKey,
        { scale: 'fit', width, height, format: 'image/jpeg' },
        (err, contentType, body) => {
          if (err) return reject(new Error(`get_image failed: ${err}`));
          resolve({ contentType, body });
        }
      );
    });
  }
}

module.exports = { RoonExtension };
