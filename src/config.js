class Config {
    constructor() {
        this.VERSION = '1.0.0';
        this.IS_PAUSED = false;
        this.GLOBAL_SETTINGS = {
            autoClearOnServerChange: true,
            autoClearOnTimeout: false,
            onlyRecordEliteDummy: false,
        };
    }
}

export const config = new Config();
