(function attachDashboardSync() {
  'use strict';

  const MAX_WAIT_MS = 12000;

  class DashboardSync {
    constructor(options) {
      this.legacyKey = options.legacyKey;
      this.pendingKey = `${options.legacyKey}_pending`;
      this.normalize = options.normalize;
      this.makeDemo = options.makeDemo;
      this.setState = options.setState;
      this.onStatus = options.onStatus;
      this.onLegacyData = options.onLegacyData;
      this.revision = null;
      this.pending = null;
      this.blocked = false;
      this.saving = false;
      this.loginPromise = null;
      this.storageUnavailable = false;
      this.outboxPersisted = true;
      this.onOnline = () => this.retry();
      window.addEventListener('online', this.onOnline);
      window.addEventListener('offline', () => {
        if (this.pending) {
          this.status(
            this.outboxPersisted ? 'offline' : 'error',
            this.outboxPersisted
              ? 'Offline — changes are saved on this device and are not synchronized.'
              : 'Offline — changes are not synchronized and browser storage is unavailable; keep this page open.',
          );
        }
        else this.status('offline', 'Offline — the shared dashboard cannot be reached.');
      });
    }

    status(kind, message) {
      this.onStatus(kind, message, Boolean(this.pending));
    }

    parseStoredState(raw) {
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return this.normalize(parsed && parsed.schemaVersion ? parsed.state : parsed);
    }

    readLegacy() {
      const raw = localStorage.getItem(this.legacyKey);
      return raw ? this.parseStoredState(raw) : null;
    }

    readPending() {
      const raw = localStorage.getItem(this.pendingKey);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (saved?.version !== 1 || !saved.state || !(
        saved.baseRevision === null
        || (Number.isSafeInteger(saved.baseRevision) && saved.baseRevision >= 0)
      )) {
        throw new Error('The unsynchronized dashboard backup is invalid. Export it before continuing.');
      }
      return { state: this.normalize(saved.state), baseRevision: saved.baseRevision };
    }

    async request(pathname, options = {}) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), MAX_WAIT_MS);
      let response;
      try {
        response = await fetch(pathname, {
          ...options,
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
          headers: {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers,
          },
        });
      } finally {
        clearTimeout(timeout);
      }
      if (response.status === 401) {
        await this.authenticate();
        return this.request(pathname, options);
      }
      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error(`The dashboard server returned an unreadable response (${response.status}).`);
      }
      if (!response.ok) {
        const error = new Error(body.error || `Dashboard request failed (${response.status}).`);
        error.status = response.status;
        error.body = body;
        throw error;
      }
      return body;
    }

    authenticate() {
      if (this.loginPromise) return this.loginPromise;
      const gate = document.querySelector('#loginGate');
      const form = document.querySelector('#loginForm');
      const input = document.querySelector('#loginPassword');
      const message = document.querySelector('#loginMessage');
      gate.hidden = false;
      message.textContent = '';
      this.loginPromise = new Promise((resolve, reject) => {
        form.onsubmit = async (event) => {
          event.preventDefault();
          const submit = form.querySelector('button[type="submit"]');
          submit.disabled = true;
          message.textContent = 'Signing in…';
          try {
            const response = await fetch('/api/session', {
              method: 'POST',
              credentials: 'same-origin',
              cache: 'no-store',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password: input.value }),
            });
            const body = await response.json();
            if (!response.ok) {
              message.textContent = body.error || 'Sign-in failed. Please try again.';
              input.focus();
              return;
            }
            gate.hidden = true;
            input.value = '';
            resolve();
          } catch (error) {
            message.textContent = `Could not sign in: ${error.message}`;
          } finally {
            submit.disabled = false;
          }
        };
      }).finally(() => {
        this.loginPromise = null;
      });
      input.focus();
      return this.loginPromise;
    }

    async fetchDashboard() {
      return this.request('/api/dashboard');
    }

    savePending() {
      try {
        localStorage.setItem(this.pendingKey, JSON.stringify({
          version: 1,
          baseRevision: this.pending.baseRevision,
          state: this.pending.state,
          savedAt: new Date().toISOString(),
        }));
        this.outboxPersisted = true;
        return true;
      } catch (error) {
        console.error('Could not persist the unsynchronized dashboard changes on this device.', error);
        this.outboxPersisted = false;
        return false;
      }
    }

    async load() {
      this.status('loading', 'Loading the shared dashboard…');
      let legacy;
      let storedPending;
      try {
        storedPending = this.readPending();
      } catch (error) {
        if (error.name === 'SecurityError') this.storageUnavailable = true;
        else {
          this.status('error', error.message);
          throw error;
        }
      }
      try {
        legacy = this.readLegacy();
      } catch (error) {
        if (error.name === 'SecurityError') this.storageUnavailable = true;
        else {
          this.status('error', error.message);
          throw error;
        }
      }
      if (this.storageUnavailable) this.outboxPersisted = false;

      try {
        const remote = await this.fetchDashboard();
        this.revision = remote.revision;
        const shared = remote.state === null ? null : this.normalize(remote.state);
        if (storedPending && shared && JSON.stringify(storedPending.state) === JSON.stringify(shared)) {
          try {
            localStorage.removeItem(this.pendingKey);
          } catch (error) {
            console.error('Could not clear the synchronized dashboard outbox.', error);
          }
          this.setState(shared);
          this.status('saved', 'All changes saved to the shared database.');
          return shared;
        }
        if (storedPending) {
          this.pending = storedPending;
          if (storedPending.baseRevision === remote.revision
            || (storedPending.baseRevision === null && remote.state === null)) {
            if (storedPending.baseRevision === null) {
              storedPending.baseRevision = 0;
              this.savePending();
            }
            this.setState(storedPending.state);
            this.status('saving', 'Resuming saved changes that have not synchronized yet…');
            void this.flush();
            return storedPending.state;
          }
          this.blocked = true;
          this.setState(storedPending.state);
          this.status('conflict', 'Unsynchronized changes are kept on this device. The shared dashboard changed elsewhere; download your changes or load the shared version.');
          return storedPending.state;
        }
        if (remote.state !== null) {
          if (legacy && JSON.stringify(legacy) !== JSON.stringify(shared)) {
            this.onLegacyData(legacy);
          }
          this.setState(shared);
          this.status(
            this.storageUnavailable ? 'error' : 'saved',
            this.storageUnavailable
              ? 'Shared dashboard loaded. Browser storage is unavailable, so offline edits cannot be retained.'
              : 'Shared dashboard loaded.',
          );
          return shared;
        }

        const initial = legacy || this.makeDemo();
        this.pending = { state: initial, baseRevision: 0 };
        this.setState(initial);
        this.savePending();
        this.status(
          this.outboxPersisted ? 'saving' : 'error',
          this.outboxPersisted
            ? 'Saving existing dashboard data to the shared database…'
            : 'Saving existing data to the shared database; offline protection is unavailable in this browser.',
        );
        void this.flush();
        return initial;
      } catch (error) {
        if (error.status === 409 && error.body) {
          this.revision = error.body.revision;
          this.pending = { state: this.normalize(error.body.state), baseRevision: null };
          this.blocked = true;
          this.setState(this.pending.state);
          this.savePending();
          this.status('conflict', 'The shared dashboard changed during migration. Your local data was kept here and was not overwritten.');
          return this.pending.state;
        }
        if (this.loginPromise) throw error;
        this.pending = storedPending || (legacy
          ? { state: legacy, baseRevision: null }
          : { state: this.makeDemo(), baseRevision: null });
        this.setState(this.pending.state);
        if (storedPending || legacy) this.savePending();
        this.status(
          this.outboxPersisted ? 'offline' : 'error',
          this.outboxPersisted
            ? `Could not load the shared dashboard: ${error.message}. Changes will remain on this device until synchronization is available.`
            : `Could not load the shared dashboard: ${error.message}. Browser storage is unavailable; do not close this page until the connection returns.`,
        );
        return this.pending.state;
      }
    }

    save(state) {
      if (!state) return;
      const snapshot = JSON.parse(JSON.stringify(state));
      if (!this.pending) {
        this.pending = { state: snapshot, baseRevision: this.revision };
      } else {
        this.pending.state = snapshot;
      }
      const persisted = this.savePending();
      if (this.blocked) {
        this.status('conflict', 'Changes are still unsynchronized because the shared dashboard changed elsewhere. Download them before loading the shared version.');
        return;
      }
      this.status(
        persisted ? 'saving' : 'error',
        persisted
          ? 'Saving changes to the shared database…'
          : 'Could not persist the pending changes on this device; synchronization will still be attempted.',
      );
      void this.flush();
    }

    async flush() {
      if (this.saving || this.blocked || !this.pending) return;
      this.saving = true;
      try {
        while (this.pending && !this.blocked) {
          if (this.pending.baseRevision === null) {
            const latest = await this.fetchDashboard();
            this.revision = latest.revision;
            if (latest.state !== null) {
              this.blocked = true;
              this.status('conflict', 'A shared dataset already exists. Your offline changes were kept on this device and were not uploaded.');
              return;
            }
            this.pending.baseRevision = 0;
            this.savePending();
          }
          const snapshot = this.pending.state;
          const expectedRevision = this.pending.baseRevision;
          const saved = await this.request('/api/dashboard', {
            method: 'PUT',
            body: JSON.stringify({ state: snapshot, revision: expectedRevision }),
          });
          this.revision = saved.revision;
          if (this.pending.state === snapshot) {
            try {
              localStorage.removeItem(this.pendingKey);
            } catch (error) {
              console.error('Could not clear the synchronized dashboard outbox.', error);
            }
            this.pending = null;
            this.status('saved', 'All changes saved to the shared database.');
          } else {
            this.pending.baseRevision = saved.revision;
            this.savePending();
          }
        }
      } catch (error) {
        if (error.status === 409 && error.body) {
          this.revision = error.body.revision;
          this.blocked = true;
          this.status('conflict', 'The shared dashboard changed in another browser. Your changes remain on this device and were not overwritten.');
        } else {
          this.status(
            this.outboxPersisted ? 'offline' : 'error',
            this.outboxPersisted
              ? `Changes have not synchronized: ${error.message}. They are saved on this device and will retry when online.`
              : `Changes have not synchronized: ${error.message}. Browser storage is unavailable, so keep this page open until synchronization succeeds.`,
          );
        }
      } finally {
        this.saving = false;
      }
    }

    async retry() {
      if (!this.pending) {
        try {
          const remote = await this.fetchDashboard();
          this.revision = remote.revision;
          if (remote.state !== null) {
            this.setState(this.normalize(remote.state));
            window.renderAll();
            this.status('saved', 'Shared dashboard reloaded.');
            return;
          }
          this.status('error', 'The shared database is empty. Existing data was not changed.');
        } catch (error) {
          this.status('offline', `Could not reload the shared dashboard: ${error.message}`);
        }
        return;
      }
      if (this.blocked) return;
      try {
        const latest = await this.fetchDashboard();
        if (this.pending.baseRevision === null) {
          if (latest.state !== null) {
            this.revision = latest.revision;
            this.blocked = true;
            this.status('conflict', 'A shared dataset already exists. Your pending changes were kept and were not uploaded.');
            return;
          }
          this.pending.baseRevision = 0;
          this.savePending();
        } else if (latest.revision !== this.pending.baseRevision) {
          this.revision = latest.revision;
          this.blocked = true;
          this.status('conflict', 'The shared dashboard changed elsewhere. Your pending changes were kept and were not uploaded.');
          return;
        }
        this.revision = latest.revision;
        this.status('saving', 'Retrying synchronization…');
        void this.flush();
      } catch (error) {
        this.status(
          this.outboxPersisted ? 'offline' : 'error',
          this.outboxPersisted
            ? `Could not synchronize changes: ${error.message}`
            : `Could not synchronize changes: ${error.message}. Browser storage is unavailable; keep this page open.`,
        );
      }
    }

    async loadSharedVersion() {
      if (!this.pending || !window.confirm('Discard the unsynchronized changes on this device and load the latest shared dashboard? Download the unsynchronized backup first if you may need it.')) {
        return;
      }
      try {
        const remote = await this.fetchDashboard();
        if (remote.state === null) {
          this.status('error', 'The shared database is empty. Your local changes were kept.');
          return;
        }
        this.pending = null;
        this.blocked = false;
        this.revision = remote.revision;
        try {
          localStorage.removeItem(this.pendingKey);
        } catch (error) {
          console.error('Could not clear the local dashboard outbox after loading the shared version.', error);
        }
        const shared = this.normalize(remote.state);
        this.setState(shared);
        this.status('saved', 'Latest shared dashboard loaded.');
        window.renderAll();
      } catch (error) {
        this.status('error', `Could not load the shared dashboard: ${error.message}`);
      }
    }

    downloadPending() {
      if (!this.pending) return;
      const payload = {
        schemaVersion: 2,
        backupTimestamp: new Date().toISOString(),
        state: this.pending.state,
      };
      this.download(payload, `vanessa-esl-unsynced-${new Date().toISOString().slice(0, 10)}.json`);
    }

    downloadLegacy(state) {
      const payload = {
        schemaVersion: 2,
        backupTimestamp: new Date().toISOString(),
        state,
      };
      this.download(payload, `vanessa-esl-legacy-${new Date().toISOString().slice(0, 10)}.json`);
    }

    download(payload, filename) {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  window.DashboardSync = DashboardSync;
}());
