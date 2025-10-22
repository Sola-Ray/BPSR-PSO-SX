import { app, ipcMain } from 'electron';

ipcMain.on('close-client', (event) => {
    app.quit();
});
