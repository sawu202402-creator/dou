/**
 * hotReload.js - 每 3 秒后台轮询 /version.json
 * 发现新故事、新章节或修改分镜时，原地无刷新热更新书架与当前页，并用温柔语音提示小豌豆。
 */

export class HotReloadWatcher {
    constructor({ intervalMs = 3000, onInit, onUpdate, onStatusChange } = {}) {
        this.intervalMs = intervalMs;
        this.onInit = typeof onInit === 'function' ? onInit : () => {};
        this.onUpdate = typeof onUpdate === 'function' ? onUpdate : () => {};
        this.onStatusChange = typeof onStatusChange === 'function' ? onStatusChange : () => {};

        this.currentVersion = null;
        this._timer = null;
        this._inFlight = false;
        this._running = false;
        this._onVisibility = () => {
            if (document.visibilityState === 'visible' && this._running) {
                this.checkNow().catch(() => {});
            }
        };
    }

    start() {
        if (this._running) return;
        this._running = true;
        this.checkNow().catch(() => {});
        this._timer = setInterval(() => {
            this.checkNow().catch(() => {});
        }, this.intervalMs);
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this._onVisibility);
        }
    }

    stop() {
        this._running = false;
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._onVisibility);
        }
    }

    async checkNow() {
        if (this._inFlight) return null;
        this._inFlight = true;
        try {
            const res = await fetch(`/version.json?t=${Date.now()}`, {
                cache: 'no-store'
            });
            if (!res.ok) {
                this.onStatusChange({ connected: false, version: this.currentVersion });
                return null;
            }
            const data = await res.json();
            this.onStatusChange({ connected: true, version: data.version || '' });

            if (!data || !data.version) return null;

            if (this.currentVersion === null) {
                this.currentVersion = data.version;
                this.onInit(data);
            } else if (data.version !== this.currentVersion) {
                const previousVersion = this.currentVersion;
                this.currentVersion = data.version;
                await this.onUpdate(data, previousVersion);
            }
            return data;
        } catch (_) {
            this.onStatusChange({ connected: false, version: this.currentVersion });
            return null;
        } finally {
            this._inFlight = false;
        }
    }
}
